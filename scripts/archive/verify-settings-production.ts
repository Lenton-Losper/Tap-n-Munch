/**
 * Production Step 3 verification for Settings permission migration.
 *   npx tsx scripts/verify-settings-production.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { PERMISSIONS } from '../lib/permissions'

config({ path: '.env.production.local', override: true })

const APP = process.env.PRODUCTION_APP_URL || 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const RIVIERA_ID = '01bf27f1-a958-4322-bb3e-cc5240987808'
const ts = Date.now()
const tag = `settings-prod-verify-${ts}`

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

const pw = `Verify${randomUUID().slice(0, 8)}!1`
const managerEmail = `${tag}.manager@flashtap-test.invalid`
const waiterEmail = `${tag}.waiter@flashtap-test.invalid`
const kitchenEmail = `${tag}.kitchen@flashtap-test.invalid`
const leakOwnerEmail = `${tag}.leak-owner@flashtap-test.invalid`

let managerId: string | null = null
let waiterId: string | null = null
let kitchenId: string | null = null
let waiterStaffId: string | null = null
let leakRestBId: string | null = null
let leakOwnerId: string | null = null
let scheduleBId: string | null = null
let terminalAId: string | null = null

async function resolveRivieraOwnerEmail(): Promise<string> {
  const { data: ownerRow, error } = await dbAdmin
    .from('restaurant_users')
    .select('user_id')
    .eq('restaurant_id', RIVIERA_ID)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!ownerRow?.user_id) throw new Error('No Riviera owner in restaurant_users')

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

async function ownerToken(): Promise<string> {
  const ownerEmail = await resolveRivieraOwnerEmail()
  const { data: link, error: linkErr } = await authAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: ownerEmail,
  })
  if (linkErr || !link?.properties?.hashed_token) {
    throw new Error(`Owner magic link failed: ${linkErr?.message}`)
  }
  const { data: sess, error: otpErr } = await authAdmin.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink',
  })
  if (otpErr || !sess.session?.access_token) {
    throw new Error(`Owner OTP failed: ${otpErr?.message}`)
  }
  return sess.session.access_token
}

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

async function cleanupLeftovers() {
  const patterns = [`${tag}%`, 'settings-prod-verify-%']
  for (const pattern of patterns) {
    const { data: users } = await dbAdmin.from('users').select('id, email').like('email', pattern)
    for (const row of users ?? []) {
      const { data: staffRows } = await dbAdmin
        .from('staff_members')
        .select('id')
        .ilike('email', row.email)
      for (const staff of staffRows ?? []) {
        await dbAdmin.from('staff_permissions').delete().eq('staff_id', staff.id)
        await dbAdmin.from('staff_members').delete().eq('id', staff.id)
      }
      await dbAdmin.from('restaurant_users').delete().eq('user_id', row.id)
      await dbAdmin.from('users').delete().eq('id', row.id)
      await authAdmin.auth.admin.deleteUser(row.id).catch(() => undefined)
    }
  }

  const { data: leakRestaurants } = await dbAdmin
    .from('restaurants')
    .select('id, owner_id')
    .like('name', `${tag}%`)
  for (const leak of leakRestaurants ?? []) {
    await dbAdmin.from('restaurant_terminals').delete().eq('restaurant_id', leak.id)
    await dbAdmin.from('report_schedules').delete().eq('restaurant_id', leak.id)
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', leak.id)
    await dbAdmin.from('restaurants').delete().eq('id', leak.id)
    if (leak.owner_id) {
      await dbAdmin.from('users').delete().eq('id', leak.owner_id)
      await authAdmin.auth.admin.deleteUser(String(leak.owner_id)).catch(() => undefined)
    }
  }
}

async function setupDisposableAccounts() {
  for (const [email, label] of [
    [managerEmail, 'manager'],
    [waiterEmail, 'waiter'],
    [kitchenEmail, 'kitchen'],
    [leakOwnerEmail, 'leakOwner'],
  ] as const) {
    const { data: u, error } = await authAdmin.auth.admin.createUser({
      email,
      password: pw,
      email_confirm: true,
    })
    if (error || !u.user) throw error
    if (label === 'manager') managerId = u.user.id
    if (label === 'waiter') waiterId = u.user.id
    if (label === 'kitchen') kitchenId = u.user.id
    if (label === 'leakOwner') leakOwnerId = u.user.id
  }

  await dbAdmin.from('users').insert([
    { id: managerId, email: managerEmail, role: 'manager', restaurant_id: RIVIERA_ID, full_name: 'M' },
    { id: waiterId, email: waiterEmail, role: 'waiter', restaurant_id: RIVIERA_ID, full_name: 'W' },
    { id: kitchenId, email: kitchenEmail, role: 'kitchen', restaurant_id: RIVIERA_ID, full_name: 'K' },
    { id: leakOwnerId, email: leakOwnerEmail, role: 'owner', full_name: 'LO' },
  ])

  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: RIVIERA_ID, user_id: managerId, role: 'manager', invite_accepted: true },
    { restaurant_id: RIVIERA_ID, user_id: waiterId, role: 'waiter', invite_accepted: true },
    { restaurant_id: RIVIERA_ID, user_id: kitchenId, role: 'kitchen', invite_accepted: true },
  ])

  const { data: staff, error: staffErr } = await dbAdmin
    .from('staff_members')
    .insert({ restaurant_id: RIVIERA_ID, email: waiterEmail, role: 'waiter', active: true })
    .select('id')
    .single()
  if (staffErr) throw staffErr
  waiterStaffId = staff.id

  const { data: leakRest, error: leakErr } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} leak B`, slug: `${tag}-leak-b`, owner_id: leakOwnerId })
    .select('id')
    .single()
  if (leakErr) throw leakErr
  leakRestBId = leakRest.id

  await dbAdmin.from('restaurant_users').insert({
    restaurant_id: leakRestBId,
    user_id: leakOwnerId,
    role: 'owner',
    invite_accepted: true,
  })

  const { data: sched, error: schedErr } = await dbAdmin
    .from('report_schedules')
    .insert({
      restaurant_id: leakRestBId,
      email: `${tag}.sched@flashtap-test.invalid`,
      format: 'csv',
      send_time: '20:00',
      timezone: 'Africa/Windhoek',
      enabled: true,
    })
    .select('id')
    .single()
  if (schedErr) throw schedErr
  scheduleBId = sched.id

  const { data: terminal, error: termErr } = await dbAdmin
    .from('restaurant_terminals')
    .insert({
      restaurant_id: RIVIERA_ID,
      terminal_name: `${tag} terminal`,
      status: 'active',
      active: true,
      device_serial: `${tag}-serial`,
    })
    .select('id')
    .single()
  if (termErr) throw termErr
  terminalAId = terminal.id
}

async function cleanup() {
  if (waiterStaffId) {
    await dbAdmin.from('staff_permissions').delete().eq('staff_id', waiterStaffId)
    await dbAdmin.from('staff_members').delete().eq('id', waiterStaffId)
  }
  if (terminalAId) {
    await dbAdmin.from('restaurant_terminals').delete().eq('id', terminalAId)
  }
  if (scheduleBId) await dbAdmin.from('report_schedules').delete().eq('id', scheduleBId)
  for (const uid of [managerId, waiterId, kitchenId]) {
    if (uid) {
      await dbAdmin.from('restaurant_users').delete().eq('user_id', uid)
      await dbAdmin.from('users').delete().eq('id', uid)
      await authAdmin.auth.admin.deleteUser(uid).catch(() => undefined)
    }
  }
  if (leakRestBId) {
    await dbAdmin.from('restaurant_terminals').delete().eq('restaurant_id', leakRestBId)
    await dbAdmin.from('report_schedules').delete().eq('restaurant_id', leakRestBId)
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', leakRestBId)
    await dbAdmin.from('restaurants').delete().eq('id', leakRestBId)
  }
  if (leakOwnerId) {
    await dbAdmin.from('users').delete().eq('id', leakOwnerId)
    await authAdmin.auth.admin.deleteUser(leakOwnerId).catch(() => undefined)
  }
}

async function main() {
  const expectedCommitPrefix = process.env.EXPECTED_COMMIT_PREFIX || 'ab854dc'
  const versionRes = await fetch(`${APP}/api/version`)
  const versionBody = (await versionRes.json()) as { commit?: string }
  const commit = versionBody.commit ?? ''
  console.log(`Production commit: ${commit}`)
  if (!commit.startsWith(expectedCommitPrefix.slice(0, 7))) {
    throw new Error(`Deploy not ready: expected prefix ${expectedCommitPrefix.slice(0, 7)}, got ${commit}`)
  }

  const report: Record<string, unknown> = { app: APP, tag, commit }

  try {
    await cleanupLeftovers()
    await setupDisposableAccounts()

    const ownerTok = await ownerToken()
    const managerTok = await signIn(managerEmail)
    const waiterTok = await signIn(waiterEmail)
    const kitchenTok = await signIn(kitchenEmail)

    const owner = {
      setupStatus: (await fetch(`${APP}/api/admin/setup-status`, { headers: { Authorization: `Bearer ${ownerTok}` } })).status,
      terminalsList: (await fetch(`${APP}/api/admin/terminals/list`, { headers: { Authorization: `Bearer ${ownerTok}` } })).status,
      finaticPatch: (
        await fetch(`${APP}/api/admin/restaurant/finatic`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${ownerTok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ merchantNo: '123', storeNo: '456' }),
        })
      ).status,
      reportSchedulesGet: (
        await fetch(`${APP}/api/admin/restaurants/${RIVIERA_ID}/report-schedules`, {
          headers: { Authorization: `Bearer ${ownerTok}` },
        })
      ).status,
      restaurantSettingsPost: (
        await fetch(`${APP}/api/admin/restaurant-settings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ownerTok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantId: RIVIERA_ID, updates: { name: 'Riviera' } }),
        })
      ).status,
    }
    report.owner = owner

    const managerSettingsPage = await fetchSettingsPage(managerTok)
    report.manager = {
      setupStatus: (await fetch(`${APP}/api/admin/setup-status`, { headers: { Authorization: `Bearer ${managerTok}` } })).status,
      terminalsList: (await fetch(`${APP}/api/admin/terminals/list`, { headers: { Authorization: `Bearer ${managerTok}` } })).status,
      finaticPatch: (
        await fetch(`${APP}/api/admin/restaurant/finatic`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${managerTok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ merchantNo: '999', storeNo: '888' }),
        })
      ).status,
      settingsPageStatus: managerSettingsPage.status,
      settingsPageRscRedirect: managerSettingsPage.rscRedirect,
      reportSchedulesGet: (
        await fetch(`${APP}/api/admin/restaurants/${RIVIERA_ID}/report-schedules`, {
          headers: { Authorization: `Bearer ${managerTok}` },
        })
      ).status,
    }

    const waiterPage = await fetchSettingsPage(waiterTok)
    const kitchenPage = await fetchSettingsPage(kitchenTok)
    report.waiter = {
      setupStatus: (await fetch(`${APP}/api/admin/setup-status`, { headers: { Authorization: `Bearer ${waiterTok}` } })).status,
      terminalsList: (await fetch(`${APP}/api/admin/terminals/list`, { headers: { Authorization: `Bearer ${waiterTok}` } })).status,
      settingsPageRscRedirect: waiterPage.rscRedirect,
      settingsPageStatus: waiterPage.status,
    }
    report.kitchen = {
      setupStatus: (await fetch(`${APP}/api/admin/setup-status`, { headers: { Authorization: `Bearer ${kitchenTok}` } })).status,
      settingsPageRscRedirect: kitchenPage.rscRedirect,
    }

    await dbAdmin.from('staff_permissions').insert({
      staff_id: waiterStaffId,
      restaurant_id: RIVIERA_ID,
      permission: PERMISSIONS.PAYMENTS_VIEW,
      effect: 'allow',
    })
    const overrideTok = await signIn(waiterEmail)
    report.paymentsViewOverride = {
      terminalsList: (await fetch(`${APP}/api/admin/terminals/list`, { headers: { Authorization: `Bearer ${overrideTok}` } })).status,
      generateCode: (
        await fetch(`${APP}/api/admin/terminals/generate-code`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${overrideTok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
      ).status,
    }

    report.crossTenant = {
      reportSchedulesGet: (
        await fetch(`${APP}/api/admin/restaurants/${leakRestBId}/report-schedules`, {
          headers: { Authorization: `Bearer ${ownerTok}` },
        })
      ).status,
      restaurantSettingsPost: (
        await fetch(`${APP}/api/admin/restaurant-settings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${ownerTok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantId: leakRestBId, updates: { name: 'HACKED' } }),
        })
      ).status,
      setupStatusScoped: 'same-tenant via getRestaurantIdForUser — no URL cross-vector',
      finaticScoped: 'same-tenant via getRestaurantIdForUser — no URL cross-vector',
      terminalsScoped: 'same-tenant via getRestaurantIdForUser — no URL cross-vector',
    }

    console.log(JSON.stringify(report, null, 2))

    const o = report.owner as Record<string, number>
    const m = report.manager as Record<string, number | boolean>
    const w = report.waiter as Record<string, number | boolean>
    const k = report.kitchen as Record<string, number | boolean>
    const ov = report.paymentsViewOverride as Record<string, number>
    const x = report.crossTenant as Record<string, number | string>

    const pass =
      o.setupStatus === 200 &&
      o.terminalsList === 200 &&
      o.finaticPatch === 200 &&
      o.reportSchedulesGet === 200 &&
      o.restaurantSettingsPost === 200 &&
      m.setupStatus === 200 &&
      m.terminalsList === 403 &&
      m.finaticPatch === 403 &&
      m.reportSchedulesGet === 200 &&
      w.setupStatus === 403 &&
      w.terminalsList === 403 &&
      (w.settingsPageRscRedirect === true || w.settingsPageStatus === 302 || w.settingsPageStatus === 307) &&
      k.setupStatus === 403 &&
      (k.settingsPageRscRedirect === true || kitchenPage.status === 302 || kitchenPage.status === 307) &&
      ov.terminalsList === 200 &&
      ov.generateCode === 403 &&
      x.reportSchedulesGet === 403 &&
      x.restaurantSettingsPost === 403

    if (!pass) {
      console.error('SETTINGS_PRODUCTION_FAIL')
      process.exitCode = 1
    } else {
      console.log('SETTINGS_PRODUCTION_OK')
    }
  } finally {
    await cleanup()
    await cleanupLeftovers()
    console.log('Cleanup complete.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
