/**
 * ONE-OFF OPERATOR ACTION, 2026-08-21. FNB ChowNow's nine pending orders, N$1106.00.
 *
 *   #819  N$85   #840 N$165  #868 N$33   #876 N$7    #940 N$126
 *   #986  N$90   #999 N$340  #1012 N$140 #1013 N$120
 *
 * THIS IS NOT AN AUTOMATED DECISION AND MUST NOT BECOME ONE. The owner confirmed directly with
 * Finatic that none of these was charged, and authorised the cancel. The standing rule that E04111
 * alone never authorises a cancel (auto-cancel-stale-pos-orders.ts, removed gate, 2026-08-05) is
 * NOT overridden here — it is stepped around by a human who went to the gateway themselves. The
 * cron is unchanged and still cancels none of these on its own.
 *
 * WHY IT RE-QUERIES ANYWAY. Five of the nine (#940, #986, #999, #1012, #1013) were placed AFTER
 * that confirmation, so they are covered by this run's query and by nothing else. And #851 this
 * morning is the standing reminder that an order which looks abandoned can have cleared: it was
 * settled by the webhook fallback 3m41s before the terminal called it FAILED. So every order is
 * re-queried in the same run as the write, and any PAID answer skips the cancel outright.
 *
 * POSITIVE CONTROLS ARE MANDATORY. Nine identical E04111s is also exactly what a broken query looks
 * like. Known-paid FNB ChowNow card orders are queried in the same run on the same credentials; if
 * fewer than two come back PAID, this refuses to write anything at all.
 *
 * GATES, all re-asserted immediately before the write:
 *   - the id must be in TARGET_IDS (a fixed list; nothing is discovered at runtime)
 *   - the order must belong to FNB ChowNow
 *   - payment_status must still be 'pending' when read
 *   - Finatic must not answer PAID on the fresh query
 *   - the UPDATE itself re-asserts payment_status='pending' atomically, so a concurrent terminal
 *     callback wins the race rather than being blind-overwritten
 *
 * NOT REUSABLE BY DESIGN. Hard-coded ids, hard-coded restaurant, dated filename. It is committed as
 * the record of what touched production, following scripts/resolve-mingle-cluster-20260731.ts.
 *
 *   npx tsx --env-file=.env.local scripts/resolve-chownow-pending-20260821.ts          # dry run
 *   npx tsx --env-file=.env.local scripts/resolve-chownow-pending-20260821.ts --write  # writes
 */
import { createClient } from '@supabase/supabase-js'
import { queryFinaticOrderPaid } from '../lib/payments/query-finatic-order-paid'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url || !serviceKey) throw new Error('Missing production Supabase URL / service role key')
if (!url.includes('ihlmmpmolnpchzgwyhgh')) throw new Error(`REFUSING: not production — ${url}`)

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

const WRITE = process.argv.includes('--write')
const FNB_CHOWNOW = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const MERCHANT_NO = '342600131153'
const STORE_NO = '4426015803'

const CANCELLATION_REASON = 'operator_ruling_finatic_confirmed_unpaid_20260821'

const TARGET_IDS: readonly string[] = [
  '2564e364-53e3-4add-a13e-b74387aad84a', // #819  N$85
  'c568eaa5-c5da-46c2-836b-0518e8cb7d0c', // #840  N$165
  '5cd2c14d-65f5-4169-9376-fd8153795ec0', // #868  N$33   status 'ready' — FOOD WAS RELEASED
  'c9650fd8-e157-45a6-be77-5417cbe1f9a0', // #876  N$7
  'e006bd90-583c-43a2-a0a1-200384485d7f', // #940  N$126
  '7de7df5f-5074-4644-8121-ec17ff1451e6', // #986  N$90
  '13a7e8c3-f0d3-4190-863f-10e8dcafe864', // #999  N$340
  'ab1ea42e-cd15-4293-93c6-a04c46c4ce0e', // #1012 N$140
  '5a6a4568-a361-4a53-80e1-b222a9d5570c', // #1013 N$120
]

/** Known-paid FNB ChowNow CARD orders. Cash orders carry a reference but never reached the gateway. */
const CONTROLS: Array<[string, string]> = [
  ['#931 N$81', 'FT17872970116626363'],
  ['#930 N$47', 'FT17872969971668721'],
  ['#929 N$21', 'FT17872969590696083'],
]

type OrderRow = {
  id: string
  order_number: number | null
  total: number | null
  status: string
  payment_status: string
  restaurant_id: string
  paycloud_merchant_order_no: string | null
}

async function main() {
  const queriedAt = new Date().toISOString()
  console.log(`FNB ChowNow pending resolution — ${WRITE ? 'WRITE' : 'DRY RUN'} — ${queriedAt}\n`)

  // ---------------------------------------------------------------- controls
  console.log('POSITIVE CONTROLS (known-paid card orders, same credentials, this run)')
  let controlsPaid = 0
  for (const [label, mon] of CONTROLS) {
    try {
      const r = await queryFinaticOrderPaid({ merchantOrderNo: mon, merchantNo: MERCHANT_NO, storeNo: STORE_NO })
      console.log(`  ${label.padEnd(12)} ${r.paid ? 'PAID' : 'NOT_PAID'}  amount=${r.amount}`)
      if (r.paid) controlsPaid++
    } catch (e) {
      console.log(`  ${label.padEnd(12)} QUERY_FAILED ${(e instanceof Error ? e.message : String(e)).slice(0, 70)}`)
    }
  }
  if (controlsPaid < 2) {
    console.error(
      `\nREFUSING TO WRITE: only ${controlsPaid}/3 controls returned PAID. A run where the query ` +
        'path is not demonstrably working cannot distinguish "not charged" from "cannot ask".',
    )
    process.exitCode = 2
    return
  }
  console.log(`  -> ${controlsPaid}/3 PAID, query path confirmed working\n`)

  // ---------------------------------------------------------------- subjects
  const { data, error } = await admin
    .from('orders')
    .select('id, order_number, total, status, payment_status, restaurant_id, paycloud_merchant_order_no')
    .in('id', TARGET_IDS as string[])
  if (error) throw error
  const rows = (data ?? []) as OrderRow[]

  const cancelled: string[] = []
  const skipped: Array<{ label: string; why: string }> = []

  console.log('SUBJECTS (fresh gateway reading immediately before the write)')
  for (const id of TARGET_IDS) {
    const o = rows.find((r) => r.id === id)
    const label = o ? `#${o.order_number} N$${o.total}` : `(${id.slice(0, 8)})`

    if (!o) {
      skipped.push({ label, why: 'order row not found' })
      console.log(`  ${label.padEnd(14)} SKIP — row not found`)
      continue
    }
    if (o.restaurant_id !== FNB_CHOWNOW) {
      skipped.push({ label, why: 'not FNB ChowNow' })
      console.log(`  ${label.padEnd(14)} SKIP — wrong restaurant`)
      continue
    }
    if (o.payment_status !== 'pending') {
      skipped.push({ label, why: `payment_status is now '${o.payment_status}'` })
      console.log(`  ${label.padEnd(14)} SKIP — payment_status is now '${o.payment_status}'`)
      continue
    }
    if (!o.paycloud_merchant_order_no) {
      skipped.push({ label, why: 'no gateway reference to query' })
      console.log(`  ${label.padEnd(14)} SKIP — no gateway reference`)
      continue
    }

    let gatewayCode = 'UNKNOWN'
    let paid = false
    try {
      const r = await queryFinaticOrderPaid({
        merchantOrderNo: o.paycloud_merchant_order_no,
        merchantNo: MERCHANT_NO,
        storeNo: STORE_NO,
      })
      paid = Boolean(r.paid)
      gatewayCode = paid ? `PAID status=${r.status ?? ''} amount=${r.amount}` : 'NOT_PAID'
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      gatewayCode = /E04111/.test(m) ? 'E04111' : `QUERY_FAILED: ${m.slice(0, 60)}`
      if (!/E04111/.test(m)) {
        // Unreachable is not "not charged". Only an explicit E04111 or NOT_PAID proceeds.
        skipped.push({ label, why: gatewayCode })
        console.log(`  ${label.padEnd(14)} SKIP — ${gatewayCode}`)
        continue
      }
    }

    if (paid) {
      skipped.push({ label, why: `FINATIC SAYS PAID — ${gatewayCode}` })
      console.log(`  ${label.padEnd(14)} *** SKIP — FINATIC SAYS PAID *** ${gatewayCode}`)
      continue
    }

    console.log(`  ${label.padEnd(14)} ${gatewayCode} -> cancel`)
    if (!WRITE) continue

    // ---- the write. Existing shape: same columns cancelByIds sets, and the same atomic
    // re-assertion of payment_status='pending' so a concurrent callback wins the race.
    const { data: updated, error: updErr } = await admin
      .from('orders')
      .update({
        status: 'cancelled',
        payment_status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: CANCELLATION_REASON,
      })
      .eq('id', o.id)
      .eq('payment_status', 'pending')
      .select('id')
    if (updErr) throw updErr
    if (!updated || updated.length === 0) {
      skipped.push({ label, why: 'lost the race — payment_status changed during the run' })
      console.log(`  ${label.padEnd(14)} SKIP — lost the race, not cancelled`)
      continue
    }

    const foodReleased = o.status === 'ready'
    const { error: auditErr } = await admin.from('audit_logs').insert({
      restaurant_id: FNB_CHOWNOW,
      entity_type: 'order',
      entity_id: o.id,
      action: 'order.cancelled',
      metadata: {
        source: 'operator_ruling_20260821',
        automated: false,
        decisionBasis:
          'Operator confirmed directly with Finatic that this order was not charged, and authorised ' +
          'the cancellation. NOT an automated decision: the stale-order cron cancels none of these ' +
          'and is unchanged. E04111 alone does not authorise a cancel (ruling 2026-08-05).',
        gatewayCode,
        gatewayQueriedAt: queriedAt,
        businessOrderNo: o.paycloud_merchant_order_no,
        orderTotal: o.total,
        statusBeforeCancel: o.status,
        // #868: the kitchen released the food before the payment resolved. The cancelled row does
        // not capture that on its own, and it is a write-off rather than a tidy-up.
        foodReleased,
        ...(foodReleased
          ? {
              writeOff: true,
              writeOffAmount: o.total,
              writeOffNote:
                'Order reached status=ready, so the food was handed to the customer. Cancelling the ' +
                'row does not recover the stock or the cost — record as a write-off.',
            }
          : {}),
      },
    })
    if (auditErr) {
      console.error(`  ${label.padEnd(14)} !!! CANCELLED BUT AUDIT INSERT FAILED:`, auditErr.message)
    }
    cancelled.push(label + (foodReleased ? ' (FOOD RELEASED — WRITE-OFF)' : ''))
  }

  console.log(`\nCANCELLED (${cancelled.length}):`)
  for (const c of cancelled) console.log(`  ${c}`)
  console.log(`SKIPPED (${skipped.length}):`)
  for (const s of skipped) console.log(`  ${s.label} — ${s.why}`)
  if (!WRITE) console.log('\nDRY RUN — nothing was written. Re-run with --write.')
}

main().catch((e) => {
  console.error('ABORTED:', e)
  process.exitCode = 2
})
