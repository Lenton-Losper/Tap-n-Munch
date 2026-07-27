/**
 * Staging verification for the Finatic-verified auto-cancel-stale-pos-orders change.
 *
 *   npx tsx scripts/verify-auto-cancel-finatic-check-staging.ts
 *
 * Exercises autoCancelStalePosOrders({ verifyWithFinatic: true }) end-to-end against
 * real staging DB rows, with only the external Finatic network call stubbed (via the
 * queryFinaticOrderPaidFn test seam) -- everything else (candidate selection, atomic
 * guards, markOrderPaidConfirmed's update/audit_logs/receipt/tab-recompute, the cancel
 * path) is the real production code path.
 *
 * Scenario A: no paycloud_merchant_order_no at all (genuinely abandoned) -- must cancel,
 *             Finatic must never be called for this row.
 * Scenario B: has paycloud_merchant_order_no, Finatic confirms paid -- must be corrected
 *             to paid (payment_status=paid, status=completed, audit_logs entry, receipt).
 * Scenario C: has paycloud_merchant_order_no, Finatic call throws (simulated unreachable)
 *             -- must be left untouched (still payment_status='pending'), not cancelled.
 */
import { createClient } from '@supabase/supabase-js'
import { autoCancelStalePosOrders } from '../lib/orders/auto-cancel-stale-pos-orders'
import type { FinaticOrderPaidResult } from '../lib/payments/query-finatic-order-paid'

const url = process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

const MERCHANT_ORDER_NO_PAID = 'FTVERIFYPAID0001'
const MERCHANT_ORDER_NO_UNREACHABLE = 'FTVERIFYUNRCH002'

async function main() {
  // ---- fixtures ----
  const { data: restaurant, error: restErr } = await admin
    .from('restaurants')
    .insert({
      name: 'civ-autocancel-probe',
      finatic_merchant_no: 'PROBE_MERCHANT',
      finatic_store_no: 'PROBE_STORE',
    })
    .select('id')
    .single()
  if (restErr) throw restErr
  const restaurantId = restaurant.id as string
  log('created throwaway restaurant', restaurantId)

  const stalePlacedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString() // 3 min ago > 2 min timeout

  const baseOrder = {
    restaurant_id: restaurantId,
    channel: 'pos' as const,
    status: 'pending',
    payment_status: 'pending',
    payment_method: 'card',
    subtotal: 25,
    tax: 0,
    total: 25,
    items: [],
    placed_at: stalePlacedAt,
    is_closed: true,
    table_number: 0,
  }

  const { data: orderA, error: aErr } = await admin
    .from('orders')
    .insert({ ...baseOrder, paycloud_merchant_order_no: null })
    .select('id')
    .single()
  if (aErr) throw aErr

  const { data: orderB, error: bErr } = await admin
    .from('orders')
    .insert({ ...baseOrder, paycloud_merchant_order_no: MERCHANT_ORDER_NO_PAID })
    .select('id')
    .single()
  if (bErr) throw bErr

  const { data: orderC, error: cErr } = await admin
    .from('orders')
    .insert({ ...baseOrder, paycloud_merchant_order_no: MERCHANT_ORDER_NO_UNREACHABLE })
    .select('id')
    .single()
  if (cErr) throw cErr

  log('fixtures', { orderA: orderA.id, orderB: orderB.id, orderC: orderC.id })

  const finaticCallLog: string[] = []
  const stubQueryFinaticOrderPaid = async (params: {
    merchantOrderNo: string
    merchantNo: string
    storeNo: string
  }): Promise<FinaticOrderPaidResult> => {
    finaticCallLog.push(params.merchantOrderNo)
    if (params.merchantOrderNo === MERCHANT_ORDER_NO_PAID) {
      return {
        paid: true,
        merchantOrderNo: params.merchantOrderNo,
        status: 'paid',
        transactionId: 'FINATIC-TXN-PROBE-0001',
        amount: 25,
        raw: { code: '0', trade_status: 'paid' },
      }
    }
    if (params.merchantOrderNo === MERCHANT_ORDER_NO_UNREACHABLE) {
      throw new Error('SIMULATED: PayCloud service unavailable (network failure)')
    }
    throw new Error(`unexpected merchantOrderNo in stub: ${params.merchantOrderNo}`)
  }

  try {
    const result = await autoCancelStalePosOrders(admin as any, {
      restaurantId,
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: stubQueryFinaticOrderPaid,
    })
    log('autoCancelStalePosOrders result', result)
    log('Finatic calls made (should be exactly [B, C], never A)', finaticCallLog)

    assert(finaticCallLog.length === 2, `Finatic should be called exactly twice (B and C), never for A -- got ${finaticCallLog.length} calls`)
    assert(finaticCallLog.includes(MERCHANT_ORDER_NO_PAID), 'Finatic should have been queried for order B')
    assert(finaticCallLog.includes(MERCHANT_ORDER_NO_UNREACHABLE), 'Finatic should have been queried for order C')

    const { data: freshA } = await admin.from('orders').select('*').eq('id', orderA.id).single()
    const { data: freshB } = await admin.from('orders').select('*').eq('id', orderB.id).single()
    const { data: freshC } = await admin.from('orders').select('*').eq('id', orderC.id).single()
    log('order A (no merchant_order_no) AFTER', freshA)
    log('order B (Finatic confirms paid) AFTER', freshB)
    log('order C (Finatic unreachable) AFTER', freshC)

    assert(freshA!.status === 'cancelled' && freshA!.payment_status === 'cancelled', 'Scenario A: order must be cancelled')
    assert(freshA!.cancellation_reason === 'auto_timeout', 'Scenario A: cancellation_reason must be auto_timeout')
    assert(result.cancelledIds.includes(orderA.id), 'Scenario A: must appear in cancelledIds')
    console.log('SCENARIO_A_ABANDONED_CANCELLED_OK')

    assert(freshB!.status === 'completed' && freshB!.payment_status === 'paid', 'Scenario B: order must be corrected to paid')
    assert(freshB!.payment_reference === MERCHANT_ORDER_NO_PAID, 'Scenario B: payment_reference must be the real Finatic reference')
    assert(freshB!.paid_at != null, 'Scenario B: paid_at must be set')
    assert(result.correctedToPaidIds.includes(orderB.id), 'Scenario B: must appear in correctedToPaidIds')
    assert(!result.cancelledIds.includes(orderB.id), 'Scenario B: must NOT appear in cancelledIds')

    const { data: auditRows } = await admin
      .from('audit_logs')
      .select('*')
      .eq('entity_id', orderB.id)
      .eq('action', 'payment.completed')
    log('order B audit_logs', auditRows)
    assert((auditRows?.length ?? 0) === 1, 'Scenario B: exactly one payment.completed audit_logs row')

    const { data: receiptRows } = await admin.from('receipt_documents').select('*').eq('order_id', orderB.id)
    log('order B receipt_documents', receiptRows)
    assert((receiptRows?.length ?? 0) === 1, 'Scenario B: a receipt must have been issued')
    console.log('SCENARIO_B_FINATIC_CONFIRMED_PAID_CORRECTED_OK')

    assert(freshC!.status === 'pending' && freshC!.payment_status === 'pending', 'Scenario C: order must be left untouched (still pending)')
    assert(freshC!.cancelled_at == null, 'Scenario C: must NOT have been cancelled')
    assert(!result.cancelledIds.includes(orderC.id), 'Scenario C: must NOT appear in cancelledIds')
    assert(!result.correctedToPaidIds.includes(orderC.id), 'Scenario C: must NOT appear in correctedToPaidIds')
    assert(result.skippedUncertainIds.includes(orderC.id), 'Scenario C: must appear in skippedUncertainIds')
    console.log('SCENARIO_C_FINATIC_UNREACHABLE_SKIPPED_NOT_CANCELLED_OK')

    console.log('\nVERIFY_AUTO_CANCEL_FINATIC_CHECK_STAGING_OK')
  } finally {
    await admin.from('audit_logs').delete().in('entity_id', [orderA.id, orderB.id, orderC.id])
    await admin.from('receipt_documents').delete().in('order_id', [orderA.id, orderB.id, orderC.id])
    await admin.from('orders').delete().in('id', [orderA.id, orderB.id, orderC.id])
    await admin.from('restaurants').delete().eq('id', restaurantId)
    console.log('\ncleanup done')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
