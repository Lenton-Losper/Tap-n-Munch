/**
 * HOW LONG HAS ANYTHING BEEN WAITING FOR THE RESTAURANT? — production, strictly read-only.
 *
 * A customer click test found an order reading "Waiting for restaurant" three hours after it was
 * placed. Two explanations, and they need separating by MEASUREMENT rather than argument:
 *
 *   REAL     staff never pressed Accept or Decline. The status is the truth.
 *   STUCK    something moved it into a state nothing moves it out of, and the customer is
 *            watching a screen that will never change.
 *
 * WHAT THE CODE ALREADY SAYS, measured before this probe was written:
 *   - `order_requests.status` is written by exactly four places, all human-driven:
 *       app/api/order-requests/[requestId]/accept   (staff)  waiting_review -> accepting -> accepted
 *       app/api/order-requests/[requestId]/decline  (staff)  -> declined
 *       app/api/order-requests/[requestId]/review   (staff)  edits the items
 *       app/api/orders/route.ts                     (customer) the INSERT
 *   - the every-2-minutes cron (app/api/cron/cleanup-stale-orders) sweeps `orders` ONLY:
 *       autoCancelStalePosOrders   orders, channel='pos',     payment_status='pending'
 *       expireHostedPendingOrders  orders, payment_channel='hosted', payment_status='pending'
 *     Neither reads `order_requests` at all.
 *
 * So there is no timeout and no escalation on an unaccepted request. This probe establishes what
 * that means in practice on real data: the age distribution, and whether anything is sitting in
 * `accepting` — the CLAIMED-but-unfinished state, which would be stuck in the stronger sense.
 *
 * STRICTLY READ-ONLY. Three `.select()` calls. No insert, update, delete or rpc; no fixture is
 * seeded. Production is not a test environment. Refuses to run unless SUPABASE_URL is the
 * production project.
 *
 *   npx tsx scripts/probe-waiting-review-age-production-readonly.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(PRODUCTION_REF)) {
  throw new Error(
    'REFUSING: this probe is for PRODUCTION and SUPABASE_URL is not the production project.\n' +
      `  wanted a URL containing ${PRODUCTION_REF}, got: ${url || '(unset)'}`,
  )
}
if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const admin = createClient(url, key, { auth: { persistSession: false } })

const HOUR = 60 * 60 * 1000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

function bucket(ms: number): string {
  const h = ms / HOUR
  if (h < 1) return '< 1h'
  if (h < 3) return '1-3h'
  if (h < 12) return '3-12h'
  if (h < 24) return '12-24h'
  if (h < 24 * 7) return '1-7d'
  return '> 7d'
}

async function main() {
  console.log('\nPRODUCTION — unaccepted order_requests, read-only\n')

  /**
   * THE CONTROL FIRST. If this read returns nothing at all, every "no stale rows" conclusion below
   * is indistinguishable from a broken query, a renamed column or an empty table.
   */
  const { data: any1, error: e0 } = await admin
    .from('order_requests')
    .select('id')
    .limit(1)
  if (e0) throw new Error(`control read failed: ${e0.message}`)
  console.log(`  [control] order_requests is readable and non-empty : ${any1?.length ? 'YES' : 'NO — nothing below is meaningful'}`)

  const { data: waiting, error: e1 } = await admin
    .from('order_requests')
    .select('id, status, placed_at, restaurant_id, table_number, total')
    .in('status', ['waiting_review', 'accepting'])
    .order('placed_at', { ascending: true })
  if (e1) throw new Error(`waiting read failed: ${e1.message}`)

  const rows = waiting ?? []
  console.log(`  open (waiting_review or accepting)                 : ${rows.length}`)

  if (rows.length === 0) {
    console.log('\n  Nothing open right now. The control above is what makes that meaningful.')
    return
  }

  const now = Date.now()
  const buckets: Record<string, number> = {}
  let stuckAccepting = 0
  let oldestMs = 0
  for (const r of rows) {
    const t = Date.parse(String(r.placed_at ?? ''))
    const age = Number.isFinite(t) ? now - t : NaN
    const b = Number.isFinite(age) ? bucket(age) : 'unparseable placed_at'
    buckets[b] = (buckets[b] || 0) + 1
    if (Number.isFinite(age) && age > oldestMs) oldestMs = age
    if (String(r.status) === 'accepting') stuckAccepting += 1
  }

  console.log('\n  AGE OF WHAT IS OPEN')
  for (const [b, n] of Object.entries(buckets).sort()) {
    console.log(`    ${String(n).padStart(5)}  ${b}`)
  }
  console.log(`\n  oldest open request                                : ${(oldestMs / HOUR).toFixed(1)}h`)
  console.log(`  in 'accepting' (claimed, never finished)           : ${stuckAccepting}`)

  /**
   * OLDER THAN THREE HOURS is the click test's own threshold. Listed rather than counted, because
   * "there are 14" and "here are 14, the oldest from June" are different findings.
   */
  const old = rows.filter((r) => {
    const t = Date.parse(String(r.placed_at ?? ''))
    return Number.isFinite(t) && now - t > 3 * HOUR
  })
  console.log(`\n  OPEN LONGER THAN 3 HOURS: ${old.length}`)
  for (const r of old.slice(0, 15)) {
    const t = Date.parse(String(r.placed_at ?? ''))
    console.log(
      `    ${((now - t) / HOUR).toFixed(1).padStart(7)}h  ${String(r.status).padEnd(14)} ` +
        `table ${String(r.table_number ?? '?').padEnd(5)} N$${r.total}  ${r.id}`,
    )
  }
  if (old.length > 15) console.log(`    … and ${old.length - 15} more`)

  console.log(
    '\n  There is no timeout and no escalation on an unaccepted request: the cron sweeps\n' +
      '  `orders` only (pos + hosted), and every writer of order_requests.status is a human\n' +
      '  action. Whatever is listed above will stay there until staff act, or forever.',
  )
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
