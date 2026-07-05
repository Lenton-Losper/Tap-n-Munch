/**
 * Phase 5A staging verification: dashboard station scoping permissions + filter logic.
 *   npx tsx scripts/verify-phase5a-station-filter-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'
import {
  getRolePermissionsFromConfig,
  rolePermissionConfigEntries,
} from '../lib/permissions/role-permissions-config'
import { authorize } from '../lib/permissions/authorize'
import { filterOrdersByStationScope } from '../lib/order-routing'
import {
  STAGING_TEST_EMAIL,
  STAGING_TEST_RESTAURANT_ID,
  STAGING_TEST_USER_ID,
} from '../__tests__/helpers/staging-auth-fixtures'

const STAGING_TEST_PASSWORD = '!Flash01'

config({ path: '.env.test', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const tag = `phase5a-${Date.now()}`
const pw = `Set${randomUUID().slice(0, 8)}!1`
const CUSTOM_ROLE_NAME = `Head Chef ${tag.slice(-6)}`

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

const SYSTEM_SLUGS = ['owner', 'manager', 'cashier', 'waiter', 'kitchen', 'bar'] as const
const STATION_PERMS = new Set<string>([
  PERMISSIONS.ORDERS_STATION_KITCHEN,
  PERMISSIONS.ORDERS_STATION_BAR,
])

const DISPLAY_NAMES: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  cashier: 'Cashier',
  waiter: 'Waiter',
  kitchen: 'Kitchen',
  bar: 'Bar',
}

const sampleOrders = [
  { id: 'kitchen-only', items: [{ route_to: 'kitchen' }] },
  { id: 'bar-only', items: [{ route_to: 'bar' }] },
  { id: 'both-stations', items: [{ route_to: 'both' }] },
]

let restId: string | null = null
let ownerId: string | null = null
let barUserId: string | null = null
let customRoleSlug: string | null = null

const ownerEmail = `${tag}.owner@flashtap-test.invalid`
const barEmail = `${tag}.bar@flashtap-test.invalid`

function sorted(perms: string[]) {
  return [...perms].sort()
}

function expectedPermissionsForSlug(slug: string): string[] {
  const configPerms = getRolePermissionsFromConfig(slug)
  if (!configPerms) throw new Error(`Missing config for ${slug}`)
  return sorted([...configPerms])
}

async function signIn(email: string, password = pw) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
}

async function fetchRoleApi(token: string) {
  const res = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  return { status: res.status, body }
}

async function seedRestaurantRoles(restaurantId: string) {
  const rows = rolePermissionConfigEntries().map(([slug, perms]) => ({
    restaurant_id: restaurantId,
    role_slug: slug,
    display_name: DISPLAY_NAMES[slug] ?? slug,
    permissions: [...perms],
    is_system: slug === 'owner',
    is_invite_eligible: slug === 'manager' || slug === 'waiter',
  }))
  const { error } = await dbAdmin.from('restaurant_roles').insert(rows)
  if (error) throw error
}

async function setupDisposableRestaurant() {
  const { data: rest, error: restErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} Restaurant`, slug: `${tag}` })
    .select('id')
    .single()
  if (restErr || !rest?.id) throw restErr ?? new Error('restaurant insert failed')
  restId = rest.id
  await seedRestaurantRoles(rest.id)

  for (const [email, label] of [
    [ownerEmail, 'owner'],
    [barEmail, 'bar'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    if (label === 'owner') ownerId = u.user.id
    if (label === 'bar') barUserId = u.user.id
  }

  await dbAdmin.from('users').insert([
    { id: ownerId, email: ownerEmail, role: 'owner', restaurant_id: restId, full_name: 'Owner' },
    { id: barUserId, email: barEmail, role: 'bar', restaurant_id: restId, full_name: 'Bar' },
  ])

  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: restId, user_id: ownerId, role: 'owner', invite_accepted: true },
    { restaurant_id: restId, user_id: barUserId, role: 'bar', invite_accepted: true },
  ])
}

async function cleanup() {
  if (customRoleSlug && restId) {
    await dbAdmin
      .from('restaurant_roles')
      .delete()
      .eq('restaurant_id', restId)
      .eq('role_slug', customRoleSlug)
  }
  if (restId) {
    await dbAdmin.from('staff_invites').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurant_roles').delete().eq('restaurant_id', restId)
    await dbAdmin.from('restaurants').delete().eq('id', restId)
  }
  for (const uid of [ownerId, barUserId]) {
    if (uid) {
      await dbAdmin.from('users').delete().eq('id', uid)
      await authAdmin.auth.admin.deleteUser(uid)
    }
  }
}

interface SeedFidelityResult {
  restaurantRoleRows: number
  uniqueSlugs: string[]
  mismatches: string[]
  ok: boolean
}

interface StationAccountResult {
  email: string
  permissions: string[]
  hasOrdersRead?: boolean
  hasOrdersReadNow?: boolean
  hadOrdersReadBeforeMigration?: boolean
  hasKitchenStation: boolean
  hasBarStation: boolean
  filteredIds: string[]
}

interface Phase5aReport {
  app: string
  tag: string
  barBehaviorClarification: {
    beforeFix: string
    afterFix: string
  }
  seedFidelity: SeedFidelityResult
  kitchenTestAccount: StationAccountResult
  kitchenAuthorize: { ordersRead: boolean; kitchenStation: boolean }
  barTestAccount: StationAccountResult
  barAuthorize: { ordersRead: boolean; barStation: boolean }
  ownerUnscoped: {
    permissionsIncludeOrdersRead: boolean
    hasKitchenStation: boolean
    hasBarStation: boolean
    filteredCount: number
  }
  customDualStationRole: {
    createStatus: number
    role_slug: string | null
    permissions: string[] | undefined
    unionFilteredIds: string[]
  }
}

async function verifySeedFidelity(): Promise<SeedFidelityResult> {
  const { data: rows, error } = await dbAdmin.from('restaurant_roles').select('role_slug, permissions')
  if (error) throw error

  const bySlug = new Map<string, Set<string>>()
  for (const row of rows ?? []) {
    const slug = String(row.role_slug)
    const key = sorted((row.permissions ?? []) as string[]).join('|')
    if (!bySlug.has(slug)) bySlug.set(slug, new Set())
    bySlug.get(slug)!.add(key)
  }

  const mismatches: string[] = []
  for (const slug of SYSTEM_SLUGS) {
    const expected = expectedPermissionsForSlug(slug).join('|')
    const variants = bySlug.get(slug)
    if (!variants || variants.size !== 1) {
      mismatches.push(`${slug}: expected one permission set, found ${variants?.size ?? 0}`)
      continue
    }
    const actual = [...variants][0]
    if (actual !== expected) {
      mismatches.push(`${slug}: expected ${expected}, got ${actual}`)
    }
    const actualPerms = actual.split('|')
    const hasStation = actualPerms.some((p) => STATION_PERMS.has(p))
    const shouldHaveStation = slug === 'kitchen' || slug === 'bar'
    if (hasStation !== shouldHaveStation) {
      mismatches.push(`${slug}: station scope presence mismatch`)
    }
    if (['owner', 'manager', 'waiter', 'cashier'].includes(slug) && hasStation) {
      mismatches.push(`${slug}: must not have station scope`)
    }
  }

  return {
    restaurantRoleRows: rows?.length ?? 0,
    uniqueSlugs: [...bySlug.keys()].sort(),
    mismatches,
    ok: mismatches.length === 0,
  }
}

async function main() {
  const report: Phase5aReport = {
    app: APP,
    tag,
    barBehaviorClarification: {
      beforeFix:
        'Bar role seed historically had only stock:view (no orders:read). RoleGuard still allowed bar on /dashboard, so authorize(orders:read) failed and station filtering was role-slug based — broken/inconsistent access.',
      afterFix:
        'Bar seed now includes orders:read + orders:station:bar. Dashboard filtering uses permissions; bar staff see bar-station orders only.',
    },
    seedFidelity: await verifySeedFidelity(),
    kitchenTestAccount: {
      email: STAGING_TEST_EMAIL,
      permissions: [],
      hasOrdersRead: false,
      hasKitchenStation: false,
      hasBarStation: false,
      filteredIds: [],
    },
    kitchenAuthorize: { ordersRead: false, kitchenStation: false },
    barTestAccount: {
      email: barEmail,
      permissions: [],
      hadOrdersReadBeforeMigration: false,
      hasOrdersReadNow: false,
      hasKitchenStation: false,
      hasBarStation: false,
      filteredIds: [],
    },
    barAuthorize: { ordersRead: false, barStation: false },
    ownerUnscoped: {
      permissionsIncludeOrdersRead: false,
      hasKitchenStation: false,
      hasBarStation: false,
      filteredCount: 0,
    },
    customDualStationRole: {
      createStatus: 0,
      role_slug: null,
      permissions: undefined,
      unionFilteredIds: [],
    },
  }

  const kitchenTok = await signIn(STAGING_TEST_EMAIL, STAGING_TEST_PASSWORD)
  const kitchenRoleApi = await fetchRoleApi(kitchenTok)
  const kitchenPerms = (kitchenRoleApi.body.permissions ?? []) as string[]

  report.kitchenTestAccount = {
    email: STAGING_TEST_EMAIL,
    permissions: kitchenPerms,
    hasOrdersRead: kitchenPerms.includes(PERMISSIONS.ORDERS_READ),
    hasKitchenStation: kitchenPerms.includes(PERMISSIONS.ORDERS_STATION_KITCHEN),
    hasBarStation: kitchenPerms.includes(PERMISSIONS.ORDERS_STATION_BAR),
    filteredIds: filterOrdersByStationScope(sampleOrders, {
      hasKitchenStation: true,
      hasBarStation: false,
    }).map((o) => o.id),
  }

  const kitchenOrdersRead = await authorize(
    STAGING_TEST_USER_ID,
    STAGING_TEST_RESTAURANT_ID,
    PERMISSIONS.ORDERS_READ
  )
  const kitchenStation = await authorize(
    STAGING_TEST_USER_ID,
    STAGING_TEST_RESTAURANT_ID,
    PERMISSIONS.ORDERS_STATION_KITCHEN
  )
  report.kitchenAuthorize = { ordersRead: kitchenOrdersRead, kitchenStation }

  await setupDisposableRestaurant()

  const barTok = await signIn(barEmail)
  const barRoleApi = await fetchRoleApi(barTok)
  const barPerms = (barRoleApi.body.permissions ?? []) as string[]

  report.barTestAccount = {
    email: barEmail,
    permissions: barPerms,
    hadOrdersReadBeforeMigration: false,
    hasOrdersReadNow: barPerms.includes(PERMISSIONS.ORDERS_READ),
    hasBarStation: barPerms.includes(PERMISSIONS.ORDERS_STATION_BAR),
    hasKitchenStation: barPerms.includes(PERMISSIONS.ORDERS_STATION_KITCHEN),
    filteredIds: filterOrdersByStationScope(sampleOrders, {
      hasKitchenStation: false,
      hasBarStation: true,
    }).map((o) => o.id),
  }

  const barOrdersRead = await authorize(barUserId!, restId!, PERMISSIONS.ORDERS_READ)
  const barStation = await authorize(barUserId!, restId!, PERMISSIONS.ORDERS_STATION_BAR)
  report.barAuthorize = { ordersRead: barOrdersRead, barStation }

  const ownerTok = await signIn(ownerEmail)
  const ownerRoleApi = await fetchRoleApi(ownerTok)
  const ownerPerms = (ownerRoleApi.body.permissions ?? []) as string[]

  report.ownerUnscoped = {
    permissionsIncludeOrdersRead: ownerPerms.includes(PERMISSIONS.ORDERS_READ),
    hasKitchenStation: ownerPerms.includes(PERMISSIONS.ORDERS_STATION_KITCHEN),
    hasBarStation: ownerPerms.includes(PERMISSIONS.ORDERS_STATION_BAR),
    filteredCount: filterOrdersByStationScope(sampleOrders, {
      hasKitchenStation: false,
      hasBarStation: false,
    }).length,
  }

  const createRes = await fetch(`${APP}/api/admin/restaurant-roles`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerTok}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      display_name: CUSTOM_ROLE_NAME,
      permissions: [
        PERMISSIONS.ORDERS_READ,
        PERMISSIONS.ORDERS_STATION_KITCHEN,
        PERMISSIONS.ORDERS_STATION_BAR,
      ],
      is_invite_eligible: false,
    }),
  })
  const createBody = await createRes.json()
  customRoleSlug = createBody?.role?.role_slug ?? null

  const headChefFiltered = filterOrdersByStationScope(sampleOrders, {
    hasKitchenStation: true,
    hasBarStation: true,
  }).map((o) => o.id)

  report.customDualStationRole = {
    createStatus: createRes.status,
    role_slug: customRoleSlug,
    permissions: createBody?.role?.permissions,
    unionFilteredIds: headChefFiltered,
  }

  console.log(JSON.stringify(report, null, 2))

  const pass =
    report.seedFidelity.ok === true &&
    kitchenRoleApi.status === 200 &&
    kitchenPerms.includes(PERMISSIONS.ORDERS_STATION_KITCHEN) &&
    !kitchenPerms.includes(PERMISSIONS.ORDERS_STATION_BAR) &&
    report.kitchenTestAccount.filteredIds?.join() === 'kitchen-only,both-stations' &&
    kitchenOrdersRead === true &&
    kitchenStation === true &&
    barRoleApi.status === 200 &&
    barPerms.includes(PERMISSIONS.ORDERS_READ) &&
    barPerms.includes(PERMISSIONS.ORDERS_STATION_BAR) &&
    !barPerms.includes(PERMISSIONS.ORDERS_STATION_KITCHEN) &&
    report.barTestAccount.filteredIds?.join() === 'bar-only,both-stations' &&
    barOrdersRead === true &&
    barStation === true &&
    ownerPerms.includes(PERMISSIONS.ORDERS_READ) &&
    !ownerPerms.includes(PERMISSIONS.ORDERS_STATION_KITCHEN) &&
    !ownerPerms.includes(PERMISSIONS.ORDERS_STATION_BAR) &&
    report.ownerUnscoped.filteredCount === 3 &&
    createRes.status === 201 &&
    headChefFiltered.join() === 'kitchen-only,bar-only,both-stations'

  if (!pass) {
    console.error('PHASE5A_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE5A_STAGING_OK')
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
