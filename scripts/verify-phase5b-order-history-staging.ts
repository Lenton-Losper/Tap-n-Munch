/**
 * Phase 5B staging verification: Order History permission migration + export hardening.
 *   npx tsx scripts/verify-phase5b-order-history-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { rolePermissionConfigEntries } from '../lib/permissions/role-permissions-config'
import { PERMISSIONS } from '../lib/permissions'
import { authorize } from '../lib/permissions/authorize'

config({ path: '.env.test', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const tag = `phase5b-${Date.now()}`
const pw = `Set${randomUUID().slice(0, 8)}!1`

const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.SUPABASE_ANON_KEY!

if (!url?.includes(STAGING_REF)) throw new Error('Refusing: not staging Supabase')

const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anon = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let restAId: string | null = null
let restBId: string | null = null
let ownerAId: string | null = null
let managerAId: string | null = null
let waiterAId: string | null = null
let kitchenAId: string | null = null
let stockOnlyId: string | null = null
let ownerBId: string | null = null
let stockOnlyStaffId: string | null = null

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const managerAEmail = `${tag}.manager-a@flashtap-test.invalid`
const waiterAEmail = `${tag}.waiter-a@flashtap-test.invalid`
const kitchenAEmail = `${tag}.kitchen-a@flashtap-test.invalid`
const stockOnlyEmail = `${tag}.stock-only@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`

async function signIn(email: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
}

async function seedRestaurantRoles(restaurantId: string) {
  const rows = rolePermissionConfigEntries().map(([slug, perms]) => ({
    restaurant_id: restaurantId,
    role_slug: slug,
    display_name: slug,
    permissions: [...perms],
    is_system: slug === 'owner',
    is_invite_eligible: slug === 'manager' || slug === 'waiter',
  }))
  const { error } = await dbAdmin.from('restaurant_roles').insert(rows)
  if (error) throw error
}

async function setup() {
  for (const [slug, label] of [
    [`${tag}-a`, 'a'],
    [`${tag}-b`, 'b'],
  ] as const) {
    const { data: rest, error } = await dbAdmin
      .from('restaurants')
      .insert({ name: `${slug} Restaurant`, slug })
      .select('id')
      .single()
    if (error || !rest?.id) throw error
    if (label === 'a') restAId = rest.id
    else restBId = rest.id
    await seedRestaurantRoles(rest.id)
  }

  const accounts = [
    [ownerAEmail, 'owner', 'ownerA'],
    [managerAEmail, 'manager', 'managerA'],
    [waiterAEmail, 'waiter', 'waiterA'],
    [kitchenAEmail, 'kitchen', 'kitchenA'],
    [stockOnlyEmail, 'waiter', 'stockOnly'],
    [ownerBEmail, 'owner', 'ownerB'],
  ] as const

  for (const [email, role, label] of accounts) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error

    const restId = label === 'ownerB' ? restBId! : restAId!
    if (label === 'ownerA') ownerAId = u.user.id
    if (label === 'managerA') managerAId = u.user.id
    if (label === 'waiterA') waiterAId = u.user.id
    if (label === 'kitchenA') kitchenAId = u.user.id
    if (label === 'stockOnly') stockOnlyId = u.user.id
    if (label === 'ownerB') ownerBId = u.user.id

    await dbAdmin.from('users').insert({
      id: u.user.id,
      email,
      role,
      restaurant_id: restId,
      full_name: label,
    })
    await dbAdmin.from('restaurant_users').insert({
      restaurant_id: restId,
      user_id: u.user.id,
      role,
      invite_accepted: true,
    })
  }

  const { data: staffRow, error: staffErr } = await dbAdmin
    .from('staff_members')
    .insert({
      restaurant_id: restAId!,
      email: stockOnlyEmail,
      role: 'waiter',
      active: true,
    })
    .select('id')
    .single()
  if (staffErr || !staffRow?.id) throw staffErr
  stockOnlyStaffId = String(staffRow.id)

  await dbAdmin.from('staff_permissions').insert({
    staff_id: stockOnlyStaffId,
    restaurant_id: restAId!,
    permission: PERMISSIONS.ORDERS_READ,
    effect: 'deny',
  })
}

async function cleanup() {
  if (stockOnlyStaffId) {
    await dbAdmin.from('staff_permissions').delete().eq('staff_id', stockOnlyStaffId)
    await dbAdmin.from('staff_members').delete().eq('id', stockOnlyStaffId)
  }
  for (const rid of [restAId, restBId]) {
    if (rid) {
      await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurants').delete().eq('id', rid)
    }
  }
  for (const uid of [ownerAId, managerAId, waiterAId, kitchenAId, stockOnlyId, ownerBId]) {
    if (uid) {
      await dbAdmin.from('users').delete().eq('id', uid)
      await authAdmin.auth.admin.deleteUser(uid)
    }
  }
}

async function main() {
  const report: Record<string, unknown> = {
    app: APP,
    tag,
    accessExpansionNote:
      'Waiter and kitchen already have orders:read in seed; Order History gate now matches that grant (same class as Settings/manager expansion).',
  }
  await setup()

  const ownerTok = await signIn(ownerAEmail)
  const managerTok = await signIn(managerAEmail)
  const waiterTok = await signIn(waiterAEmail)
  const kitchenTok = await signIn(kitchenAEmail)
  const stockOnlyTok = await signIn(stockOnlyEmail)

  const today = new Date().toISOString().split('T')[0]

  report.authorize = {
    owner: await authorize(ownerAId!, restAId!, PERMISSIONS.ORDERS_READ),
    manager: await authorize(managerAId!, restAId!, PERMISSIONS.ORDERS_READ),
    waiter: await authorize(waiterAId!, restAId!, PERMISSIONS.ORDERS_READ),
    kitchen: await authorize(kitchenAId!, restAId!, PERMISSIONS.ORDERS_READ),
    stockOnlyDeny: await authorize(stockOnlyId!, restAId!, PERMISSIONS.ORDERS_READ),
  }

  const historyOwner = await fetch(
    `${APP}/api/orders/history?restaurantId=${restAId}&startDate=${today}&endDate=${today}`,
    { headers: { Authorization: `Bearer ${ownerTok}` } },
  )
  const historyWaiter = await fetch(
    `${APP}/api/orders/history?restaurantId=${restAId}&startDate=${today}&endDate=${today}`,
    { headers: { Authorization: `Bearer ${waiterTok}` } },
  )
  const historyKitchen = await fetch(
    `${APP}/api/orders/history?restaurantId=${restAId}&startDate=${today}&endDate=${today}`,
    { headers: { Authorization: `Bearer ${kitchenTok}` } },
  )
  const historyDenied = await fetch(
    `${APP}/api/orders/history?restaurantId=${restAId}&startDate=${today}&endDate=${today}`,
    { headers: { Authorization: `Bearer ${stockOnlyTok}` } },
  )

  report.historyApi = {
    owner: historyOwner.status,
    waiter: historyWaiter.status,
    kitchen: historyKitchen.status,
    stockOnlyDeny: historyDenied.status,
  }

  const exportOwner = await fetch(`${APP}/api/orders/history/export`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ format: 'csv', startDate: today, endDate: today }),
  })
  const exportWaiter = await fetch(`${APP}/api/orders/history/export`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${waiterTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ format: 'csv', startDate: today, endDate: today }),
  })
  const exportDenied = await fetch(`${APP}/api/orders/history/export`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${stockOnlyTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ format: 'csv', startDate: today, endDate: today }),
  })

  report.exportApi = {
    owner: { status: exportOwner.status, contentType: exportOwner.headers.get('content-type') },
    waiter: exportWaiter.status,
    stockOnlyDeny: exportDenied.status,
  }

  const crossHistory = await fetch(
    `${APP}/api/orders/history?restaurantId=${restBId}&startDate=${today}&endDate=${today}`,
    { headers: { Authorization: `Bearer ${ownerTok}` } },
  )
  report.crossTenantHistory = {
    status: crossHistory.status,
    body: await crossHistory.json().catch(() => ({})),
  }

  const crossEmail = await fetch(`${APP}/api/admin/restaurants/${restBId}/reports/email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'probe@flashtap-test.invalid',
      format: 'csv',
      startDate: today,
      endDate: today,
    }),
  })
  report.crossTenantEmail = {
    status: crossEmail.status,
    body: await crossEmail.json().catch(() => ({})),
  }

  const legitEmail = await fetch(`${APP}/api/admin/restaurants/${restAId}/reports/email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${managerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: `${tag}.recipient@flashtap-test.invalid`,
      format: 'csv',
      startDate: today,
      endDate: today,
    }),
  })
  report.legitEmailManager = { status: legitEmail.status }

  const roleApiWaiter = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${waiterTok}` },
  }).then((r) => r.json())

  report.waiterPermissions = roleApiWaiter.permissions

  console.log(JSON.stringify(report, null, 2))

  const authz = report.authorize as Record<string, boolean>
  const history = report.historyApi as Record<string, number>
  const exp = report.exportApi as Record<string, unknown>

  const pass =
    authz.owner === true &&
    authz.manager === true &&
    authz.waiter === true &&
    authz.kitchen === true &&
    authz.stockOnlyDeny === false &&
    history.owner === 200 &&
    history.waiter === 200 &&
    history.kitchen === 200 &&
    history.stockOnlyDeny === 403 &&
    (exp.owner as { status: number }).status === 200 &&
    exp.waiter === 200 &&
    exp.stockOnlyDeny === 403 &&
    (report.crossTenantHistory as { status: number }).status === 403 &&
    (report.crossTenantEmail as { status: number }).status === 403 &&
    (report.legitEmailManager as { status: number }).status === 200 &&
    (report.waiterPermissions as string[]).includes(PERMISSIONS.ORDERS_READ)

  if (!pass) {
    console.error('PHASE5B_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE5B_STAGING_OK')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await cleanup()
      console.log('Cleanup complete.')
    } catch (e) {
      console.error('Cleanup error:', e)
    }
  })
