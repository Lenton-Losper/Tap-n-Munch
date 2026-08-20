/**
 * #323 -- PROVE THE EFFECT, NOT THE EXIT CODE.
 *
 * For each converted site, run it against a set that EXCEEDS 1000 rows and require the TRUE number.
 * A green scan only says the shape is right; it says nothing about whether the number is.
 *
 * The library functions are called in-process against staging, because they are not all reachable
 * over HTTP. The seeded set lives on the probe restaurant so no shared staging fixture is touched.
 *
 * Run:  set -a; . ./.env.test; set +a
 *       node node_modules/tsx/dist/cli.mjs scripts/probe-323-truncation-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { fetchAllRows } from '../lib/supabase/fetch-all-rows'

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('Missing staging env (source .env.test)')
if (!SUPABASE_URL.includes('mdqjpxwczrhkxkbqatqa')) {
  throw new Error(`REFUSING: not staging -- ${SUPABASE_URL}`)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const PROBE_RESTAURANT = '1c0b95dc-7880-41c0-a2fa-580eaa0bfc9d'
const TAG = '__i322_probe__'
const WINDOW_START = '2026-05-01T00:00:00Z'
const WINDOW_END = '2026-06-01T00:00:00Z'

let failures = 0
function check(label: string, pass: boolean, detail = '') {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`)
  if (!pass) failures++
}

async function main() {
  const { count: seeded } = await db
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', PROBE_RESTAURANT)
    .eq('customer_name', TAG)
  const trueTotal = seeded ?? 0
  console.log(`probe restaurant holds ${trueTotal} seeded orders\n`)
  check('the set genuinely exceeds the 1000-row cap', trueTotal > 1000, String(trueTotal))
  if (trueTotal <= 1000) {
    console.log('\nABORTING: without >1000 rows this proves nothing.')
    process.exit(1)
  }

  // ---- the shape that used to truncate, run directly ----
  console.log('--- the unpaginated shape, for comparison ---')
  const { data: unpaged } = await db
    .from('orders')
    .select('id')
    .eq('restaurant_id', PROBE_RESTAURANT)
    .eq('customer_name', TAG)
  check(
    'an unpaginated read still stops at exactly 1000 (the defect, unchanged in PostgREST)',
    (unpaged ?? []).length === 1000,
    `${(unpaged ?? []).length} rows`,
  )

  console.log('\n--- fetchAllRows returns the true set ---')
  const paged = await fetchAllRows<{ id: string }>(
    db.from('orders').select('id').eq('restaurant_id', PROBE_RESTAURANT).eq('customer_name', TAG),
    { label: 'probe' },
  )
  check('fetchAllRows returns every row', paged.length === trueTotal, `${paged.length} vs ${trueTotal}`)
  check('and no duplicates across page boundaries', new Set(paged.map((r) => r.id)).size === trueTotal)

  // ---- site 1: getReportData (nightly emails + exports) ----
  console.log('\n--- getReportData (nightly emails + CSV export) ---')
  // Takes ONE params object and builds its own service-role client -- passing a client as the
  // first argument silently shifted every field and produced "Restaurant not found", which would
  // have read as a real failure rather than a probe bug.
  const { getReportData } = await import('../lib/reports/get-report-data')
  const report = await getReportData({
    restaurantId: PROBE_RESTAURANT,
    startDate: '2026-05-01',
    endDate: '2026-05-31',
  })
  const reportOrders = (report as { orders?: unknown[] }).orders ?? []
  check(
    'the report carries every order, not 1000',
    reportOrders.length === trueTotal,
    `${reportOrders.length} vs ${trueTotal}`,
  )

  // ---- site 2: lib/supabase/orders.ts getOrders ----
  console.log('\n--- lib/supabase/orders.ts getOrders (849 on production, 85% of cap) ---')
  {
    const rows = await fetchAllRows<{ id: string }>(
      db.from('orders').select('id').eq('restaurant_id', PROBE_RESTAURANT),
      { label: 'getOrders-shape' },
    )
    const { count: allForRestaurant } = await db
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', PROBE_RESTAURANT)
    check(
      'the getOrders shape returns every order for the restaurant',
      rows.length === (allForRestaurant ?? -1),
      `${rows.length} vs ${allForRestaurant}`,
    )
  }

  // ---- site 3: analytics/orders-summary shape ----
  console.log('\n--- analytics/orders-summary (740 on production) ---')
  {
    const rows = await fetchAllRows<{ id: string }>(
      db
        .from('orders')
        .select('id')
        .eq('restaurant_id', PROBE_RESTAURANT)
        .eq('payment_status', 'paid'),
      { label: 'orders-summary-shape' },
    )
    const { count: paid } = await db
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', PROBE_RESTAURANT)
      .eq('payment_status', 'paid')
    check('every paid order is counted', rows.length === (paid ?? -1), `${rows.length} vs ${paid}`)
    check('and it is over the cap, so this is not a vacuous pass', (paid ?? 0) > 1000, String(paid))
  }

  // ---- site 4: terminal/orders shape ----
  console.log('\n--- terminal/orders (739 on production) ---')
  {
    const statuses = ['pending', 'confirmed', 'preparing', 'ready', 'completed']
    const rows = await fetchAllRows<{ id: string }>(
      db.from('orders').select('id').eq('restaurant_id', PROBE_RESTAURANT).in('status', statuses),
      { label: 'terminal-orders-shape' },
    )
    const { count: live } = await db
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', PROBE_RESTAURANT)
      .in('status', statuses)
    check('every live order is returned', rows.length === (live ?? -1), `${rows.length} vs ${live}`)
    check('and it is over the cap', (live ?? 0) > 1000, String(live))
  }

  // ---- the helper refuses to truncate rather than returning short ----
  console.log('\n--- the helper never returns a short set quietly ---')
  let threw = false
  try {
    await fetchAllRows<{ id: string }>(
      db.from('orders').select('id').eq('restaurant_id', PROBE_RESTAURANT),
      { label: 'ceiling-probe', maxRows: 500 },
    )
  } catch (e) {
    threw = e instanceof Error && /maxRows/.test(e.message)
  }
  check('exceeding maxRows THROWS instead of returning a truncated set', threw)

  void WINDOW_START
  void WINDOW_END
  console.log(`\n${failures === 0 ? '#323 PROVEN -- every converted shape returns the true count' : `${failures} CHECK(S) FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('PROBE ERROR:', e.message)
  process.exit(1)
})
