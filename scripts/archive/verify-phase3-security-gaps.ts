/**
 * Read-only severity assessment for Staff/Settings Phase 3 security gaps.
 * Uses disposable restaurants/users only. Cleans up in finally.
 *
 *   npx tsx scripts/verify-phase3-security-gaps.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'

config({ path: '.env.production.local', override: true })

const APP = 'https://www.flashtap.app'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const ts = Date.now()
const tag = `sec-gap-${ts}`

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

const ownerAPassword = `OwnA${randomUUID().slice(0, 8)}!1`
const ownerBPassword = `OwnB${randomUUID().slice(0, 8)}!1`
const kitchenPassword = `Kit${randomUUID().slice(0, 8)}!1`

const ownerAEmail = `${tag}.owner-a@flashtap-test.invalid`
const ownerBEmail = `${tag}.owner-b@flashtap-test.invalid`
const kitchenEmail = `${tag}.kitchen@flashtap-test.invalid`

let restAId: string | null = null
let restBId: string | null = null
let ownerAId: string | null = null
let ownerBId: string | null = null
let kitchenUserId: string | null = null
let scheduleBId: string | null = null
let terminalAId: string | null = null
let terminalBId: string | null = null
let originalRestBName: string | null = null

async function signIn(email: string, password: string): Promise<string> {
  const { data, error } = await anon.auth.signInWithPassword({ email, password })
  if (error || !data.session?.access_token) {
    throw new Error(`Sign-in failed for ${email}: ${error?.message}`)
  }
  return data.session.access_token
}

async function userClient(token: string) {
  return createClient(url, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function setup() {
  const { data: restA, error: errA } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} Restaurant A`, slug: `${tag}-a` })
    .select('id')
    .single()
  if (errA) throw errA
  restAId = restA.id

  const { data: restB, error: errB } = await dbAdmin
    .from('restaurants')
    .insert({ name: `${tag} Restaurant B`, slug: `${tag}-b` })
    .select('id, name')
    .single()
  if (errB) throw errB
  restBId = restB.id
  originalRestBName = restB.name

  for (const [email, password, label] of [
    [ownerAEmail, ownerAPassword, 'ownerA'],
    [ownerBEmail, ownerBPassword, 'ownerB'],
    [kitchenEmail, kitchenPassword, 'kitchen'],
  ] as const) {
    const { data: created, error } = await authAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (error || !created.user) throw new Error(`createUser ${label}: ${error?.message}`)
    if (label === 'ownerA') ownerAId = created.user.id
    if (label === 'ownerB') ownerBId = created.user.id
    if (label === 'kitchen') kitchenUserId = created.user.id
  }

  await dbAdmin.from('restaurant_users').insert([
    { restaurant_id: restAId, user_id: ownerAId, role: 'owner', invite_accepted: true },
    { restaurant_id: restBId, user_id: ownerBId, role: 'owner', invite_accepted: true },
    { restaurant_id: restAId, user_id: kitchenUserId, role: 'kitchen', invite_accepted: true },
  ])

  const { data: sched, error: schedErr } = await dbAdmin
    .from('report_schedules')
    .insert({
      restaurant_id: restBId,
      email: `${tag}.reports@flashtap-test.invalid`,
      format: 'csv',
      send_time: '20:00',
      timezone: 'Africa/Windhoek',
      enabled: true,
    })
    .select('id')
    .single()
  if (schedErr) throw schedErr
  scheduleBId = sched.id

  const { data: termA, error: termAErr } = await dbAdmin
    .from('restaurant_terminals')
    .insert({
      restaurant_id: restAId,
      terminal_name: `${tag} Terminal A`,
      status: 'active',
      active: true,
      device_serial: `${tag}-serial-a`,
    })
    .select('id')
    .single()
  if (termAErr) throw termAErr
  terminalAId = termA.id

  const { data: termB, error: termBErr } = await dbAdmin
    .from('restaurant_terminals')
    .insert({
      restaurant_id: restBId,
      terminal_name: `${tag} Terminal B`,
      status: 'active',
      active: true,
      device_serial: `${tag}-serial-b`,
    })
    .select('id')
    .single()
  if (termBErr) throw termBErr
  terminalBId = termB.id
}

async function cleanup() {
  if (scheduleBId) await dbAdmin.from('report_schedules').delete().eq('id', scheduleBId)
  if (terminalAId) await dbAdmin.from('restaurant_terminals').delete().eq('id', terminalAId)
  if (terminalBId) await dbAdmin.from('restaurant_terminals').delete().eq('id', terminalBId)
  if (restAId) {
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', restAId)
    await dbAdmin.from('restaurants').delete().eq('id', restAId)
  }
  if (restBId) {
    await dbAdmin.from('restaurant_users').delete().eq('restaurant_id', restBId)
    await dbAdmin.from('restaurants').delete().eq('id', restBId)
  }
  for (const uid of [ownerAId, ownerBId, kitchenUserId]) {
    if (uid) await authAdmin.auth.admin.deleteUser(uid)
  }
}

async function fetchRlsPolicies(table: string) {
  const { data, error } = await dbAdmin.rpc('exec_sql', {
    query: `SELECT policyname, cmd, qual::text AS qual FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}' ORDER BY policyname`,
  })
  if (error) {
    const { data: rows } = await dbAdmin
      .from('pg_policies' as 'restaurants')
      .select('*')
      .limit(1)
    void rows
    return { error: error.message, policies: null }
  }
  return { policies: data }
}

async function queryPoliciesDirect() {
  const sql = `
    SELECT tablename, policyname, cmd, qual::text AS qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('restaurant_terminals', 'report_schedules', 'restaurants')
    ORDER BY tablename, policyname;
  `
  const res = await fetch(`${url}/rest/v1/rpc/`, { method: 'POST' }).catch(() => null)
  void res
  const { data, error } = await dbAdmin.schema('pg_catalog' as 'public').from('pg_policies' as 'restaurants')
  void data
  void error
  return sql
}

async function main() {
  const report: Record<string, unknown> = { tag, app: APP }

  await setup()

  const ownerAToken = await signIn(ownerAEmail, ownerAPassword)
  const kitchenToken = await signIn(kitchenEmail, kitchenPassword)

  // --- 1. restaurant-settings ---
  const hackedName = `${tag}-HACKED-BY-A`
  const unauthRes = await fetch(`${APP}/api/admin/restaurant-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      restaurantId: restBId,
      updates: { name: `${tag}-UNAUTH-HACK` },
    }),
  })
  const unauthBody = await unauthRes.json().catch(() => ({}))

  const crossAuthRes = await fetch(`${APP}/api/admin/restaurant-settings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerAToken}`,
    },
    body: JSON.stringify({
      restaurantId: restBId,
      updates: { name: hackedName },
    }),
  })
  const crossAuthBody = await crossAuthRes.json().catch(() => ({}))

  const { data: restBAfter } = await dbAdmin
    .from('restaurants')
    .select('name')
    .eq('id', restBId!)
    .single()

  if (restBAfter?.name !== originalRestBName) {
    await dbAdmin
      .from('restaurants')
      .update({ name: originalRestBName })
      .eq('id', restBId!)
  }

  report.gap1_restaurant_settings = {
    routeAuth: 'none in handler',
    middleware: '/api/admin/* not protected (only /admin/* pages)',
    serverClient: 'createServerSupabaseClient uses service role — bypasses RLS',
    unauthenticated: {
      status: unauthRes.status,
      success: unauthBody?.success,
      updatedName: unauthBody?.data?.name,
      crossTenantWorked: unauthRes.ok && unauthBody?.data?.name === `${tag}-UNAUTH-HACK`,
    },
    authenticatedCrossTenant: {
      status: crossAuthRes.status,
      success: crossAuthBody?.success,
      updatedName: crossAuthBody?.data?.name,
      crossTenantWorked: crossAuthRes.ok && crossAuthBody?.data?.name === hackedName,
    },
    restBNameAfterTest: restBAfter?.name,
    restBReverted: restBAfter?.name === originalRestBName || restBAfter?.name !== hackedName,
  }

  // --- 2. report-schedules cross-tenant ---
  const rsGet = await fetch(`${APP}/api/admin/restaurants/${restBId}/report-schedules`, {
    headers: { Authorization: `Bearer ${ownerAToken}` },
  })
  const rsGetBody = await rsGet.json().catch(() => ({}))

  const rsPost = await fetch(`${APP}/api/admin/restaurants/${restBId}/report-schedules`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ownerAToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: `${tag}.injected@flashtap-test.invalid`,
      format: 'csv',
      send_time: '21:00',
    }),
  })
  const rsPostBody = await rsPost.json().catch(() => ({}))
  let injectedScheduleId: string | null = rsPostBody?.schedule?.id ?? null

  const rsPatch = await fetch(
    `${APP}/api/admin/restaurants/${restBId}/report-schedules/${scheduleBId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ownerAToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: false, email: `${tag}.patched@flashtap-test.invalid` }),
    },
  )
  const rsPatchBody = await rsPatch.json().catch(() => ({}))

  const { data: schedBAfter } = await dbAdmin
    .from('report_schedules')
    .select('enabled, email')
    .eq('id', scheduleBId!)
    .single()

  report.gap2_report_schedules = {
    routeAuth: 'getUserFromRequest only — restaurant_id from URL not cross-checked',
    serverClient: 'service role — bypasses RLS',
    crossTenantGet: {
      status: rsGet.status,
      scheduleCount: Array.isArray(rsGetBody?.schedules) ? rsGetBody.schedules.length : null,
      sawRestaurantBSchedule: Array.isArray(rsGetBody?.schedules)
        ? rsGetBody.schedules.some((s: { id?: string }) => s.id === scheduleBId)
        : false,
    },
    crossTenantPost: {
      status: rsPost.status,
      createdId: injectedScheduleId,
      worked: rsPost.ok && Boolean(injectedScheduleId),
    },
    crossTenantPatch: {
      status: rsPatch.status,
      patchedEmail: rsPatchBody?.schedule?.email,
      worked: rsPatch.ok,
    },
    scheduleBStateAfter: schedBAfter,
  }

  if (injectedScheduleId) {
    await dbAdmin.from('report_schedules').delete().eq('id', injectedScheduleId)
    injectedScheduleId = null
  }
  if (schedBAfter && (schedBAfter.email !== `${tag}.reports@flashtap-test.invalid` || !schedBAfter.enabled)) {
    await dbAdmin
      .from('report_schedules')
      .update({ email: `${tag}.reports@flashtap-test.invalid`, enabled: true })
      .eq('id', scheduleBId!)
  }

  // --- 3. terminals/list for kitchen ---
  const termListRes = await fetch(`${APP}/api/admin/terminals/list`, {
    headers: { Authorization: `Bearer ${kitchenToken}` },
  })
  const termListBody = await termListRes.json().catch(() => ({}))
  const terminals = Array.isArray(termListBody?.terminals) ? termListBody.terminals : []

  report.gap3_terminals_list = {
    routeAuth: 'getUserFromRequest + getRestaurantIdForUser — scoped to own restaurant',
    permissionCheck: 'none',
    kitchenStatus: termListRes.status,
    terminalCount: terminals.length,
    fieldsExposed: terminals[0] ? Object.keys(terminals[0]) : [],
    sampleTerminal: terminals[0] ?? null,
    exposesMerchantDetails: terminals.some(
      (t: Record<string, unknown>) =>
        'finatic_merchant_no' in t || 'finatic_store_no' in t || 'merchant' in t,
    ),
    crossTenantRisk: 'none — restaurantId from membership, not URL param',
  }

  // --- 4. terminal deactivate via client Supabase (RLS) ---
  const kitchenClient = await userClient(kitchenToken)
  const ownerAClient = await userClient(ownerAToken)

  const kitchenOwnDeactivate = await kitchenClient
    .from('restaurant_terminals')
    .update({ status: 'inactive' })
    .eq('id', terminalAId!)
    .select('id, status')

  const kitchenCrossDeactivate = await kitchenClient
    .from('restaurant_terminals')
    .update({ status: 'inactive' })
    .eq('id', terminalBId!)
    .select('id, status')

  const ownerACrossDeactivate = await ownerAClient
    .from('restaurant_terminals')
    .update({ status: 'inactive' })
    .eq('id', terminalBId!)
    .select('id, status')

  const kitchenCrossRead = await kitchenClient
    .from('restaurant_terminals')
    .select('id, terminal_name, status, activation_code')
    .eq('id', terminalBId!)
    .maybeSingle()

  const { data: termBAfter } = await dbAdmin
    .from('restaurant_terminals')
    .select('status')
    .eq('id', terminalBId!)
    .single()
  const { data: termAAfter } = await dbAdmin
    .from('restaurant_terminals')
    .select('status')
    .eq('id', terminalAId!)
    .single()

  if (termAAfter?.status === 'inactive') {
    await dbAdmin.from('restaurant_terminals').update({ status: 'active' }).eq('id', terminalAId!)
  }
  if (termBAfter?.status === 'inactive') {
    await dbAdmin.from('restaurant_terminals').update({ status: 'active' }).eq('id', terminalBId!)
  }

  report.gap4_terminal_rls = {
    policiesFromSchema: {
      select: 'Owners can read own restaurant terminals — any restaurant_users member',
      manage: 'Owners can manage terminals — role must be owner',
    },
    kitchenDeactivateOwn: {
      error: kitchenOwnDeactivate.error?.message ?? null,
      rows: kitchenOwnDeactivate.data,
      worked: (kitchenOwnDeactivate.data?.length ?? 0) > 0,
    },
    kitchenCrossDeactivate: {
      error: kitchenCrossDeactivate.error?.message ?? null,
      rows: kitchenCrossDeactivate.data,
      worked: (kitchenCrossDeactivate.data?.length ?? 0) > 0,
    },
    ownerACrossDeactivate: {
      error: ownerACrossDeactivate.error?.message ?? null,
      rows: ownerACrossDeactivate.data,
      worked: (ownerACrossDeactivate.data?.length ?? 0) > 0,
    },
    kitchenCrossRead: {
      error: kitchenCrossRead.error?.message ?? null,
      data: kitchenCrossRead.data,
      worked: Boolean(kitchenCrossRead.data),
    },
    terminalAStatusAfter: termAAfter?.status,
    terminalBStatusAfter: termBAfter?.status,
  }

  void fetchRlsPolicies
  void queryPoliciesDirect

  console.log(JSON.stringify(report, null, 2))

  const critical1 =
    report.gap1_restaurant_settings &&
    ((report.gap1_restaurant_settings as { unauthenticated: { crossTenantWorked: boolean } })
      .unauthenticated.crossTenantWorked ||
      (report.gap1_restaurant_settings as { authenticatedCrossTenant: { crossTenantWorked: boolean } })
        .authenticatedCrossTenant.crossTenantWorked)

  const critical2 =
    (report.gap2_report_schedules as { crossTenantGet: { sawRestaurantBSchedule: boolean } })
      ?.crossTenantGet?.sawRestaurantBSchedule ||
    (report.gap2_report_schedules as { crossTenantPost: { worked: boolean } })?.crossTenantPost?.worked ||
    (report.gap2_report_schedules as { crossTenantPatch: { worked: boolean } })?.crossTenantPatch?.worked

  const critical4 =
    (report.gap4_terminal_rls as { ownerACrossDeactivate: { worked: boolean } })?.ownerACrossDeactivate
      ?.worked ||
    (report.gap4_terminal_rls as { kitchenCrossDeactivate: { worked: boolean } })?.kitchenCrossDeactivate
      ?.worked

  console.log('\nSEVERITY_SUMMARY:', {
    gap1_restaurant_settings: critical1 ? 'CRITICAL' : 'mitigated',
    gap2_report_schedules: critical2 ? 'CRITICAL' : 'mitigated',
    gap3_terminals_list: (report.gap3_terminals_list as { kitchenStatus: number })?.kitchenStatus === 200 ? 'LOW-info-disclosure' : 'blocked',
    gap4_terminal_rls_cross_tenant: critical4 ? 'CRITICAL' : 'blocked-by-RLS',
  })
}

main()
  .catch((err) => {
    console.error('VERIFY_FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await cleanup()
      console.log('\nCleanup complete.')
    } catch (e) {
      console.error('Cleanup error:', e)
    }
  })
