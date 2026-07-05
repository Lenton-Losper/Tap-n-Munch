/**
 * Staging verification for Settings permission migration.
 *   npx tsx scripts/verify-settings-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import rolePermissionsConfig from '../lib/permissions/role-permissions.config.json'
import { PERMISSIONS } from '../lib/permissions'

config({ path: '.env.test', override: true })

const APP =
  process.env.STAGING_APP_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const ts = Date.now()
const tag = `settings-verify-${ts}`

const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const anonKey = process.env.SUPABASE_ANON_KEY!

if (!url?.includes(STAGING_REF)) {
  throw new Error(`Refusing: not staging Supabase (${url})`)
}

const dbAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const authAdmin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const anon = createClient(url, anonKey!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const pw = `Set${randomUUID().slice(0, 8)}!1`
let restAId: string | null = null
let restBId: string | null = null
let ownerAId: string | null = null
let ownerBId: string | null = null
let managerId: string | null = null
let waiterId: string | null = null
let waiterStaffId: string | null = null
let scheduleBId: string | null = null

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`
const managerEmail = `${tag}.manager@flashtap-test.invalid`
const waiterEmail = `${tag}.waiter@flashtap-test.invalid`

async function signIn(email: string) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password: pw })
  if (error || !data.session?.access_token) throw new Error(`Sign-in failed: ${error?.message}`)
  return data.session.access_token
}

async function fetchSettingsPage(token: string) {
  const res = await fetch(`${APP}/settings`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
  })
  const body = await res.text()
  const rscRedirect =
    body.includes('NEXT_REDIRECT') &&
    (body.includes('/dashboard') || body.includes('/signin'))
  return { status: res.status, location: res.headers.get('location'), rscRedirect }
}

async function seedFidelity() {
  const expected = Object.fromEntries(
    Object.entries(rolePermissionsConfig).filter(([k]) => !k.startsWith('$')),
  ) as Record<string, string[]>

  const { data: restaurants, error } = await dbAdmin.from('restaurants').select('id, name')
  if (error) throw error

  const { data: rows, error: rolesError } = await dbAdmin
    .from('restaurant_roles')
    .select('restaurant_id, role_slug, permissions')
  if (rolesError) throw rolesError

  let ownerPaymentsOk = 0
  let nonOwnerWithPayments = 0
  let jsonMismatches = 0

  for (const restaurant of restaurants ?? []) {
    const roles = (rows ?? []).filter((r) => r.restaurant_id === restaurant.id)
    for (const role of roles) {
      const perms = (role.permissions ?? []) as string[]
      const hasView = perms.includes(PERMISSIONS.PAYMENTS_VIEW)
      const hasConfigure = perms.includes(PERMISSIONS.PAYMENTS_CONFIGURE)
      if (role.role_slug === 'owner') {
        if (hasView && hasConfigure) ownerPaymentsOk++
        const exp = sorted(expected.owner ?? [])
        const got = sorted(perms)
        if (JSON.stringify(exp) !== JSON.stringify(got)) jsonMismatches++
      } else if (hasView || hasConfigure) {
        nonOwnerWithPayments++
      }
    }
  }

  return {
    restaurantCount: restaurants?.length ?? 0,
    ownerPaymentsOk,
    nonOwnerWithPayments,
    jsonMismatches,
    pass:
      ownerPaymentsOk === (restaurants?.length ?? 0) &&
      nonOwnerWithPayments === 0 &&
      jsonMismatches === 0,
  }
}

function sorted(arr: string[]) {
  return [...arr].sort()
}

async function setup() {
  const { data: a, error: aErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} A`, slug: `${tag}-a` })
    .select('id')
    .single()
  if (aErr) throw aErr
  restAId = a.id

  const { data: b, error: bErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} B`, slug: `${tag}-b` })
    .select('id')
    .single()
  if (bErr) throw bErr
  restBId = b.id

  for (const [email, label] of [
    [ownerAEmail, 'ownerA'],
    [ownerBEmail, 'ownerB'],
    [managerEmail, 'manager'],
    [waiterEmail, 'waiter'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    if (label === 'ownerA') ownerAId = u.user.id
    if (label === 'ownerB') ownerBId = u.user.id
    if (label === 'manager') managerId = u.user.id
    if (label === 'waiter') waiterId = u.user.id
  }

  await dbAdmin.from('users').insert([
    { id: ownerAId, email: ownerAEmail, role: 'owner', restaurant_id: restAId, full_name: 'OA' },
    { id: ownerBId, email: ownerBEmail, role: 'owner', restaurant_id: restBId, full_name: 'OB' },
    { id: managerId, email: managerEmail, role: 'manager', restaurant_id: restAId, full_name: 'M' },
    { id: waiterId, email: waiterEmail, role: 'waiter', restaurant_id: restAId, full_name: 'W' },
  ])

  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: restAId, user_id: ownerAId, role: 'owner', invite_accepted: true },
    { restaurant_id: restBId, user_id: ownerBId, role: 'owner', invite_accepted: true },
    { restaurant_id: restAId, user_id: managerId, role: 'manager', invite_accepted: true },
    { restaurant_id: restAId, user_id: waiterId, role: 'waiter', invite_accepted: true },
  ])

  const { data: staff, error: staffErr } = await dbAdmin
    .from('staff_members')
    .insert({
      restaurant_id: restAId,
      email: waiterEmail,
      role: 'waiter',
      active: true,
    })
    .select('id')
    .single()
  if (staffErr) throw staffErr
  waiterStaffId = staff.id

  const { data: sched, error: schedErr } = await dbAdmin
    .from('report_schedules')
    .insert({
      restaurant_id: restBId,
      email: `${tag}.b@flashtap-test.invalid`,
      format: 'csv',
      send_time: '20:00',
      timezone: 'Africa/Windhoek',
      enabled: true,
    })
    .select('id')
    .single()
  if (schedErr) throw schedErr
  scheduleBId = sched.id

  await dbAdmin.from('restaurant_terminals').insert({
    restaurant_id: restAId,
    terminal_name: `${tag} terminal`,
    status: 'active',
    active: true,
    device_serial: `${tag}-serial`,
  })
}

async function cleanup() {
  if (waiterStaffId) {
    await dbAdmin.from('staff_permissions').delete().eq('staff_id', waiterStaffId)
    await dbAdmin.from('staff_members').delete().eq('id', waiterStaffId)
  }
  if (scheduleBId) await dbAdmin.from('report_schedules').delete().eq('id', scheduleBId)
  if (restAId) {
    await dbAdmin.from('restaurant_terminals').delete().eq('restaurant_id', restAId)
    await dbAdmin.from('report_schedules').delete().eq('restaurant_id', restAId)
  }
  for (const rid of [restAId, restBId]) {
    if (rid) {
      await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', rid)
      await dbAdmin.from('restaurants').delete().eq('id', rid)
    }
  }
  for (const uid of [ownerAId, ownerBId, managerId, waiterId]) {
    if (uid) {
      await dbAdmin.from('users').delete().eq('id', uid)
      await authAdmin.auth.admin.deleteUser(uid)
    }
  }
}

async function main() {
  const report: Record<string, unknown> = { app: APP, tag }

  report.seedFidelity = await seedFidelity()
  await setup()

  const ownerAToken = await signIn(ownerAEmail)
  const managerToken = await signIn(managerEmail)
  const waiterToken = await signIn(waiterEmail)

  const ownerTerminals = await fetch(`${APP}/api/admin/terminals/list`, {
    headers: { Authorization: `Bearer ${ownerAToken}` },
  })
  const ownerFinatic = await fetch(`${APP}/api/admin/restaurant/finatic`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ownerAToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ merchantNo: '123', storeNo: '456' }),
  })
  const ownerSettingsPage = await fetchSettingsPage(ownerAToken)
  const ownerRsGet = await fetch(`${APP}/api/admin/restaurants/${restAId}/report-schedules`, {
    headers: { Authorization: `Bearer ${ownerAToken}` },
  })
  const ownerProfileSettings = await fetch(`${APP}/api/admin/restaurant-settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerAToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ restaurantId: restAId, updates: { name: `${tag} A Updated` } }),
  })

  const ownerSetupGet = await fetch(`${APP}/api/admin/setup-status`, {
    headers: { Authorization: `Bearer ${ownerAToken}` },
  })

  const managerSetupGet = await fetch(`${APP}/api/admin/setup-status`, {
    headers: { Authorization: `Bearer ${managerToken}` },
  })
  const managerTerminals = await fetch(`${APP}/api/admin/terminals/list`, {
    headers: { Authorization: `Bearer ${managerToken}` },
  })
  const managerSettingsPage = await fetchSettingsPage(managerToken)
  const managerRsGet = await fetch(`${APP}/api/admin/restaurants/${restAId}/report-schedules`, {
    headers: { Authorization: `Bearer ${managerToken}` },
  })

  const waiterSetupGet = await fetch(`${APP}/api/admin/setup-status`, {
    headers: { Authorization: `Bearer ${waiterToken}` },
  })
  const waiterSettingsPage = await fetchSettingsPage(waiterToken)
  const waiterTerminals = await fetch(`${APP}/api/admin/terminals/list`, {
    headers: { Authorization: `Bearer ${waiterToken}` },
  })

  await dbAdmin.from('staff_permissions').insert({
    staff_id: waiterStaffId,
    restaurant_id: restAId,
    permission: PERMISSIONS.PAYMENTS_VIEW,
    effect: 'allow',
  })

  const waiterViewToken = await signIn(waiterEmail)
  const waiterViewTerminals = await fetch(`${APP}/api/admin/terminals/list`, {
    headers: { Authorization: `Bearer ${waiterViewToken}` },
  })
  const waiterViewConfigure = await fetch(`${APP}/api/admin/terminals/generate-code`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${waiterViewToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  })

  const crossRsGet = await fetch(`${APP}/api/admin/restaurants/${restBId}/report-schedules`, {
    headers: { Authorization: `Bearer ${ownerAToken}` },
  })
  const crossSettings = await fetch(`${APP}/api/admin/restaurant-settings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerAToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ restaurantId: restBId, updates: { name: 'HACKED' } }),
  })

  report.owner = {
    setupStatusGet: ownerSetupGet.status,
    terminalsList: ownerTerminals.status,
    finaticPatch: ownerFinatic.status,
    settingsPageBlocked: ownerSettingsPage.rscRedirect,
    reportSchedulesGet: ownerRsGet.status,
    profileSettingsPost: ownerProfileSettings.status,
  }

  report.manager = {
    setupStatusGet: managerSetupGet.status,
    setupStatusNote:
      'setup-status uses SETTINGS_WRITE — owner and manager both have settings:write (restores pre-migration assertRestaurantAdmin access)',
    terminalsList: managerTerminals.status,
    settingsPageStatus: managerSettingsPage.status,
    settingsPageBlocked: managerSettingsPage.rscRedirect,
    settingsExpansion:
      'EXPANSION: Settings page/sidebar was owner-only RoleGuard; now SETTINGS_READ — manager gains Settings UI (profile/restaurant tabs, no payments tab)',
    reportSchedulesGet: managerRsGet.status,
  }

  report.waiter = {
    setupStatusGet: waiterSetupGet.status,
    settingsPageBlocked: waiterSettingsPage.rscRedirect,
    settingsPageStatus: waiterSettingsPage.status,
    settingsPageLocation: waiterSettingsPage.location,
    terminalsListBeforeOverride: waiterTerminals.status,
  }

  report.paymentsViewOverride = {
    terminalsList: waiterViewTerminals.status,
    terminalCount: waiterViewTerminals.ok
      ? ((await waiterViewTerminals.json().catch(() => ({}))) as { terminals?: unknown[] })
          .terminals?.length ?? null
      : null,
    generateCode: waiterViewConfigure.status,
  }

  report.crossTenant = {
    reportSchedulesGet: crossRsGet.status,
    restaurantSettingsPost: crossSettings.status,
  }

  console.log(JSON.stringify(report, null, 2))

  const seed = report.seedFidelity as { pass: boolean }
  const owner = report.owner as Record<string, unknown>
  const manager = report.manager as Record<string, unknown>
  const waiter = report.waiter as Record<string, unknown>
  const override = report.paymentsViewOverride as Record<string, unknown>
  const cross = report.crossTenant as Record<string, unknown>

  report.pageGateNote =
    'RSC /settings gate uses cookie session only; Bearer-token fetch cannot prove server redirect — API authorize() is authoritative below.'

  const pass =
    seed.pass &&
    owner.setupStatusGet === 200 &&
    owner.terminalsList === 200 &&
    owner.finaticPatch === 200 &&
    owner.reportSchedulesGet === 200 &&
    owner.profileSettingsPost === 200 &&
    manager.setupStatusGet === 200 &&
    manager.terminalsList === 403 &&
    manager.reportSchedulesGet === 200 &&
    waiter.setupStatusGet === 403 &&
    waiter.terminalsListBeforeOverride === 403 &&
    override.terminalsList === 200 &&
    override.generateCode === 403 &&
    cross.reportSchedulesGet === 403 &&
    cross.restaurantSettingsPost === 403

  if (!pass) {
    console.error('SETTINGS_STAGING_FAIL')
    process.exitCode = 1
  } else {
    console.log('SETTINGS_STAGING_OK')
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
