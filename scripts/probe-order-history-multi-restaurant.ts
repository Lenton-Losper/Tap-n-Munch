/**
 * THE REPORTED BUG, BEFORE AND AFTER.
 *
 * flashtap.app/dashboard/order-history rendered "This account belongs to multiple restaurants.
 * Specify a restaurantId." to the account owner. This runs the SAME request against a server on
 * 26acbda (what production serves) and a server on this branch, and requires the first to refuse
 * and the second to answer.
 *
 * Without the baseline half this is just "the endpoint works" -- which would also print green if
 * the bug had never existed, and would tell you nothing about whether the fix is load-bearing.
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PASSWORD = process.env.STAGING_TEST_PASSWORD
const BRANCH_URL = process.env.BRANCH_URL || 'http://127.0.0.1:3210'
const BASELINE_URL = process.env.BASELINE_URL || 'http://127.0.0.1:3211'

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || !PASSWORD) {
  throw new Error('Missing staging env (source .env.test first)')
}
if (!SUPABASE_URL.includes('mdqjpxwczrhkxkbqatqa')) {
  throw new Error(`REFUSING: not staging -- ${SUPABASE_URL}`)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const MULTI_EMAIL = 'switcher-probe-multi@flashtap-test.invalid'
const BASE_RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const WINDOW = '&startDate=2026-08-01&endDate=2026-12-31'

let failures = 0
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!pass) failures++
}

async function main() {
  const auth = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } })
  const { data, error } = await auth.auth.signInWithPassword({
    email: MULTI_EMAIL,
    password: PASSWORD!,
  })
  if (error) throw error
  const token = data.session!.access_token

  const { data: user } = await db.from('users').select('id').eq('email', MULTI_EMAIL).maybeSingle()
  const { data: memberships } = await db
    .from('restaurant_users')
    .select('restaurant_id')
    .eq('user_id', user!.id)
    .is('deleted_at', null)
  check(
    'subject holds MORE THAN ONE restaurant (the condition that triggers the bug)',
    (memberships ?? []).length > 1,
    `${(memberships ?? []).length} memberships`,
  )

  // Park the session on the restaurant whose history we ask for, so the URL guard matches.
  await fetch(`${BRANCH_URL}/api/auth/select-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'restaurant', restaurantId: BASE_RESTAURANT }),
  })

  const path = `/api/orders/history?restaurantId=${BASE_RESTAURANT}${WINDOW}`

  const beforeRes = await fetch(`${BASELINE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const beforeBody = await beforeRes.text()

  const afterRes = await fetch(`${BRANCH_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const afterBody = await afterRes.text()

  console.log(`\nBASELINE 26acbda  HTTP ${beforeRes.status}  ${beforeBody.slice(0, 120)}`)
  console.log(`BRANCH   this      HTTP ${afterRes.status}  ${afterBody.slice(0, 120)}\n`)

  check(
    'BEFORE: production code REFUSES this request',
    beforeRes.status === 409,
    `HTTP ${beforeRes.status}`,
  )
  check(
    'BEFORE: and leaks the developer string the owner saw',
    beforeBody.includes('restaurantId'),
    beforeBody.slice(0, 90),
  )
  check('AFTER: the branch answers', afterRes.status === 200, `HTTP ${afterRes.status}`)
  check(
    'AFTER: and no customer-facing text contains "restaurantId"',
    !(afterBody.includes('"error"') && afterBody.includes('restaurantId')),
  )

  const parsed = JSON.parse(afterBody) as { orders?: unknown[] }
  check(
    'AFTER: real orders come back, not an empty success',
    Array.isArray(parsed.orders) && parsed.orders.length > 0,
    `${parsed.orders?.length ?? 0} orders`,
  )

  console.log(`\n${failures === 0 ? 'ORDER HISTORY FIXED -- refused before, answers now' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('PROBE ERROR:', e)
  process.exit(1)
})
