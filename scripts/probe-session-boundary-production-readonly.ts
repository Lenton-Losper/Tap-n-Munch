/**
 * THE SESSION BOUNDARY, on production, read-only. WHICH FIX IS POSSIBLE?
 *
 * THE QUESTION AS ASKED was "how many orders have a session_id with no customer_sessions row".
 * THAT QUESTION IS MALFORMED, and the measurement is the reason: `customer_sessions` has NO
 * `session_id` column. Its columns are
 *
 *     id, token, tab_id, table_id, restaurant_id, session_version, active, created_at,
 *     last_seen_at, expires_at
 *
 * It is keyed by TOKEN. There is no join from `orders.session_id` to it, so "orders whose session
 * row is missing" is not a thing that can be counted — every order would qualify, for the trivial
 * reason that the relationship does not exist. A filter of that shape was never available.
 *
 * SO THIS MEASURES WHAT ACTUALLY DECIDES THE FIX:
 *
 *   1. `orders.table_closed` / `orders.is_closed` — a boundary marker that ALREADY EXISTS and is
 *      already respected by lib/orders/active-order-visibility.ts. The My Orders read simply does
 *      not apply it. How many production orders carry it?
 *   2. `order_requests` has NEITHER column. How many requests sit on a table that has since been
 *      closed? Those cannot be excluded by any existing marker, which is the half that needs a
 *      stamped session version.
 *   3. How far `restaurant_tables.current_session_version` has actually moved, i.e. whether
 *      closures happen at all in practice.
 *
 * STRICTLY READ-ONLY. Selects only, no fixture, no writes.
 */
/**
 * #324 — THE THREE `orders` COUNTS BELOW NOW EXCLUDE THE STRESS FIXTURES, AND ONE OF THEM WAS
 * REPORTING A NUMBER THAT WAS 96.8% DEBRIS.
 *
 * Measured read-only on production 2026-08-27, this file's own three counts:
 *
 *     orders total          3522 raw ->  2208 real   (1314 fixtures, 37.3%)
 *     orders table_closed   1358 raw ->    44 real   (1314 fixtures, 96.8%)
 *     orders is_closed      3520 raw ->  2206 real   (1314 fixtures, 37.3%)
 *
 * The middle line is the point. `table_closed = true` was being reported as 1,358 when the marker
 * is actually carried by FORTY-FOUR real orders, because every one of the 1,314 seeded fixtures
 * carries it. 1358 is the same poisoned denominator that made `measure-customer-wait` conclude
 * "only 43 of 1358 QR orders carry a session_id" and blame the instrumentation; on the real
 * population it is 43 of 44.
 *
 * That is not a rounding error in a background statistic -- question 1 above is "is this marker
 * widely enough carried to build the fix on?", and 1,358 and 44 are different answers to it.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { excludeStressFixtures } from '../lib/orders/stress-fixtures'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: ${url || '(unset)'} is not the production project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

async function main() {
  console.log('\nPRODUCTION — the session boundary, read-only\n')

  const { data: ctl, error: ctlErr } = await admin.from('orders').select('id').limit(1)
  if (ctlErr) throw new Error(`control read failed: ${ctlErr.message}`)
  console.log(`  [control] orders is readable and non-empty : ${ctl?.length ? 'YES' : 'NO — nothing below is meaningful'}`)

  // 1. the marker that already exists on orders
  const counts = {}
  for (const [label, q] of [
    [
      'orders total (real)',
      excludeStressFixtures(admin.from('orders').select('id', { count: 'exact', head: true })),
    ],
    [
      'orders table_closed = true (real)',
      excludeStressFixtures(
        admin.from('orders').select('id', { count: 'exact', head: true }).eq('table_closed', true),
      ),
    ],
    [
      'orders is_closed = true (real)',
      excludeStressFixtures(
        admin.from('orders').select('id', { count: 'exact', head: true }).eq('is_closed', true),
      ),
    ],
    ['order_requests total', admin.from('order_requests').select('id', { count: 'exact', head: true })],
  ]) {
    const { count, error } = await q
    counts[label] = error ? `ERROR ${error.message}` : count
  }
  console.log('\n  THE MARKER THAT ALREADY EXISTS (orders only)')
  for (const [k, v] of Object.entries(counts)) console.log(`    ${String(v).padStart(7)}  ${k}`)

  // 2. requests sitting on a table that has been closed at least once
  const { data: tables } = await admin
    .from('restaurant_tables')
    .select('id, current_session_version')
  const moved = new Set(
    (tables ?? []).filter((t) => Number(t.current_session_version) > 1).map((t) => String(t.id)),
  )
  console.log(`\n  TABLES THAT HAVE BEEN CLOSED AT LEAST ONCE : ${moved.size} of ${tables?.length ?? 0}`)
  console.log('    (current_session_version > 1 — a table that has never been reset sits at 1)')

  const { data: reqs } = await admin
    .from('order_requests')
    .select('id, table_id, status, placed_at')
    .limit(2000)
  const onMoved = (reqs ?? []).filter((r) => moved.has(String(r.table_id)))
  console.log(`\n  ORDER_REQUESTS ON A TABLE THAT HAS BEEN CLOSED : ${onMoved.length} of ${reqs?.length ?? 0}`)
  console.log('    order_requests carries NEITHER table_closed NOR is_closed, so nothing existing')
  console.log('    can exclude these. This is the half that needs a stamped session version.')

  const byStatus = {}
  for (const r of onMoved) byStatus[String(r.status)] = (byStatus[String(r.status)] || 0) + 1
  for (const [k, v] of Object.entries(byStatus)) console.log(`      ${String(v).padStart(5)}  ${k}`)

  console.log(
    '\n  READ IT THIS WAY: whatever `orders.table_closed` covers can be fixed by APPLYING an\n' +
      '  existing predicate. Whatever sits in order_requests on a closed table cannot, and needs\n' +
      '  a boundary stamped at insert. If the second number is zero on production today, the\n' +
      '  cheap half is still worth shipping — but it is not the whole boundary.',
  )
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
