// @ts-nocheck
/**
 * #347 — ANNOTATE, DO NOT REWRITE. Writes audit rows only. Changes no money status.
 *
 * RULED 2026-08-26, after the sweep came back a footnote: the three Digi Cofee orders are recorded
 * as paid with no payment behind them, and the correction is to say so on the record rather than to
 * rewrite the record. The owner's words: "annotate, do not rewrite" — the row stays as it was on the
 * day, and the correction is additive rather than a second rewrite of history by an automated
 * process, which is how it got here.
 *
 * WHAT IT WRITES: one `audit_logs` row per order, `payment.paid_stamp_not_a_settlement`.
 * WHAT IT DOES NOT WRITE: nothing on `orders`. Not payment_status, not paid_at, not status. If this
 * script ever needs to touch the orders table, it has stopped being the thing that was ruled.
 *
 * ============================================================================================
 * THE THREE ORDERS, AND WHY THESE THREE
 * ============================================================================================
 *
 * Digi Cofee #1 (N$3), #2 (N$3), #6 (N$30). Placed 2026-07-02, stamped paid 2026-07-17 08:30:23 —
 * all three at the same millisecond, 14.8 days later, by the pre-50f826f6 Close Table route which
 * bulk-wrote status/payment_status/paid_at/completed_at on every open order at a table with no
 * payment guard. None has a `payments` row, a `payment_events` row, a gateway reference or a
 * receipt. #1 additionally carries a `payment.failed` audit three minutes after it was placed.
 *
 * MINGLE #1 IS DELIBERATELY NOT HERE, and the owner asked for that to be checked rather than
 * inferred. It is the only affected order at a live venue, and it is NOT this mechanism:
 * `table_closed` is FALSE on it, and Close Table sets `is_closed` AND `table_closed` together — it
 * cannot have set one and not the other. It is also alone in its instant, has no `completed_at`, and
 * carries no merchant order number, where every other Mingle paid order has both. It is a separate
 * question about the manual card path and it gets its own issue, not a row from this script.
 *
 * ============================================================================================
 * PRECONDITIONS, RE-DERIVED HERE RATHER THAN TRUSTED FROM THE SWEEP
 * ============================================================================================
 *
 * The sweep ran earlier. Data moves. Every condition it relied on is checked again immediately
 * before the write, and any failure is a refusal rather than a warning:
 *
 *   1. exactly three orders match, at Digi Cofee, numbers 1/2/6
 *   2. each is still payment_status='paid' — if one has been corrected by hand since, annotating it
 *      as "still says paid" would be false
 *   3. each still has NO payments row, NO sale event and NO gateway reference
 *   4. each still shares the 2026-07-17T08:30:23.608Z instant
 *   5. none already carries this annotation — so a second run writes nothing rather than a duplicate
 *
 * Usage:
 *   node scripts/prod/annotate-347-paid-stamp-20260826.ts            dry run, verifies and stops
 *   node scripts/prod/annotate-347-paid-stamp-20260826.ts --confirm  writes the three rows
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const CONFIRM = process.argv.includes('--confirm')
const ACTION = 'payment.paid_stamp_not_a_settlement'
const EXPECTED_INSTANT = '2026-07-17T08:30:23.608+00:00'
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production, got ' + url)
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })

  console.log('='.repeat(94))
  console.log(CONFIRM ? 'THIS WRITES AUDIT ROWS TO PRODUCTION' : 'DRY RUN — verifies preconditions, writes nothing')
  console.log('='.repeat(94))
  console.log('  It inserts audit_logs rows ONLY. It never touches the orders table.')
  console.log('  connected to ' + url + '\n')

  const { data: venues } = await db.from('restaurants').select('id,name')
  const digi = (venues ?? []).find((v) => v.name === 'Digi Cofee')
  if (!digi) throw new Error('REFUSING: Digi Cofee not found')

  const { data: orders, error } = await db.from('orders')
    .select('id,order_number,total,payment_status,status,paid_at,completed_at,placed_at,' +
      'paycloud_merchant_order_no,paycloud_transaction_id,payment_trans_no,payment_voucher_no,payment_reference')
    .eq('restaurant_id', digi.id).in('order_number', [1, 2, 6]).order('order_number')
  if (error) throw new Error('orders: ' + error.message)

  const failures = []
  if ((orders ?? []).length !== 3) failures.push(`expected 3 orders, found ${(orders ?? []).length}`)

  // payments / sale events, re-read now
  const pays = []
  for (let f = 0; ; f += 1000) {
    const { data } = await db.from('payments').select('order_ids').range(f, f + 999)
    pays.push(...(data ?? [])); if (!data || data.length < 1000) break
  }
  const paidIds = new Set()
  for (const p of pays) for (const o of (p.order_ids ?? [])) paidIds.add(String(o))
  const { data: evs } = await db.from('payment_events').select('order_ids,event_type').limit(5000)
  const evIds = new Set()
  for (const e of (evs ?? [])) if (e.event_type === 'sale') for (const o of (e.order_ids ?? [])) evIds.add(String(o))

  const has = (o, k) => { const v = o[k]; return v !== null && v !== undefined && String(v).trim() !== '' }

  console.log('  PRECONDITIONS, re-derived now:')
  for (const o of orders ?? []) {
    const gw = has(o, 'paycloud_transaction_id') || has(o, 'payment_trans_no') ||
      has(o, 'payment_voucher_no') || has(o, 'paycloud_merchant_order_no') || has(o, 'payment_reference')
    const hasPay = paidIds.has(String(o.id))
    const hasEv = evIds.has(String(o.id))
    const instantOk = String(o.paid_at) === EXPECTED_INSTANT
    const ok = o.payment_status === 'paid' && !gw && !hasPay && !hasEv && instantOk
    console.log(`    #${pad(o.order_number, 3)} N$${pad(o.total, 6)} ${pad(o.payment_status, 8)}` +
      `paid_at=${pad(o.paid_at, 30)} gateway_ref=${gw ? 'YES' : 'no'} payments=${hasPay ? 'YES' : 'no'} ` +
      `sale_event=${hasEv ? 'YES' : 'no'} instant=${instantOk ? 'match' : 'MOVED'}  ${ok ? 'OK' : '*** FAILED ***'}`)
    if (o.payment_status !== 'paid') failures.push(`#${o.order_number} is now '${o.payment_status}', not 'paid' — do not annotate a row someone has already corrected`)
    if (gw) failures.push(`#${o.order_number} now carries a gateway reference — the premise no longer holds`)
    if (hasPay) failures.push(`#${o.order_number} now has a payments row — the premise no longer holds`)
    if (hasEv) failures.push(`#${o.order_number} now has a sale event — the premise no longer holds`)
    if (!instantOk) failures.push(`#${o.order_number} paid_at moved: ${o.paid_at}`)
  }

  // idempotency
  const ids = (orders ?? []).map((o) => String(o.id))
  const { data: existing } = await db.from('audit_logs')
    .select('id,entity_id').eq('action', ACTION).in('entity_id', ids)
  const already = new Set((existing ?? []).map((r) => String(r.entity_id)))
  console.log(`\n  already annotated: ${already.size} of ${ids.length}`)
  if (already.size === ids.length && ids.length > 0) {
    console.log('  Nothing to do — all three already carry this annotation. Exiting cleanly.')
    return
  }
  if (already.size > 0) {
    console.log('  PARTIAL: only the un-annotated ones will be written.')
  }

  if (failures.length) {
    console.log('')
    for (const f of failures) console.log(`  REFUSING: ${f}`)
    process.exitCode = 1
    return
  }

  console.log('\n  All preconditions hold.')
  if (!CONFIRM) {
    console.log('\n  DRY RUN. Nothing written. Re-run with --confirm.')
    return
  }

  const toWrite = (orders ?? []).filter((o) => !already.has(String(o.id)))
  const rows = toWrite.map((o) => ({
    restaurant_id: digi.id,
    entity_type: 'order',
    entity_id: String(o.id),
    action: ACTION,
    metadata: {
      issue: '#347',
      ruling: 'annotate, do not rewrite — 2026-08-26',
      finding:
        'This order is recorded as paid, and no payment was ever recorded against it. The paid_at ' +
        'stamp is not a settlement: it was written by the pre-50f826f6 Close Table route, which ' +
        'bulk-wrote status/payment_status/paid_at/completed_at on every open order at a table with ' +
        'no payment guard.',
      evidence: {
        paidAt: o.paid_at,
        placedAt: o.placed_at,
        daysBetween: Number(((new Date(o.paid_at) - new Date(o.placed_at)) / 86400000).toFixed(1)),
        sharedInstantWith: 'Digi Cofee orders 1, 2 and 6, to the millisecond',
        paymentsRow: false,
        saleEvent: false,
        gatewayReference: false,
        receipt: false,
      },
      moneyStatusChanged: false,
      note:
        'NOTHING ON THIS ORDER WAS MODIFIED. payment_status, paid_at and status are exactly as they ' +
        'were. This row records that the paid stamp is not evidence of a settlement, so that anyone ' +
        'reconciling this order later reads the correction beside the claim rather than having to ' +
        'rediscover it.',
      fixedForwardBy: '50f826f6 (2026-07-30) — Close Table no longer fabricates payment',
      sweep: 'scripts/prod/probe-347-close-table-sweep-20260826.ts',
    },
  }))

  const { error: insErr } = await db.from('audit_logs').insert(rows)
  if (insErr) throw new Error('insert: ' + insErr.message)
  console.log(`\n  wrote ${rows.length} audit row(s).`)

  // -------------------------------------------------------------- verify what landed
  const { data: after } = await db.from('audit_logs')
    .select('entity_id,action,created_at').eq('action', ACTION).in('entity_id', ids)
  console.log(`  VERIFIED: ${(after ?? []).length} of ${ids.length} orders now carry the annotation.`)

  const { data: unchanged } = await db.from('orders')
    .select('order_number,payment_status,paid_at,status').eq('restaurant_id', digi.id).in('order_number', [1, 2, 6]).order('order_number')
  console.log('\n  AND THE ORDERS ARE UNCHANGED, which is the point:')
  for (const o of unchanged ?? []) {
    console.log(`    #${pad(o.order_number, 3)} payment_status=${pad(o.payment_status, 8)} status=${pad(o.status, 11)} paid_at=${o.paid_at}`)
  }

  console.log('\nANNOTATE_347_OK')
}

main().catch((e) => { console.error('ABORTED:', e.message); process.exitCode = 1 })
