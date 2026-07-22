/**
 * Phase 5A production verification (Riviera + disposable kitchen/bar staff).
 *   npx tsx scripts/verify-phase5a-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'
import { authorize } from '../lib/permissions/authorize'
import { filterOrdersByStationScope } from '../lib/order-routing'

config({ path: '.env.production.local', override: true })

const APP = process.env.PRODUCTION_APP_URL || 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const tag = `phase5a-prod-${Date.now()}`
const pw = `Verify${randomUUID().slice(0, 8)}!1`

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
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

const sampleOrders = [
  { id: 'kitchen-only', items: [{ route_to: 'kitchen' }] },
  { id: 'bar-only', items: [{ route_to: 'bar' }] },
  { id: 'both-stations', items: [{ route_to: 'both' }] },
]

let kitchenUserId: string | null = null
let barUserId: string | null = null

const kitchenEmail = `${tag}.kitchen@flashtap-test.invalid`
const barEmail = `${tag}.bar@flashtap-test.invalid`

interface Phase5aProductionReport {
  app: string
  tag: string
  expectedCommitPrefix: string
  version: { status: number; commit?: string; body: unknown }
  kitchenDisposable: {
    email: string
    permissions: string[]
    ordersRead: boolean
    kitchenStation: boolean
    barStation: boolean
    filteredIds: string[]
    authorizeOrdersRead: boolean
    authorizeKitchenStation: boolean
  }
  barDisposable: {
    email: string
    permissions: string[]
    ordersRead: boolean
    barStation: boolean
    kitchenStation: boolean
    filteredIds: string[]
    authorizeOrdersRead: boolean
    authorizeBarStation: boolean
    bugFixProven: boolean
  }
  ownerReal: {
    email: string
    permissions: string[]
    hasKitchenStation: boolean
    hasBarStation: boolean
    filteredCount: number
  }
  managerReal: {
    found: boolean
    email?: string
    permissions?: string[]
    hasKitchenStation?: boolean
    hasBarStation?: boolean
    filteredCount?: number
  }
}

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

async function resolveRivieraManagerEmail(): Promise<string | null> {
  const { data: managerRow, error } = await dbAdmin
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', RIVIERA_ID)
    .eq('role', 'manager')
    .eq('invite_accepted', true)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!managerRow?.user_id) return null

  const { data: userRow, error: userError } = await dbAdmin
    .from('users')
    .select('email')
    .eq('id', managerRow.user_id)
    .maybeSingle()
  if (userError) throw userError
  return String(userRow?.email || '').trim() || null
}

async function signInWithPassword(email: string, password: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
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

async function fetchRoleApi(token: string) {
  const res = await fetch(`${APP}/api/auth/role`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json()
  return { status: res.status, body }
}

async function setupDisposableStaff() {
  for (const [email, role, label] of [
    [kitchenEmail, 'kitchen', 'kitchen'],
    [barEmail, 'bar', 'bar'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    if (label === 'kitchen') kitchenUserId = u.user.id
    if (label === 'bar') barUserId = u.user.id

    await dbAdmin.from('users').insert({
      id: u.user.id,
      email,
      role,
      restaurant_id: RIVIERA_ID,
      full_name: `Phase5A ${role}`,
    })

    await dbAdmin.from('restaurant_users').insert({
      restaurant_id: RIVIERA_ID,
      user_id: u.user.id,
      role,
      invite_accepted: true,
    })
  }
}

async function cleanup() {
  for (const uid of [kitchenUserId, barUserId]) {
    if (!uid) continue
    await dbAdmin.from('restaurant_users').delete().eq('user_id', uid).eq('restaurant_id', RIVIERA_ID)
    await dbAdmin.from('users').delete().eq('id', uid)
    await authAdmin.auth.admin.deleteUser(uid)
  }
}

async function main() {
  const expectedCommitPrefix = 'a8b0f7a'
  const versionRes = await fetch(`${APP}/api/version`)
  const versionBody = await versionRes.json().catch(() => ({}))
  const deployedCommit = String(
    (versionBody as { commit?: string; sha?: string }).commit ??
      (versionBody as { sha?: string }).sha ??
      '',
  )

  const report: Phase5aProductionReport = {
    app: APP,
    tag,
    expectedCommitPrefix,
    version: { status: versionRes.status, commit: deployedCommit, body: versionBody },
    kitchenDisposable: {
      email: kitchenEmail,
      permissions: [],
      ordersRead: false,
      kitchenStation: false,
      barStation: false,
      filteredIds: [],
      authorizeOrdersRead: false,
      authorizeKitchenStation: false,
    },
    barDisposable: {
      email: barEmail,
      permissions: [],
      ordersRead: false,
      barStation: false,
      kitchenStation: false,
      filteredIds: [],
      authorizeOrdersRead: false,
      authorizeBarStation: false,
      bugFixProven: false,
    },
    ownerReal: {
      email: '',
      permissions: [],
      hasKitchenStation: false,
      hasBarStation: false,
      filteredCount: 0,
    },
    managerReal: { found: false },
  }

  if (!deployedCommit.startsWith(expectedCommitPrefix)) {
    console.log(JSON.stringify(report, null, 2))
    console.error(
      `PHASE5A_PRODUCTION_FAIL: /api/version commit ${deployedCommit || '(missing)'} != ${expectedCommitPrefix}`,
    )
    process.exitCode = 1
    return
  }

  await setupDisposableStaff()

  const kitchenTok = await signInWithPassword(kitchenEmail, pw)
  const kitchenRoleApi = await fetchRoleApi(kitchenTok)
  const kitchenPerms = (kitchenRoleApi.body.permissions ?? []) as string[]

  report.kitchenDisposable = {
    email: kitchenEmail,
    permissions: kitchenPerms,
    ordersRead: kitchenPerms.includes(PERMISSIONS.ORDERS_READ),
    kitchenStation: kitchenPerms.includes(PERMISSIONS.ORDERS_STATION_KITCHEN),
    barStation: kitchenPerms.includes(PERMISSIONS.ORDERS_STATION_BAR),
    filteredIds: filterOrdersByStationScope(sampleOrders, {
      hasKitchenStation: true,
      hasBarStation: false,
    }).map((o) => o.id),
    authorizeOrdersRead: await authorize(kitchenUserId!, RIVIERA_ID, PERMISSIONS.ORDERS_READ),
    authorizeKitchenStation: await authorize(
      kitchenUserId!,
      RIVIERA_ID,
      PERMISSIONS.ORDERS_STATION_KITCHEN,
    ),
  }

  const barTok = await signInWithPassword(barEmail, pw)
  const barRoleApi = await fetchRoleApi(barTok)
  const barPerms = (barRoleApi.body.permissions ?? []) as string[]

  const barOrdersRead = await authorize(barUserId!, RIVIERA_ID, PERMISSIONS.ORDERS_READ)
  const barStation = await authorize(barUserId!, RIVIERA_ID, PERMISSIONS.ORDERS_STATION_BAR)

  report.barDisposable = {
    email: barEmail,
    permissions: barPerms,
    ordersRead: barPerms.includes(PERMISSIONS.ORDERS_READ),
    barStation: barPerms.includes(PERMISSIONS.ORDERS_STATION_BAR),
    kitchenStation: barPerms.includes(PERMISSIONS.ORDERS_STATION_KITCHEN),
    filteredIds: filterOrdersByStationScope(sampleOrders, {
      hasKitchenStation: false,
      hasBarStation: true,
    }).map((o) => o.id),
    authorizeOrdersRead: barOrdersRead,
    authorizeBarStation: barStation,
    bugFixProven:
      barOrdersRead &&
      barStation &&
      barPerms.includes(PERMISSIONS.ORDERS_READ) &&
      barPerms.includes(PERMISSIONS.ORDERS_STATION_BAR) &&
      filterOrdersByStationScope(sampleOrders, { hasKitchenStation: false, hasBarStation: true })
        .map((o) => o.id)
        .join() === 'bar-only,both-stations',
  }

  const ownerEmail = await resolveRivieraOwnerEmail()
  const ownerTok = await signInWithMagicLink(ownerEmail)
  const ownerRoleApi = await fetchRoleApi(ownerTok)
  const ownerPerms = (ownerRoleApi.body.permissions ?? []) as string[]

  report.ownerReal = {
    email: ownerEmail,
    permissions: ownerPerms,
    hasKitchenStation: ownerPerms.includes(PERMISSIONS.ORDERS_STATION_KITCHEN),
    hasBarStation: ownerPerms.includes(PERMISSIONS.ORDERS_STATION_BAR),
    filteredCount: filterOrdersByStationScope(sampleOrders, {
      hasKitchenStation: false,
      hasBarStation: false,
    }).length,
  }

  const managerEmail = await resolveRivieraManagerEmail()
  if (managerEmail) {
    const managerTok = await signInWithMagicLink(managerEmail)
    const managerRoleApi = await fetchRoleApi(managerTok)
    const managerPerms = (managerRoleApi.body.permissions ?? []) as string[]
    report.managerReal = {
      found: true,
      email: managerEmail,
      permissions: managerPerms,
      hasKitchenStation: managerPerms.includes(PERMISSIONS.ORDERS_STATION_KITCHEN),
      hasBarStation: managerPerms.includes(PERMISSIONS.ORDERS_STATION_BAR),
      filteredCount: filterOrdersByStationScope(sampleOrders, {
        hasKitchenStation: false,
        hasBarStation: false,
      }).length,
    }
  }

  console.log(JSON.stringify(report, null, 2))

  const pass =
    report.kitchenDisposable.kitchenStation &&
    !report.kitchenDisposable.barStation &&
    report.kitchenDisposable.filteredIds.join() === 'kitchen-only,both-stations' &&
    report.kitchenDisposable.authorizeOrdersRead &&
    report.kitchenDisposable.authorizeKitchenStation &&
    report.barDisposable.bugFixProven &&
    barRoleApi.status === 200 &&
    report.ownerReal.filteredCount === 3 &&
    !report.ownerReal.hasKitchenStation &&
    !report.ownerReal.hasBarStation &&
    (!report.managerReal.found ||
      (report.managerReal.filteredCount === 3 &&
        !report.managerReal.hasKitchenStation &&
        !report.managerReal.hasBarStation))

  if (!pass) {
    console.error('PHASE5A_PRODUCTION_FAIL')
    process.exitCode = 1
  } else {
    console.log('PHASE5A_PRODUCTION_OK')
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
