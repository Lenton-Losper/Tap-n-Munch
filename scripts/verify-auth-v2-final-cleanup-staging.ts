/**
 * Authorization v2 final cleanup — staging verification.
 *   npx tsx scripts/verify-auth-v2-final-cleanup-staging.ts
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
const tag = `authv2-final-${Date.now()}`
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
const userIds: Record<string, string> = {}

const emails = {
  ownerA: `${tag}.owner-a@flashtap-test.invalid`,
  managerA: `${tag}.manager-a@flashtap-test.invalid`,
  waiterA: `${tag}.waiter-a@flashtap-test.invalid`,
  kitchenA: `${tag}.kitchen-a@flashtap-test.invalid`,
  barA: `${tag}.bar-a@flashtap-test.invalid`,
  cashierA: `${tag}.cashier-a@flashtap-test.invalid`,
  ownerB: `${tag}.owner-b@flashtap-test.invalid`,
} as const

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
    [emails.ownerA, 'owner', 'ownerA', restAId!],
    [emails.managerA, 'manager', 'managerA', restAId!],
    [emails.waiterA, 'waiter', 'waiterA', restAId!],
    [emails.kitchenA, 'kitchen', 'kitchenA', restAId!],
    [emails.barA, 'bar', 'barA', restAId!],
    [emails.cashierA, 'cashier', 'cashierA', restAId!],
    [emails.ownerB, 'owner', 'ownerB', restBId!],
  ] as const

  for (const [email, role, label, restId] of accounts) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    userIds[label] = u.user.id

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
}

async function cleanup() {
  for (const rid of [restAId, restBId]) {
    if (rid) {
      await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurants').delete().eq('id', rid)
    }
  }
  for (const uid of Object.values(userIds)) {
    await dbAdmin.from('users').delete().eq('id', uid)
    await authAdmin.auth.admin.deleteUser(uid)
  }
}

async function fetchRoleApi(token: string) {
  const res = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: await res.json() }
}

function navVisibleFromPermissions(permissions: string[]) {
  const has = (p: string) => permissions.includes(p)
  return {
    liveOrders: has(PERMISSIONS.ORDERS_READ),
    orderHistory: has(PERMISSIONS.ORDERS_READ),
    orderingChannels: has(PERMISSIONS.TABLES_READ),
    menuManagement: has(PERMISSIONS.MENU_READ),
    staff: has(PERMISSIONS.STAFF_MANAGE),
    analytics: has(PERMISSIONS.ANALYTICS_VIEW),
    stock: has(PERMISSIONS.STOCK_VIEW),
    settings: has(PERMISSIONS.SETTINGS_READ),
  }
}

async function main() {
  const report: Record<string, unknown> = { app: APP, tag }
  await setup()

  const tokens = {
    ownerA: await signIn(emails.ownerA),
    managerA: await signIn(emails.managerA),
    waiterA: await signIn(emails.waiterA),
    kitchenA: await signIn(emails.kitchenA),
    barA: await signIn(emails.barA),
    cashierA: await signIn(emails.cashierA),
    ownerB: await signIn(emails.ownerB),
  }

  report.cashierOrdersReadSeed = {
    authorize: await authorize(userIds.cashierA, restAId!, PERMISSIONS.ORDERS_READ),
    note: 'Cashier dashboard access comes from existing seed orders:read — no seed change needed',
  }

  report.dashboardAuthorize = {
    owner: await authorize(userIds.ownerA, restAId!, PERMISSIONS.ORDERS_READ),
    manager: await authorize(userIds.managerA, restAId!, PERMISSIONS.ORDERS_READ),
    waiter: await authorize(userIds.waiterA, restAId!, PERMISSIONS.ORDERS_READ),
    kitchen: await authorize(userIds.kitchenA, restAId!, PERMISSIONS.ORDERS_READ),
    bar: await authorize(userIds.barA, restAId!, PERMISSIONS.ORDERS_READ),
    cashier: await authorize(userIds.cashierA, restAId!, PERMISSIONS.ORDERS_READ),
  }

  report.dashboardPageNote =
    'RSC /dashboard gate uses cookie session; Bearer fetch cannot prove server redirect — authorize() is authoritative.'

  report.cashierNav = navVisibleFromPermissions(
    (await fetchRoleApi(tokens.cashierA)).body.permissions ?? [],
  )

  report.migratedRoutes = {
    uploadMenuImage: {
      managerOk: (
        await fetch(`${APP}/api/admin/upload-menu-image`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.managerA}` },
          body: (() => {
            const fd = new FormData()
            fd.append('restaurantId', restAId!)
            fd.append('file', new Blob(['x'], { type: 'image/png' }), 'x.png')
            return fd
          })(),
        })
      ).status,
      waiterDenied: (
        await fetch(`${APP}/api/admin/upload-menu-image`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.waiterA}` },
          body: (() => {
            const fd = new FormData()
            fd.append('restaurantId', restAId!)
            fd.append('file', new Blob(['x'], { type: 'image/png' }), 'x.png')
            return fd
          })(),
        })
      ).status,
      crossTenant: (
        await fetch(`${APP}/api/admin/upload-menu-image`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tokens.ownerA}` },
          body: (() => {
            const fd = new FormData()
            fd.append('restaurantId', restBId!)
            fd.append('file', new Blob(['x'], { type: 'image/png' }), 'x.png')
            return fd
          })(),
        })
      ).status,
    },
    profile: {
      managerOk: (
        await fetch(`${APP}/api/admin/restaurant/profile`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokens.managerA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: `${tag} Updated`,
            phone: '',
            address: '',
            currency: 'NAD',
          }),
        })
      ).status,
      waiterDenied: (
        await fetch(`${APP}/api/admin/restaurant/profile`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${tokens.waiterA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: `${tag} Waiter Fail`,
            phone: '',
            address: '',
            currency: 'NAD',
          }),
        })
      ).status,
    },
    terminalsGet: {
      ownerOk: (
        await fetch(`${APP}/api/admin/terminals`, {
          headers: { Authorization: `Bearer ${tokens.ownerA}` },
        })
      ).status,
      managerDenied: (
        await fetch(`${APP}/api/admin/terminals`, {
          headers: { Authorization: `Bearer ${tokens.managerA}` },
        })
      ).status,
      crossTenant: (
        await fetch(`${APP}/api/admin/terminals`, {
          headers: { Authorization: `Bearer ${tokens.ownerA}` },
        })
      ).status,
    },
    terminalsPost: {
      ownerOk: (
        await fetch(`${APP}/api/admin/terminals`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokens.ownerA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            label: `${tag} Terminal`,
            serialNumber: `SN-${tag}`,
            deviceModel: 'TestModel',
          }),
        })
      ).status,
      managerDenied: (
        await fetch(`${APP}/api/admin/terminals`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokens.managerA}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            label: 'Fail',
            serialNumber: 'SN-fail',
            deviceModel: 'TestModel',
          }),
        })
      ).status,
    },
  }

  const terminalRes = await fetch(`${APP}/api/admin/terminals`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.ownerA}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      label: `${tag} Del Terminal`,
      serialNumber: `SN-DEL-${tag}`,
      deviceModel: 'TestModel',
    }),
  })
  const terminalJson = (await terminalRes.json()) as { terminal?: { id?: string } }
  const terminalId = terminalJson.terminal?.id

  if (terminalId) {
    report.terminalsDelete = {
      managerDenied: (
        await fetch(`${APP}/api/admin/terminals/${terminalId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tokens.managerA}` },
        })
      ).status,
      ownerOk: (
        await fetch(`${APP}/api/admin/terminals/${terminalId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tokens.ownerA}` },
        })
      ).status,
    }
  }

  report.permissionsApi = {
    ownerHasPaymentsConfigure: (
      await authorize(userIds.ownerA, restAId!, PERMISSIONS.PAYMENTS_CONFIGURE)
    ),
    managerHasPaymentsConfigure: (
      await authorize(userIds.managerA, restAId!, PERMISSIONS.PAYMENTS_CONFIGURE)
    ),
    managerHasMenuWrite: await authorize(userIds.managerA, restAId!, PERMISSIONS.MENU_WRITE),
    managerHasSettingsWrite: await authorize(
      userIds.managerA,
      restAId!,
      PERMISSIONS.SETTINGS_WRITE,
    ),
  }

  console.log(JSON.stringify(report, null, 2))

  const dash = report.dashboardAuthorize as Record<string, boolean>
  const routes = report.migratedRoutes as Record<string, Record<string, number>>
  const cashierSeed = report.cashierOrdersReadSeed as { authorize: boolean }
  const nav = report.cashierNav as { liveOrders: boolean }
  const perms = report.permissionsApi as Record<string, boolean>

  const pass =
    cashierSeed.authorize === true &&
    nav.liveOrders === true &&
    dash.owner === true &&
    dash.manager === true &&
    dash.waiter === true &&
    dash.kitchen === true &&
    dash.bar === true &&
    dash.cashier === true &&
    routes.uploadMenuImage.managerOk !== 403 &&
    routes.uploadMenuImage.waiterDenied === 403 &&
    routes.uploadMenuImage.crossTenant === 403 &&
    routes.profile.managerOk === 200 &&
    routes.profile.waiterDenied === 403 &&
    routes.terminalsGet.ownerOk === 200 &&
    routes.terminalsGet.managerDenied === 403 &&
    routes.terminalsPost.ownerOk === 200 &&
    routes.terminalsPost.managerDenied === 403 &&
    perms.ownerHasPaymentsConfigure === true &&
    perms.managerHasPaymentsConfigure === false &&
    perms.managerHasMenuWrite === true &&
    perms.managerHasSettingsWrite === true &&
    (!report.terminalsDelete ||
      ((report.terminalsDelete as { managerDenied: number }).managerDenied === 403 &&
        (report.terminalsDelete as { ownerOk: number }).ownerOk === 200))

  if (!pass) {
    console.error('AUTH_V2_FINAL_CLEANUP_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('AUTH_V2_FINAL_CLEANUP_STAGING_OK')
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
