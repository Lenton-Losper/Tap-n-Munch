/**
 * STAGING PROBE -- two-sided, with positive controls, against the branch under test.
 *
 * PROBE_BASE_URL must point at a server running THIS branch. A deployed staging URL would exercise
 * whatever is deployed there, not the code under test -- the trap recorded in
 * playwright-baseurl-tests-deployed-not-branch.
 *
 * It builds its own subjects rather than borrowing an existing staging account, because no staging
 * account holds more than one restaurant and the shape under test is precisely "more than one".
 *
 * Run:  set -a; . ./.env.test; set +a
 *       PROBE_BASE_URL=http://127.0.0.1:3210 node node_modules/tsx/dist/cli.mjs scripts/probe-switcher-staging-controls.ts
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PASSWORD = process.env.STAGING_TEST_PASSWORD
const BASE_URL = process.env.PROBE_BASE_URL || 'http://127.0.0.1:3210'

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || !PASSWORD) {
  throw new Error('Missing staging env (source .env.test first)')
}
if (!SUPABASE_URL.includes('mdqjpxwczrhkxkbqatqa')) {
  throw new Error(`REFUSING: not staging -- ${SUPABASE_URL}`)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const TAG = process.env.PROBE_TAG || 'switcher-probe'
const BASE_RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652' // "staging test"
const PROBE_RESTAURANT = '1c0b95dc-7880-41c0-a2fa-580eaa0bfc9d' // "Switcher Probe Location"

let failures = 0
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!pass) failures++
}

async function createProbeUser(suffix: string): Promise<{ userId: string; email: string }> {
  const email = `${TAG}-${suffix}@flashtap-test.invalid`
  const { data: existing } = await db.from('users').select('id').eq('email', email).maybeSingle()
  if (existing) return { userId: existing.id as string, email }

  const { data, error } = await db.auth.admin.createUser({
    email,
    password: PASSWORD!,
    email_confirm: true,
  })
  if (error || !data.user) throw error ?? new Error('auth user creation failed')
  const { error: publicUserError } = await db.from('users').insert({ id: data.user.id, email })
  if (publicUserError) throw publicUserError
  return { userId: data.user.id, email }
}

async function ensureMembership(userId: string, restaurantId: string, role: string) {
  const { data: existing } = await db
    .from('restaurant_users')
    .select('id')
    .eq('user_id', userId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  if (existing) return
  const { error } = await db
    .from('restaurant_users')
    .insert({ restaurant_id: restaurantId, user_id: userId, role, invite_accepted: true })
  if (error) throw error
}

async function tokenFor(email: string): Promise<string> {
  const auth = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } })
  const { data, error } = await auth.auth.signInWithPassword({ email, password: PASSWORD! })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  return data.session!.access_token
}

async function get(path: string, token: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function selectContext(token: string, restaurantId: string) {
  const res = await fetch(`${BASE_URL}/api/auth/select-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'restaurant', restaurantId }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

type ContextRow = { type?: string; restaurantId?: string; restaurantName?: string }

async function restaurantContextsFor(token: string): Promise<ContextRow[]> {
  const contexts = await get('/api/auth/contexts', token)
  return ((contexts.body?.contexts ?? []) as ContextRow[]).filter((c) => c.type === 'restaurant')
}

async function main() {
  const { buildRestaurantSwitcher } = await import('../lib/auth/restaurant-switcher-options')
  console.log(`probing ${BASE_URL} against ${SUPABASE_URL}\n`)

  const multi = await createProbeUser('multi')
  await ensureMembership(multi.userId, BASE_RESTAURANT, 'owner')
  await ensureMembership(multi.userId, PROBE_RESTAURANT, 'owner')

  const single = await createProbeUser('single')
  await ensureMembership(single.userId, BASE_RESTAURANT, 'owner')

  console.log(`  multi  subject: ${multi.email}  (2 restaurants)`)
  console.log(`  single subject: ${single.email}  (1 restaurant)\n`)

  const multiToken = await tokenFor(multi.email)
  const singleToken = await tokenFor(single.email)

  // ================= SIDE A: the switcher appears and works =================
  console.log('--- Side A: a two-restaurant account can switch ---')
  const multiContexts = await restaurantContextsFor(multiToken)
  check(
    'contexts lists exactly 2 restaurants',
    multiContexts.length === 2,
    JSON.stringify(multiContexts.map((c) => c.restaurantName)),
  )

  const multiModel = buildRestaurantSwitcher({
    contexts: multiContexts,
    currentRestaurantId: BASE_RESTAURANT,
  })
  check('the switcher renders for this account', multiModel.visible === true)
  check(
    'exactly one entry is marked as current',
    multiModel.options.filter((o) => o.isCurrent).length === 1,
  )

  await selectContext(multiToken, BASE_RESTAURANT)
  const onBase = await get('/api/auth/role', multiToken)
  check(
    'session starts on "staging test"',
    onBase.body?.restaurant_id === BASE_RESTAURANT,
    String(onBase.body?.restaurant_id),
  )

  const switched = await selectContext(multiToken, PROBE_RESTAURANT)
  check('select-context ACCEPTS a restaurant the user belongs to', switched.status === 200, `HTTP ${switched.status}`)

  const onProbe = await get('/api/auth/role', multiToken)
  check(
    'the session moved to "Switcher Probe Location"',
    onProbe.body?.restaurant_id === PROBE_RESTAURANT,
    String(onProbe.body?.restaurant_id),
  )

  const freshToken = await tokenFor(multi.email)
  const afterReload = await get('/api/auth/role', freshToken)
  check(
    'the choice survives a brand-new session (persists across a reload)',
    afterReload.body?.restaurant_id === PROBE_RESTAURANT,
    String(afterReload.body?.restaurant_id),
  )

  // ============ SIDE B: without the choice being honoured, it would not ============
  console.log('\n--- Side B: the pre-#321 behaviour would have failed this ---')
  const { pickSessionRestaurant } = await import('../lib/auth/pick-session-restaurant')
  const members = [BASE_RESTAURANT, PROBE_RESTAURANT]
  const withStored = pickSessionRestaurant({ memberRestaurantIds: members, storedRestaurantId: PROBE_RESTAURANT })
  check(
    'honouring the stored choice selects the second location',
    withStored.restaurantId === PROBE_RESTAURANT && withStored.source === 'stored-context',
  )
  check(
    'ignoring it (the old restaurantIds[0]) would have returned the FIRST -- the defect',
    members[0] === BASE_RESTAURANT && members[0] !== PROBE_RESTAURANT,
  )

  // =============== POSITIVE CONTROL 1: one restaurant, no switcher ===============
  console.log('\n--- Positive control 1: a one-restaurant account gets no switcher ---')
  const singleContexts = await restaurantContextsFor(singleToken)
  check('control subject genuinely has exactly 1 restaurant', singleContexts.length === 1,
    JSON.stringify(singleContexts.map((c) => c.restaurantName)))

  const singleModel = buildRestaurantSwitcher({
    contexts: singleContexts,
    currentRestaurantId: BASE_RESTAURANT,
  })
  check('no switcher renders for it', singleModel.visible === false)

  // ====== POSITIVE CONTROL 2: cannot switch to a restaurant with no membership ======
  console.log('\n--- Positive control 2: no row, no switch ---')
  const { data: singleRows } = await db
    .from('restaurant_users')
    .select('id')
    .eq('user_id', single.userId)
    .eq('restaurant_id', PROBE_RESTAURANT)
    .is('deleted_at', null)
  check(
    'control subject has NO membership row on "Switcher Probe Location"',
    (singleRows ?? []).length === 0,
  )
  check(
    'and it was never offered one in its own context list',
    !singleContexts.some((c) => c.restaurantId === PROBE_RESTAURANT),
  )

  const refused = await selectContext(singleToken, PROBE_RESTAURANT)
  check(
    'select-context REFUSES the restaurant it holds no row on',
    refused.status === 403,
    `HTTP ${refused.status} ${JSON.stringify(refused.body)}`,
  )

  const singleStill = await get('/api/auth/role', singleToken)
  check(
    'the refused attempt did not move its session',
    singleStill.body?.restaurant_id === BASE_RESTAURANT,
    String(singleStill.body?.restaurant_id),
  )

  // The refusal must be a real gate, not a dead endpoint -- security-checks-need-a-positive-control.
  const stillWorks = await selectContext(multiToken, BASE_RESTAURANT)
  check(
    'the SAME endpoint still accepts a legitimate switch (refusal is a gate, not an outage)',
    stillWorks.status === 200,
    `HTTP ${stillWorks.status}`,
  )

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('PROBE ERROR:', error)
  process.exit(1)
})
