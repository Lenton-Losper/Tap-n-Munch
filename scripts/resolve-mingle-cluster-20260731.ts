/**
 * Manual production resolution for six Mingle orders reported PENDING on 2026-07-31:
 *   #102 (N$45.00, 10:03:24)  #101 (N$45.00, 10:02:10)  #95 (N$50.00, 08:46:57)
 *   #87  (N$77.00, 07:50:42)  #86  (N$32.00, 07:50:11)  #85 (N$32.00, 07:49:41)
 *
 * Same evidence standard and same refusal gates as scripts/resolve-mingle-81-20260730.ts
 * (#81), scripts/resolve-mingle-e04111-20260730.ts (#76/#69/#64) and the 2026-07-29 pass.
 * Read-only evidence gathered first by scripts/diagnose-mingle-cluster-20260731.ts, which
 * returned "MEETS E04111 no-attempt bar" for all six.
 *
 * This pass additionally validated the procedure's core assumption rather than assuming it
 * (scripts/diagnose-mingle-cluster-discriminator-20260731.ts): of the 13 payments that
 * SUCCEEDED at Mingle in the same window on the same POS card path, 13/13 set both
 * payment_reference and payment_voucher_no, and 0/13 left every marker null. So on this
 * restaurant, path and day, "no marker + E04111" reliably means no payment reached Finatic.
 * Merchant order numbers also showed the same -4..-6s allocation drift for paid and pending
 * alike, ruling out a rotated/stale merchant order number as an alternative explanation.
 *
 * Every gate is re-asserted immediately before the write, and the UPDATE itself re-asserts
 * pending/pending atomically, so a concurrent change cannot be blind-overwritten.
 *
 *   npx tsx --env-file=.env.local scripts/resolve-mingle-cluster-20260731.ts
 */
import { createClient } from '@supabase/supabase-js'
import { getRestaurantFinaticCredentials } from '../lib/payments/finatic-restaurant-credentials'
import { queryFinaticOrderPaid } from '../lib/payments/query-finatic-order-paid'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url || !serviceKey) throw new Error('Missing production Supabase URL / service role key')

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

const TARGET_IDS = [
  '59b70309-941c-482c-8985-4a86f2407292', // #102 N$45.00 FT17854850388180090
  '66cf23bc-4ce7-4d81-85bc-d10b39b2cd60', // #101 N$45.00 FT17854849503051868
  'b6b6d787-e1db-4414-a456-a690ebc551da', // #95  N$50.00 FT17854804362794252
  '69c7585c-cb58-483c-966e-d813d96edf5f', // #87  N$77.00 FT17854770466379656
  '6db49dac-fbd3-4b70-8ce7-f383d31b227c', // #86  N$32.00 FT17854770159520081
  '610fc787-ff5d-4a2b-a0f6-c6019882ceef', // #85  N$32.00 FT17854769867648461
]

const ORDER_COLS =
  'id, order_number, restaurant_id, status, payment_status, payment_reference, payment_voucher_no, ' +
  'payment_checkout_url, terminal_sn, terminal_status, paycloud_merchant_order_no, total, placed_at, ' +
  'cancellation_reason, cancelled_at'

const CORRECTION_REASON =
  'Order sat at payment_status=pending past the stale-POS timeout with paycloud_merchant_order_no allocated but no ' +
  'payment_reference/payment_voucher_no/payment_checkout_url/terminal_sn/terminal_status ever recorded, and audit_logs ' +
  'containing only payment.verification_uncertain markers (none at all for #95) -- no evidence a real WiseCashier payment ' +
  'launch ever reached Finatic. Confirmed via a fresh (not cached) Finatic order.query at resolution time returning E04111. ' +
  'One of a cluster of six POS card_manual orders at Mingle between 07:49 and 10:03 on 2026-07-31, interleaved with 13 ' +
  'payments on the identical path that SUCCEEDED in the same window -- so not an outage. The 13 successes were used as a ' +
  'control group to validate this procedure rather than assume it: 13/13 set both payment_reference and payment_voucher_no ' +
  'and 0/13 left every marker null, and merchant order numbers showed identical -4..-6s allocation drift for paid and ' +
  'pending alike, ruling out a stale/rotated merchant order number. Same pattern and same bar as #81, #76/#69/#64, the ' +
  '2026-07-29 pass (#61/#637/#681/#683/#706) and #46/#734. Tracked in #110; discriminator design in #88/#90/PR #89 ' +
  '(unmerged) will make this automatic once terminal-side attempt-started integration lands.'

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  const results: Array<Record<string, unknown>> = []

  for (const id of TARGET_IDS) {
    const { data: before, error: beforeErr } = await admin.from('orders').select(ORDER_COLS).eq('id', id).single()
    if (beforeErr || !before) {
      log(`order ${id} -- LOAD FAILED`, beforeErr?.message)
      results.push({ orderId: id, outcome: 'failed', error: beforeErr?.message })
      continue
    }

    if (before.payment_status !== 'pending' || before.status !== 'pending') {
      log(`order #${before.order_number} SKIPPED`, 'state changed since investigation, refusing')
      results.push({ orderId: id, orderNumber: before.order_number, outcome: 'skipped_state_changed', before })
      continue
    }
    if (
      before.payment_reference ||
      before.payment_voucher_no ||
      before.payment_checkout_url ||
      before.terminal_sn ||
      before.terminal_status
    ) {
      log(`order #${before.order_number} SKIPPED`, 'a payment/launch marker is present, refusing to treat as no-attempt')
      results.push({ orderId: id, orderNumber: before.order_number, outcome: 'skipped_marker_present', before })
      continue
    }
    if (!before.paycloud_merchant_order_no) {
      log(`order #${before.order_number} SKIPPED`, 'no paycloud_merchant_order_no to verify against Finatic')
      results.push({ orderId: id, orderNumber: before.order_number, outcome: 'skipped_no_merchant_order_no', before })
      continue
    }

    let finaticCode: string | null = null
    let finaticMsg: string | null = null
    try {
      const creds = await getRestaurantFinaticCredentials(String(before.restaurant_id))
      const result = await queryFinaticOrderPaid({
        merchantOrderNo: before.paycloud_merchant_order_no,
        merchantNo: creds.merchantNo,
        storeNo: creds.storeNo,
      })
      log(`order #${before.order_number} SKIPPED`, `Finatic returned a clean result, not E04111: ${JSON.stringify(result)}`)
      results.push({ orderId: id, orderNumber: before.order_number, outcome: 'skipped_finatic_has_record', before })
      continue
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!message.includes('E04111')) {
        log(`order #${before.order_number} SKIPPED`, `Finatic check failed with a different error, not E04111: ${message}`)
        results.push({ orderId: id, orderNumber: before.order_number, outcome: 'skipped_not_e04111', before, error: message })
        continue
      }
      finaticCode = 'E04111'
      finaticMsg = message
    }

    const cancelledAt = new Date().toISOString()
    const { data: claimed, error: updateError } = await admin
      .from('orders')
      .update({
        status: 'cancelled',
        payment_status: 'cancelled',
        cancelled_at: cancelledAt,
        cancellation_reason: 'no_payment_attempt_made',
      })
      .eq('id', id)
      .eq('payment_status', 'pending')
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (updateError) {
      log(`order #${before.order_number} UPDATE FAILED`, updateError.message)
      results.push({ orderId: id, orderNumber: before.order_number, outcome: 'failed', before, error: updateError.message })
      continue
    }
    if (!claimed) {
      log(`order #${before.order_number} SKIPPED`, 'claim failed -- state changed concurrently')
      results.push({ orderId: id, orderNumber: before.order_number, outcome: 'skipped_state_changed', before })
      continue
    }

    const { error: auditError } = await admin.from('audit_logs').insert({
      restaurant_id: before.restaurant_id,
      action: 'payment.cancelled',
      entity_type: 'order',
      entity_id: id,
      metadata: {
        amount: Number(before.total) || 0,
        businessOrderNo: before.paycloud_merchant_order_no,
        reason: 'no_payment_attempt_made',
        correctedManually: true,
        correctionReason: CORRECTION_REASON,
        finaticCode,
        finaticMessage: finaticMsg,
        reportedVia: 'live Mingle dashboard 2026-07-31',
        clusterOf: [102, 101, 95, 87, 86, 85],
      },
    })
    if (auditError) {
      console.error(`order #${before.order_number} audit_logs insert failed:`, auditError.message)
    }

    const { data: after } = await admin.from('orders').select(ORDER_COLS).eq('id', id).single()
    log(`order #${before.order_number} BEFORE`, before)
    log(`order #${before.order_number} AFTER`, after)
    results.push({ orderId: id, orderNumber: before.order_number, outcome: 'resolved_no_payment_attempt_made', before, after })
  }

  log('SUMMARY', results.map((r) => ({ orderNumber: r.orderNumber, outcome: r.outcome })))
}

main().catch((e) => { console.error(e); process.exit(1) })
