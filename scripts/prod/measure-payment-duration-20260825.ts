// @ts-nocheck
/**
 * READ ONLY. HOW LONG DOES A CARD PAYMENT ACTUALLY TAKE?
 *
 * The pill's ceiling has to be a real number or it is just a different lie. Two questions:
 *
 *   1. For payments that SETTLED, how long from payment_attempt_started_at to paid_at? That is
 *      what "usually done by now" means, and the ADVISORY ceiling on the pill must sit above the
 *      high percentile of it or staff will be told the payment is late while it is still normal.
 *
 *   2. What is the longest a payment has EVER taken and still succeeded? The HARD timeout must sit
 *      above that, because a timeout that fires on a payment which then succeeds turns a working
 *      sale into an unconfirmed one — the exact defect the timeout is meant to prevent.
 *
 * The two numbers are different and must not be conflated: the advisory ceiling is when to tell
 * the operator something, the hard timeout is when to stop waiting for the promise.
 */
import { config } from 'dotenv'
import { excludeStressFixtures } from '../../lib/orders/stress-fixtures'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production')
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })

  const { data: venues } = await db.from('restaurants').select('id,name')
  const byId = new Map((venues ?? []).map((v) => [v.id, v.name]))

  const rows = []
  for (let f = 0; ; f += 1000) {
    // #324 — exclude the stress fixtures. Measured read-only on production 2026-08-27, the
    // `payment_attempt_started_at IS NOT NULL` filter reaches 0 fixtures of 1,011 rows, because no
    // seeded row ever started a card attempt. That is a property of TODAY'S FILTER, not of the
    // table: drop the `.not(...)` for any reason and 1,314 rows arrive with a null attempt time
    // and a zero total, and every duration percentile below moves. The exclusion is what makes the
    // clean number a fact rather than a coincidence.
    const { data, error } = await excludeStressFixtures(
      db
        .from('orders')
        .select('restaurant_id,order_number,total,payment_status,payment_method,payment_attempt_started_at,paid_at,placed_at')
        .not('payment_attempt_started_at', 'is', null)
        .order('payment_attempt_started_at')
        .range(f, f + 999),
    )
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  console.log('orders that ever started a card attempt: ' + rows.length)

  const settled = rows.filter((o) => o.payment_status === 'paid' && o.paid_at)
  const durations = settled
    .map((o) => ({
      s: (new Date(o.paid_at).getTime() - new Date(o.payment_attempt_started_at).getTime()) / 1000,
      o,
    }))
    // A negative or absurd value means the two timestamps come from different clocks or the row
    // was backfilled. Excluded, and COUNTED, because silently dropping them would flatter the tail.
    .filter((d) => d.s >= 0 && d.s < 3600)
  const excluded = settled.length - durations.length
  durations.sort((a, b) => a.s - b.s)

  const pct = (p) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))].s : 0)

  console.log('\n' + '='.repeat(90))
  console.log('1. TIME TO SETTLE, for payments that SUCCEEDED   (n=' + durations.length + ', excluded ' + excluded + ')')
  console.log('='.repeat(90))
  if (durations.length) {
    console.log(
      '  p50 ' + pct(50).toFixed(0) + 's   p75 ' + pct(75).toFixed(0) +
        's   p90 ' + pct(90).toFixed(0) + 's   p95 ' + pct(95).toFixed(0) +
        's   p99 ' + pct(99).toFixed(0) + 's   MAX ' + durations[durations.length - 1].s.toFixed(0) + 's',
    )
    console.log('\n  the slowest ten that still succeeded — the hard timeout must clear these:')
    for (const d of durations.slice(-10).reverse()) {
      console.log(
        '    ' + d.s.toFixed(0).padStart(5) + 's   ' +
          (byId.get(d.o.restaurant_id) ?? '?').slice(0, 20).padEnd(21) +
          '#' + String(d.o.order_number).padEnd(6) + ' N$' + d.o.total,
      )
    }
    const buckets = [10, 20, 30, 45, 60, 90, 120, 180, 300]
    console.log('\n  cumulative share settled by:')
    let prev = 0
    for (const b of buckets) {
      const n = durations.filter((d) => d.s <= b).length
      const share = (100 * n) / durations.length
      console.log('    ' + String(b).padStart(4) + 's  ' + share.toFixed(1).padStart(5) + '%  ' +
        '#'.repeat(Math.round(share / 2)) + (share - prev > 0 ? '' : ''))
      prev = share
    }
  }

  console.log('\n' + '='.repeat(90))
  console.log('2. THE 42-SECOND WINDOW — where does the median re-ring fall on that curve?')
  console.log('='.repeat(90))
  if (durations.length) {
    const by42 = durations.filter((d) => d.s <= 42).length
    console.log('  ' + ((100 * by42) / durations.length).toFixed(1) + '% of successful payments have settled by 42s,')
    console.log('  so at the median re-ring the operator is right ' + (100 - (100 * by42) / durations.length).toFixed(1) +
      '% of the time that it has not settled YET — but it may still be about to.')
  }

  console.log('\nDURATION_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
