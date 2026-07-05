/**
 * Phase 5B production verification: Order History migration.
 *   npx tsx scripts/verify-phase5b-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'
import { authorize } from '../lib/permissions/authorize'

config({ path: '.env.production.local', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const APP = process.env.PRODUCTION_APP_URL || 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const tag = `phase5b-prod-${Date.now()}`
const pw = `Verify${randomUUID().slice(0, 8)}!1`

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

if (!url?.includes(PROD_REF)) throw new Error(`Refusing: not production Supabase (${url})`)

const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anon = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

let restBId: string | null = null
let ownerBId: string | null = null
let waiterId: string | null = null
let kitchenId: string | null = null
let cashierId: string | null = null
let barId: string | null = null
let deniedId: string | null = null
let deniedStaffId: string | null = null

const waiterEmail = `${tag}.waiter@flashtap-test.invalid`
const kitchenEmail = `${tag}.kitchen@flashtap-test.invalid`
const cashierEmail = `${tag}.cashier@flashtap-test.invalid`
const barEmail = `${tag}.bar@flashtap-test.invalid`
const deniedEmail = `${tag}.denied@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`

async function resolveRivieraOwnerEmail(): Promise<string> {
  const { data: ownerRow, error } = await dbAdmin
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', RIVIERA_ID)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!ownerRow?.user_id) throw new Error('No Riviera owner')

  const { data: userRow, error: userError } = await dbAdmin
    .from('users')
    .select('email')
    .eq('id', ownerRow.user_id)
    .maybeSingle()
  if (userError) throw userError
  const email = String(userRow?.email || '').trim()
  if (!email) throw new Error('Riviera owner has no email')
  return email
}

async function signInWithPassword(email: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
}

async function signInWithMagicLink(email: string) {
  const { data: link, error: linkErr } = await authAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkErr || !link?.properties?.hashed_token) {
    throw new Error(`Magic link failed: ${linkErr?.message}`)
  }
  const { data: sess, error: otpErr } = await authAdmin.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpErr || !sess.session?.access_token) {
    throw new Error(`OTP failed: ${otpErr?.message}`)
  }
  return sess.session.access_token
}

async function fetchOrderHistoryPage(token: string) {
  const res = await fetch(`${APP}/dashboard/order-history`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  })
  const body = await res.text()
  const denied =
    body.includes('NEXT_REDIRECT') &&
    (body.includes('/dashboard') || body.includes('/signin'))
  return { status: res.status, denied, location: res.headers.get('location') }
}

async function setupDisposableUsers() {
  const { data: restB, error: restErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} B`, slug: `${tag}-b` })
    .select('id')
    .single()
  if (restErr || !restB?.id) throw restErr
  restBId = restB.id

  const accounts = [
    [waiterEmail, 'waiter', 'waiter'],
    [kitchenEmail, 'kitchen', 'kitchen'],
    [cashierEmail, 'cashier', 'cashier'],
    [barEmail, 'bar', 'bar'],
    [deniedEmail, 'waiter', 'denied'],
    [ownerBEmail, 'owner', 'ownerB'],
  ] as const

  for (const [email, role, label] of accounts) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error

    const restId = label === 'ownerB' ? restBId! : RIVIERA_ID
    if (label === 'waiter') waiterId = u.user.id
    if (label === 'kitchen') kitchenId = u.user.id
    if (label === 'cashier') cashierId = u.user.id
    if (label === 'bar') barId = u.user.id
    if (label === 'denied') deniedId = u.user.id
    if (label === 'ownerB') ownerBId = u.user.id

    await dbAdmin.from('users').insert({
      id: u.user.id,
      email,
      role,
      restaurant_id: restId,
      full_name: `Phase5B ${label}`,
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
      restaurant_id: RIVIERA_ID,
      email: deniedEmail,
      role: 'waiter',
      active: true,
    })
    .select('id')
    .single()
  if (staffErr || !staffRow?.id) throw staffErr
  deniedStaffId = String(staffRow.id)

  await dbAdmin.from('staff_permissions').insert({
    staff_id: deniedStaffId,
    restaurant_id: RIVIERA_ID,
    permission: PERMISSIONS.ORDERS_READ,
    effect: 'deny',
  })
}

async function cleanup() {
  if (deniedStaffId) {
    await dbAdmin.from('staff_permissions').delete().eq('staff_id', deniedStaffId)
    await dbAdmin.from('staff_members').delete().eq('id', deniedStaffId)
  }
  for (const uid of [waiterId, kitchenId, cashierId, barId, deniedId]) {
    if (!uid) continue
    await dbAdmin.from('restaurant_users').delete().eq('user_id', uid).eq('restaurant_id', RIVIERA_ID)
    await dbAdmin.from('users').delete().eq('id', uid)
    await authAdmin.auth.admin.deleteUser(uid)
  }
  if (ownerBId && restBId) {
    await dbAdmin.from('restaurant_users').delete().eq('user_id', ownerBId)
    await dbAdmin.from('users').delete().eq('id', ownerBId)
    await authAdmin.auth.admin.deleteUser(ownerBId)
    await dbAdmin.from('restaurants').delete().eq('id', restBId)
  }
}

async function main() {
  const expectedCommitPrefix = process.env.PHASE5B_EXPECTED_COMMIT || ''
  const versionRes = await fetch(`${APP}/api/version`)
  const versionBody = await versionRes.json().catch(() => ({}))
  const deployedCommit = String(
    (versionBody as { commit?: string }).commit ?? '',
  )

  const report: Record<string, unknown> = {
    app: APP,
    tag,
    expectedCommitPrefix: expectedCommitPrefix || '(set after merge)',
    version: { status: versionRes.status, commit: deployedCommit, body: versionBody },
    accessExpansionNote:
      'Waiter, kitchen, cashier, and bar all have orders:read in seed — Order History gate now matches those grants.',
  }

  if (expectedCommitPrefix && !deployedCommit.startsWith(expectedCommitPrefix)) {
    console.log(JSON.stringify(report, null, 2))
    console.error(
      `PHASE5B_PRODUCTION_FAIL: /api/version commit ${deployedCommit || '(missing)'} != ${expectedCommitPrefix}`,
    )
    process.exitCode = 1
    return
  }

  await setupDisposableUsers()

  const ownerEmail = await resolveRivieraOwnerEmail()
  const ownerTok = await signInWithMagicLink(ownerEmail)
  const waiterTok = await signInWithPassword(waiterEmail)
  const kitchenTok = await signInWithPassword(kitchenEmail)
  const cashierTok = await signInWithPassword(cashierEmail)
  const barTok = await signInWithPassword(barEmail)
  const deniedTok = await signInWithPassword(deniedEmail)

  const today = new Date().toISOString().split('T')[0]

  report.ownerReal = {
    email: ownerEmail,
    orderHistoryPage: await fetchOrderHistoryPage(ownerTok),
  }

  const ownerHistory = await fetch(
    `${APP}/api/orders/history?restaurantId=${RIVIERA_ID}&startDate=${today}&endDate=${today}`,
    { headers: { Authorization: `Bearer ${ownerTok}` } },
  )
  const ownerExport = await fetch(`${APP}/api/orders/history/export`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ format: 'csv', startDate: today, endDate: today }),
  })
  const ownerEmailRes = await fetch(`${APP}/api/admin/restaurants/${RIVIERA_ID}/reports/email`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: `${tag}.owner-recipient@flashtap-test.invalid`,
      format: 'csv',
      startDate: today,
      endDate: today,
    }),
  })

  report.ownerReal = {
    ...(report.ownerReal as object),
    history: ownerHistory.status,
    export: { status: ownerExport.status, contentType: ownerExport.headers.get('content-type') },
    email: ownerEmailRes.status,
  }

  async function roleChecks(label: string, token: string, userId: string) {
    return {
      authorize: await authorize(userId, RIVIERA_ID, PERMISSIONS.ORDERS_READ),
      page: await fetchOrderHistoryPage(token),
      history: (
        await fetch(
          `${APP}/api/orders/history?restaurantId=${RIVIERA_ID}&startDate=${today}&endDate=${today}`,
          { headers: { Authorization: `Bearer ${token}` } },
        )
      ).status,
      export: (
        await fetch(`${APP}/api/orders/history/export`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ format: 'csv', startDate: today, endDate: today }),
        })
      ).status,
    }
  }

  report.expansionRoles = {
    waiter: await roleChecks('waiter', waiterTok, waiterId!),
    kitchen: await roleChecks('kitchen', kitchenTok, kitchenId!),
    cashier: await roleChecks('cashier', cashierTok, cashierId!),
    bar: await roleChecks('bar', barTok, barId!),
  }

  report.deniedOverride = {
    authorize: await authorize(deniedId!, RIVIERA_ID, PERMISSIONS.ORDERS_READ),
    page: await fetchOrderHistoryPage(deniedTok),
    history: (
      await fetch(
        `${APP}/api/orders/history?restaurantId=${RIVIERA_ID}&startDate=${today}&endDate=${today}`,
        { headers: { Authorization: `Bearer ${deniedTok}` } },
      )
    ).status,
    export: (
      await fetch(`${APP}/api/orders/history/export`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deniedTok}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ format: 'csv', startDate: today, endDate: today }),
      })
    ).status,
    email: (
      await fetch(`${APP}/api/admin/restaurants/${RIVIERA_ID}/reports/email`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deniedTok}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'denied@flashtap-test.invalid',
          format: 'csv',
          startDate: today,
          endDate: today,
        }),
      })
    ).status,
  }

  const crossHistory = await fetch(
    `${APP}/api/orders/history?restaurantId=${restBId}&startDate=${today}&endDate=${today}`,
    { headers: { Authorization: `Bearer ${ownerTok}` } },
  )
  const crossExport = await fetch(`${APP}/api/orders/history/export`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ format: 'csv', startDate: today, endDate: today }),
  })
  report.crossTenantNote =
    'Export uses caller restaurant only — cross-tenant via export is not possible by URL; history GET and email are the URL-manipulation vectors.'
  report.crossTenant = {
    history: {
      status: crossHistory.status,
      body: await crossHistory.json().catch(() => ({})),
    },
    exportUsesCallerRestaurant: crossExport.status,
    email: {
      status: (
        await fetch(`${APP}/api/admin/restaurants/${restBId}/reports/email`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ownerTok}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: 'cross@flashtap-test.invalid',
            format: 'csv',
            startDate: today,
            endDate: today,
          }),
        })
      ).status,
    },
  }

  console.log(JSON.stringify(report, null, 2))

  const roleOk = (r: { authorize: boolean; history: number; export: number }) =>
    r.authorize && r.history === 200 && r.export === 200

  const expansion = report.expansionRoles as Record<string, { authorize: boolean; history: number; export: number }>
  const denied = report.deniedOverride as {
    authorize: boolean
    history: number
    export: number
    email: number
  }
  const owner = report.ownerReal as { history: number; export: { status: number }; email: number }
  const cross = report.crossTenant as { history: { status: number }; email: { status: number } }

  const pass =
    owner.history === 200 &&
    owner.export.status === 200 &&
    owner.email === 200 &&
    roleOk(expansion.waiter) &&
    roleOk(expansion.kitchen) &&
    roleOk(expansion.cashier) &&
    roleOk(expansion.bar) &&
    denied.authorize === false &&
    denied.history === 403 &&
    denied.export === 403 &&
    denied.email === 403 &&
    cross.history.status === 403 &&
    cross.email.status === 403 &&
    crossExport.status === 200

  if (!pass) {
    console.error('PHASE5B_PRODUCTION_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE5B_PRODUCTION_OK')
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
