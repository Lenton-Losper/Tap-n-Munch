/**
 * #322 -- REPRODUCE THE EMPTY 500 ON STAGING, then locate the threshold.
 *
 * Production returns HTTP 500 with a ZERO-LENGTH body from /api/orders/history once startDate
 * reaches far enough back. The route's own error paths return JSON, so the worker is dying rather
 * than an error being handled. Nothing is fixed from reading the code -- this seeds staging until
 * the same failure appears, so the mechanism can be named with evidence.
 *
 * WHAT SCALES WITH THE WINDOW is not the page (fixed at 20 rows via .range()) but the SUMMARY:
 *
 *   summaryQuery       -- every PAID order in the window, unpaginated
 *   getPaymentProjections(summaryOrderIds)
 *                      -- .overlaps('order_ids', <every one of those ids>)
 *
 * so the seed is paid orders in a known window, grown until it breaks.
 *
 * Run:  set -a; . ./.env.test; set +a
 *       node node_modules/tsx/dist/cli.mjs scripts/probe-322-order-history-boundary-staging.ts
 *       MODE=cleanup ... to remove every seeded row.
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const PASSWORD = process.env.STAGING_TEST_PASSWORD
const BASE_URL = process.env.PROBE_BASE_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const MODE = process.env.MODE || 'run'

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY || !PASSWORD) {
  throw new Error('Missing staging env (source .env.test first)')
}
if (!SUPABASE_URL.includes('mdqjpxwczrhkxkbqatqa')) {
  throw new Error(`REFUSING: not staging -- ${SUPABASE_URL}`)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

/** My own probe restaurant, so no shared staging fixture is polluted. */
const RESTAURANT = '1c0b95dc-7880-41c0-a2fa-580eaa0bfc9d'
const PROBE_EMAIL = 'switcher-probe-multi@flashtap-test.invalid'
/** Every seeded row carries this, so cleanup is exact. */
const TAG = '__i322_probe__'
const WINDOW_START = '2026-05-01'
const WINDOW_END = '2026-05-31'

async function token(): Promise<string> {
  const auth = createClient(SUPABASE_URL!, ANON_KEY!, { auth: { persistSession: false } })
  const { data, error } = await auth.auth.signInWithPassword({
    email: PROBE_EMAIL,
    password: PASSWORD!,
  })
  if (error) throw error
  return data.session!.access_token
}

async function seededCount(): Promise<number> {
  const { count } = await db
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', RESTAURANT)
    .eq('customer_name', TAG)
  return count ?? 0
}

async function seed(n: number, startingAt: number) {
  const rows = []
  for (let i = 0; i < n; i++) {
    const day = 1 + ((startingAt + i) % 30)
    rows.push({
      restaurant_id: RESTAURANT,
      order_number: 100000 + startingAt + i,
      table_number: 1,
      status: 'completed',
      payment_status: 'paid', // the summary query filters on this
      payment_method: 'card',
      subtotal: 10,
      tax: 1.5,
      total: 11.5,
      items: [{ name: 'Probe item', quantity: 1, price: 11.5 }],
      customer_name: TAG,
      placed_at: `2026-05-${String(day).padStart(2, '0')}T12:00:00.000Z`,
    })
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('orders').insert(rows.slice(i, i + 500))
    if (error) throw new Error(`seed insert failed: ${error.message}`)
  }
}

async function hit(t: string): Promise<{ status: number; len: number; snippet: string }> {
  const url =
    `${BASE_URL}/api/orders/history?restaurantId=${RESTAURANT}` +
    `&startDate=${WINDOW_START}&endDate=${WINDOW_END}&cb=${Math.random()}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } })
  const body = await res.text()
  return { status: res.status, len: body.length, snippet: body.slice(0, 120) }
}

async function cleanup() {
  const { error } = await db.from('orders').delete().eq('restaurant_id', RESTAURANT).eq('customer_name', TAG)
  if (error) throw error
  console.log('removed every seeded row; remaining:', await seededCount())
}

async function main() {
  if (MODE === 'cleanup') return cleanup()

  const t = await token()

  // The URL guard compares the requested restaurant to the session's resolved one.
  await fetch(`${BASE_URL}/api/auth/select-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ type: 'restaurant', restaurantId: RESTAURANT }),
  })

  console.log(`target ${BASE_URL}`)
  console.log(`window ${WINDOW_START}..${WINDOW_END}, restaurant ${RESTAURANT}\n`)

  const baseline = await hit(t)
  console.log(`seeded=${await seededCount()}  HTTP ${baseline.status}  len ${baseline.len}`)

  // Grow until it breaks. Steps chosen to bracket the production-like scale (~800 paid orders).
  const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 1000]
  let previous = 0
  for (const target of steps) {
    await seed(target - previous, previous)
    previous = target
    const r = await hit(t)
    const total = await seededCount()
    console.log(
      `seeded=${String(total).padStart(4)}  HTTP ${r.status}  len ${String(r.len).padStart(6)}  ${r.status !== 200 ? JSON.stringify(r.snippet) : ''}`,
    )
    if (r.status !== 200) {
      console.log(`\nREPRODUCED at ${total} paid orders in the window.`)
      console.log(`  status ${r.status}, body length ${r.len}`)
      console.log(`  zero-length body => the worker died rather than returning a handled error`)
      return
    }
  }
  console.log('\nNOT reproduced at 1000 paid orders -- the mechanism is not raw paid-order count.')
}

main().catch((e) => {
  console.error('PROBE ERROR:', e.message)
  process.exit(1)
})
