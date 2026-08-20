/**
 * #322 -- TWO-SIDED PROOF.
 *
 *   BEFORE_URL  a server WITHOUT the fix (deployed staging, 0e7800a)
 *   AFTER_URL   a server WITH it
 *
 * Both read the SAME staging database, so any difference is the code.
 *
 * Side 1 -- the failing window: BEFORE returns a zero-length 500, AFTER returns 200 with data
 *           that is CORRECT, not merely present. "200" alone would pass if the fix returned a
 *           truncated revenue figure, which is the failure mode worth more than the crash.
 * Side 2 -- the windows that already worked: byte-identical between BEFORE and AFTER.
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PASSWORD = process.env.STAGING_TEST_PASSWORD
const BEFORE_URL = process.env.BEFORE_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const AFTER_URL = process.env.AFTER_URL || 'http://127.0.0.1:3210'

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || !PASSWORD) {
  throw new Error('Missing staging env (source .env.test first)')
}
if (!SUPABASE_URL.includes('mdqjpxwczrhkxkbqatqa')) {
  throw new Error(`REFUSING: not staging -- ${SUPABASE_URL}`)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const PROBE_RESTAURANT = '1c0b95dc-7880-41c0-a2fa-580eaa0bfc9d'
const STAGING_TEST = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const EMAIL = 'switcher-probe-multi@flashtap-test.invalid'
const TAG = '__i322_probe__'

let failures = 0
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!pass) failures++
}

async function tokenFor(): Promise<string> {
  const auth = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } })
  const { data, error } = await auth.auth.signInWithPassword({ email: EMAIL, password: PASSWORD! })
  if (error) throw error
  return data.session!.access_token
}

async function hit(base: string, restaurantId: string, start: string, end: string, token: string) {
  const url =
    `${base}/api/orders/history?restaurantId=${restaurantId}` +
    `&startDate=${start}&endDate=${end}&cb=${Math.random()}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* leave as text */
  }
  return { status: res.status, len: text.length, body, text }
}

async function selectContext(base: string, token: string, restaurantId: string) {
  await fetch(`${base}/api/auth/select-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'restaurant', restaurantId }),
  })
}

async function main() {
  console.log(`BEFORE (no fix): ${BEFORE_URL}`)
  console.log(`AFTER  (fixed):  ${AFTER_URL}\n`)
  const token = await tokenFor()

  const { count: paidInWindow } = await db
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', PROBE_RESTAURANT)
    .eq('payment_status', 'paid')
    .gte('placed_at', '2026-05-01T00:00:00Z')
    .lt('placed_at', '2026-06-01T00:00:00Z')
  const truePaid = paidInWindow ?? 0
  const trueRevenue = Number((truePaid * 11.5).toFixed(2))

  console.log(`the failing window holds ${truePaid} paid orders (true revenue ${trueRevenue})\n`)
  check('the window is genuinely past the observed cliff (>620 paid orders)', truePaid > 620, String(truePaid))
  check('and past the 1000-row truncation point too', truePaid > 1000, String(truePaid))

  // ---------- Side 1: the failing window ----------
  console.log('\n--- Side 1: the window that crashes today ---')
  await selectContext(BEFORE_URL, token, PROBE_RESTAURANT)
  const before = await hit(BEFORE_URL, PROBE_RESTAURANT, '2026-05-01', '2026-05-31', token)
  check('BEFORE: zero-length 500', before.status === 500 && before.len === 0, `HTTP ${before.status}, ${before.len} bytes`)

  await selectContext(AFTER_URL, token, PROBE_RESTAURANT)
  const after = await hit(AFTER_URL, PROBE_RESTAURANT, '2026-05-01', '2026-05-31', token)
  check('AFTER: 200', after.status === 200, `HTTP ${after.status}`)

  const body = after.body as { totalOrders?: number; totalRevenue?: number; orders?: unknown[] }
  check(
    'AFTER: totalOrders is the TRUE count, not the 1000-row cap',
    body?.totalOrders === truePaid,
    `${body?.totalOrders} vs ${truePaid}`,
  )
  check(
    'AFTER: totalRevenue matches the true sum (not truncated)',
    Math.abs(Number(body?.totalRevenue ?? -1) - trueRevenue) < 0.01,
    `${body?.totalRevenue} vs ${trueRevenue}`,
  )
  check('AFTER: a page of orders came back', Array.isArray(body?.orders) && body!.orders!.length > 0,
    `${body?.orders?.length ?? 0} rows`)

  // ---------- The degradation guarantee ----------
  console.log('\n--- the blank-500 class is closed regardless of cause ---')
  const bogus = await hit(AFTER_URL, PROBE_RESTAURANT, 'not-a-date', '2026-05-31', token)
  const parsedBogus = typeof bogus.body === 'object' && bogus.body !== null
  check(
    'a malformed request still answers with JSON, never a zero-length body',
    bogus.len > 0 && parsedBogus,
    `HTTP ${bogus.status}, ${bogus.len} bytes`,
  )

  // ---------- Side 2: windows that already worked ----------
  console.log('\n--- Side 2: windows that work today must be byte-identical ---')
  const unchanged: [string, string, string, string][] = [
    ['staging test, August', STAGING_TEST, '2026-08-01', '2026-08-20'],
    ['staging test, single day', STAGING_TEST, '2026-08-19', '2026-08-19'],
    ['staging test, wide but small', STAGING_TEST, '2026-01-01', '2026-12-31'],
  ]
  for (const [label, restaurantId, start, end] of unchanged) {
    await selectContext(BEFORE_URL, token, restaurantId)
    const b = await hit(BEFORE_URL, restaurantId, start, end, token)
    await selectContext(AFTER_URL, token, restaurantId)
    const a = await hit(AFTER_URL, restaurantId, start, end, token)
    const same = b.status === a.status && b.text === a.text
    check(`${label} (${start}..${end})`, same,
      same ? `HTTP ${a.status}, ${a.len} bytes identical` : `${b.status}/${b.len}B -> ${a.status}/${a.len}B`)
    if (!same) {
      console.log(`      before: ${b.text.slice(0, 160)}`)
      console.log(`      after:  ${a.text.slice(0, 160)}`)
    }
  }

  // A window on the probe restaurant BELOW the cliff must also be untouched.
  const { data: few } = await db
    .from('orders')
    .select('id')
    .eq('restaurant_id', PROBE_RESTAURANT)
    .eq('customer_name', TAG)
    .limit(1)
  if (few && few.length) {
    await selectContext(BEFORE_URL, token, PROBE_RESTAURANT)
    const b = await hit(BEFORE_URL, PROBE_RESTAURANT, '2026-05-01', '2026-05-02', token)
    await selectContext(AFTER_URL, token, PROBE_RESTAURANT)
    const a = await hit(AFTER_URL, PROBE_RESTAURANT, '2026-05-01', '2026-05-02', token)
    check('probe restaurant, narrow window below the cliff', b.status === a.status && b.text === a.text,
      `HTTP ${a.status}, ${a.len} bytes`)
  }

  console.log(`\n${failures === 0 ? '#322 FIXED -- failing window correct, working windows unchanged' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('PROBE ERROR:', e.message)
  process.exit(1)
})
