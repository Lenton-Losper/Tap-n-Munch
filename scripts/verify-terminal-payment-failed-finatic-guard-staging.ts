/**
 * Staging verification: terminal payment-failure callback must Finatic-verify before cancel.
 *
 *   npx tsx scripts/verify-terminal-payment-failed-finatic-guard-staging.ts
 *
 * Exercises handleTerminalPaymentFailed against real staging DB rows; only the
 * external Finatic network call is stubbed (queryFinaticOrderPaidFn seam).
 *
 * Scenario A: no paycloud_merchant_order_no — cancel immediately, Finatic never called.
 * Scenario B: has merchant_order_no, Finatic confirms paid — correct to paid (order #635 gap).
 * Scenario C: has merchant_order_no, Finatic confirms not paid — cancel with payment_declined.
 * Scenario D: has merchant_order_no, Finatic unreachable — leave pending (cron resolves later).
 *
 * Marker: VERIFY_TERMINAL_PAYMENT_FAILED_FINATIC_GUARD_STAGING_OK
 */
// @ts-nocheck
import { config } from 'dotenv'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { handleTerminalPaymentFailed } from '../lib/payments/handle-terminal-payment-failed'
import type { FinaticOrderPaidResult } from '../lib/payments/query-finatic-order-paid'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(STAGING_REF) || !serviceKey) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}

process.env.NEXT_PUBLIC_SUPABASE_URL = url
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
}

const MERCHANT_PAID = 'FTFAILGUARDPAID001'
const MERCHANT_DECLINED = 'FTFAILGUARDDECL002'
const MERCHANT_UNREACHABLE = 'FTFAILGUARDUNR003'

async function main() {
  const { data: restaurant, error: restErr } = await admin
    .from('restaurants')
    .insert({
      name: 'civ-term-fail-finatic-guard',
      finatic_merchant_no: 'PROBE_MERCHANT',
      finatic_store_no: 'PROBE_STORE',
    })
    .select('id')
    .single()
  if (restErr) throw restErr
  const restaurantId = restaurant.id as string
  log('created throwaway restaurant', restaurantId)

  const baseOrder = {
    restaurant_id: restaurantId,
    channel: 'pos' as const,
    status: 'pending',
    payment_status: 'pending',
    payment_method: 'card',
    subtotal: 8,
    tax: 0,
    total: 8,
    items: [{ name: 'Slice of Bread', quantity: 4, unitPrice: 2 }],
    placed_at: new Date().toISOString(),
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
    .insert({ ...baseOrder, paycloud_merchant_order_no: MERCHANT_PAID })
    .select('id')
    .single()
  if (bErr) throw bErr

  const { data: orderC, error: cErr } = await admin
    .from('orders')
    .insert({ ...baseOrder, paycloud_merchant_order_no: MERCHANT_DECLINED })
    .select('id')
    .single()
  if (cErr) throw cErr

  const { data: orderD, error: dErr } = await admin
    .from('orders')
    .insert({ ...baseOrder, paycloud_merchant_order_no: MERCHANT_UNREACHABLE })
    .select('id')
    .single()
  if (dErr) throw dErr

  log('fixtures', {
    orderA: orderA.id,
    orderB: orderB.id,
    orderC: orderC.id,
    orderD: orderD.id,
  })

  const finaticCallLog: string[] = []
  const stubQueryFinaticOrderPaid = async (params: {
    merchantOrderNo: string
    merchantNo: string
    storeNo: string
  }): Promise<FinaticOrderPaidResult> => {
    finaticCallLog.push(params.merchantOrderNo)
    if (params.merchantOrderNo === MERCHANT_PAID) {
      return {
        paid: true,
        merchantOrderNo: params.merchantOrderNo,
        status: '2',
        transactionId: 'FINATIC-TXN-FALSE-FAIL-0001',
        amount: 8,
        raw: { code: '0', data: { trans_status: 2 } },
      }
    }
    if (params.merchantOrderNo === MERCHANT_DECLINED) {
      return {
        paid: false,
        merchantOrderNo: params.merchantOrderNo,
        status: 'failed',
        transactionId: null,
        amount: 8,
        raw: { code: '0', data: { trans_status: 3 } },
      }
    }
    if (params.merchantOrderNo === MERCHANT_UNREACHABLE) {
      throw new Error('SIMULATED: PayCloud service unavailable (network failure)')
    }
    throw new Error(`unexpected merchantOrderNo in stub: ${params.merchantOrderNo}`)
  }

  const run = (orderId: string, merchantNo: string | null, reference: string) =>
    handleTerminalPaymentFailed(
      admin as any,
      {
        orderId,
        restaurantId,
        orderTotal: 8,
        paycloudMerchantOrderNo: merchantNo,
        terminalId: 'probe-terminal-id',
        reference,
        amount: 8,
        paymentMethod: 'card',
      },
      { queryFinaticOrderPaidFn: stubQueryFinaticOrderPaid },
    )

  try {
    // ---- A: no merchant order ----
    const resultA = await run(orderA.id, null, 'FT-FAIL-A')
    log('result A (no merchant_order_no)', resultA)
    const { data: freshA } = await admin.from('orders').select('*').eq('id', orderA.id).single()
    assert(resultA.outcome === 'cancelled', `A outcome=${resultA.outcome}`)
    assert(freshA!.status === 'cancelled' && freshA!.payment_status === 'cancelled', 'A must be cancelled')
    assert(freshA!.cancellation_reason === 'payment_declined', 'A reason payment_declined')
    assert(!finaticCallLog.includes(''), 'A should not call Finatic with empty key')
    if (finaticCallLog.length !== 0) {
      throw new Error(`ASSERTION FAILED: A: Finatic must not be called yet — got ${finaticCallLog.length}`)
    }
    console.log('SCENARIO_A_NO_MERCHANT_ORDER_CANCELLED_OK')

    // ---- B: Finatic paid (false-failure) ----
    const resultB = await run(orderB.id, MERCHANT_PAID, 'FT-FAIL-B-FALSE')
    log('result B (Finatic paid / false-failure)', resultB)
    const { data: freshB } = await admin.from('orders').select('*').eq('id', orderB.id).single()
    assert(resultB.outcome === 'corrected_to_paid', `B outcome=${resultB.outcome}`)
    assert(freshB!.status === 'completed' && freshB!.payment_status === 'paid', 'B must be corrected to paid')
    assert(freshB!.payment_reference === MERCHANT_PAID, 'B payment_reference must be Finatic merchant order')
    assert(freshB!.cancelled_at == null && freshB!.cancellation_reason == null, 'B must clear cancel fields')
    assert(finaticCallLog.includes(MERCHANT_PAID), 'B: Finatic must be queried')

    const { data: auditB } = await admin
      .from('audit_logs')
      .select('*')
      .eq('entity_id', orderB.id)
      .eq('action', 'payment.completed')
    log('order B audit_logs', auditB)
    assert((auditB?.length ?? 0) === 1, 'B: exactly one payment.completed audit')
    assert(
      (auditB?.[0]?.metadata as any)?.source === 'terminal_callback_false_failure_finatic_verified',
      'B: audit source must identify false-failure guard',
    )
    console.log('SCENARIO_B_FALSE_FAILURE_CORRECTED_TO_PAID_OK')

    // ---- C: Finatic not paid ----
    const resultC = await run(orderC.id, MERCHANT_DECLINED, 'FT-FAIL-C')
    log('result C (Finatic not paid)', resultC)
    const { data: freshC } = await admin.from('orders').select('*').eq('id', orderC.id).single()
    assert(resultC.outcome === 'cancelled', `C outcome=${resultC.outcome}`)
    assert(freshC!.status === 'cancelled' && freshC!.payment_status === 'cancelled', 'C must cancel')
    assert(freshC!.cancellation_reason === 'payment_declined', 'C reason payment_declined')
    assert(finaticCallLog.includes(MERCHANT_DECLINED), 'C: Finatic must be queried')
    console.log('SCENARIO_C_FINATIC_NOT_PAID_CANCELLED_OK')

    // ---- D: Finatic unreachable ----
    const resultD = await run(orderD.id, MERCHANT_UNREACHABLE, 'FT-FAIL-D')
    log('result D (Finatic unreachable)', resultD)
    const { data: freshD } = await admin.from('orders').select('*').eq('id', orderD.id).single()
    assert(resultD.outcome === 'left_pending_finatic_uncertain', `D outcome=${resultD.outcome}`)
    assert(freshD!.status === 'pending' && freshD!.payment_status === 'pending', 'D must stay pending')
    assert(freshD!.cancelled_at == null, 'D must not be cancelled')
    assert(finaticCallLog.includes(MERCHANT_UNREACHABLE), 'D: Finatic must be attempted')
    console.log('SCENARIO_D_FINATIC_UNREACHABLE_LEFT_PENDING_OK')

    log('Finatic call log', finaticCallLog)
    const finaticCallCount = finaticCallLog.slice().length
    assert(
      finaticCallCount === 3,
      `Finatic should be called for B/C/D only (3) — got ${finaticCallCount}`,
    )

    console.log('\nVERIFY_TERMINAL_PAYMENT_FAILED_FINATIC_GUARD_STAGING_OK')
  } finally {
    const ids = [orderA.id, orderB.id, orderC.id, orderD.id]
    await admin.from('audit_logs').delete().in('entity_id', ids)
    await admin.from('receipt_documents').delete().in('order_id', ids)
    await admin.from('orders').delete().in('id', ids)
    await admin.from('restaurants').delete().eq('id', restaurantId)
    console.log('\ncleanup done')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
