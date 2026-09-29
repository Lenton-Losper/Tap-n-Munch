/**
 * Sprint 2026-09-29 brief, TASK 7 — THE RECONCILIATION CRON TRUSTED A DEVICE AMOUNT.
 *
 * POST /api/terminal/payment-events/sale stores the DEVICE's `amount` and `order_ids`, even when the
 * amount disagrees with the intent. reconcileOrphanPayments then read that amount as the gateway's
 * figure and marked the named orders paid when it equalled their totals -- no Finatic query.
 *
 * Now the event is only a lead: the reference is bound to the orders from server state, Finatic is
 * asked, and settle_order_payment is handed FINATIC's amount. These run the REAL cron against the
 * in-memory store; scripts/mutate-reconcile.mjs holds the mutations that must turn it RED.
 */
import {
  VENUE,
  audits,
  e04111Error,
  finaticNotPaid,
  finaticPaid,
  intent,
  makeDb,
  order,
  paidIds,
  settleCalls,
} from './helpers/reconcile-harness'

const A = 'aaaaaaaa-0000-4000-8000-00000000001a'
const B = 'aaaaaaaa-0000-4000-8000-00000000001b'
const REF = 'FT-DEV-1'

const mockQuery = jest.fn()
jest.mock('@/payments/paycloud', () => ({
  queryPaymentOrder: (...args: unknown[]) => mockQuery(...args),
}))

let mockCredentialsMissing = false
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => {
    if (mockCredentialsMissing) throw new Error('Finatic credentials are not configured')
    return { merchantNo: 'M1', storeNo: 'S1', terminalSn: null }
  },
  isMissingFinaticCredentialsError: () => false,
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: async () => undefined,
  safeIssueReceiptForOrder: async () => undefined,
}))

type Row = Record<string, unknown>

/** The device's report: whatever amount and order_ids it chose to send. */
function deviceEvent(amount: number, orderIds: string[], over: Row = {}): Row {
  return {
    id: `pe-${amount}-${orderIds.length}`,
    restaurant_id: VENUE,
    event_type: 'sale',
    business_order_no: REF,
    origin_business_order_no: REF,
    idempotency_key: REF,
    transaction_id: 'TXN-DEV',
    amount,
    order_ids: orderIds,
    origin: 'terminal_device',
    device_amount_check: 'unchecked',
    reason_code: 'sale',
    raw_gateway_response: null,
    created_at: new Date().toISOString(),
    ...over,
  }
}

function seed(orders: Row[], events: Row[], extra: Record<string, Row[]> = {}) {
  const h = makeDb({ orders, payment_events: events, ...extra })
  return h
}

async function run(h: ReturnType<typeof makeDb>) {
  const { reconcileOrphanPayments } = await import('@/lib/payments/reconcile-orphan-payments')
  return reconcileOrphanPayments(h.client as never)
}

beforeEach(() => {
  mockQuery.mockReset()
  mockCredentialsMissing = false
})

it('correct amount: the gateway confirms, the order is settled through the RPC on the gateway figure', async () => {
  const h = seed([order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 })], [deviceEvent(100, [A])])
  mockQuery.mockResolvedValue(finaticPaid(100, 'TXN-DEV'))

  const res = await run(h)

  expect(res.markedPaidIds).toEqual([A])
  expect(paidIds(h.db)).toEqual([A])
  expect(mockQuery).toHaveBeenCalledTimes(1)
  const args = settleCalls(h.db)[0].args as Row
  expect(args.p_gateway_amount_cents).toBe(10000)
  expect(args.p_source).toBe('cron_reconcile_orphan_payments')
  // One sale row: the device's report, promoted to the verified figure (20260929130000).
  expect(h.db.rows('payment_events')).toHaveLength(1)
  expect(h.db.rows('payment_events')[0]).toMatchObject({ origin: 'gateway', amount: 100 })
  expect(audits(h.db, 'payment.settlement_applied')).toHaveLength(1)
})

it('manipulated amount (device over-reports): the order is paid on the GATEWAY figure, the disagreement recorded', async () => {
  const h = seed([order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 })], [deviceEvent(1, [A])])
  mockQuery.mockResolvedValue(finaticPaid(100))

  const res = await run(h)

  expect(res.markedPaidIds).toEqual([A])
  expect((settleCalls(h.db)[0].args as Row).p_gateway_amount_cents).toBe(10000)
  const d = audits(h.db, 'payment.device_amount_disagrees_with_gateway')
  expect(d).toHaveLength(1)
  expect(d[0].metadata).toMatchObject({ deviceReportedAmount: 1, gatewayAmount: 100 })
})

it('manipulated amount (device claims the full total, customer paid N$1): NOT marked paid', async () => {
  const h = seed([order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 })], [deviceEvent(100, [A])])
  mockQuery.mockResolvedValue(finaticPaid(1))

  const res = await run(h)

  expect(res.markedPaidIds).toEqual([])
  expect(paidIds(h.db)).toEqual([])
  expect(res.amountMismatchIds).toEqual([A])
  expect(audits(h.db, 'payment.verification_uncertain')).toHaveLength(1)
})

it('stale amount (device reports the pre-discount total): settled on the intent/gateway figure, not the device\'s', async () => {
  const h = seed(
    [order(A, { pending_charge_cents: 8000 })],
    [deviceEvent(100, [A])],
    { terminal_payment_intents: [intent({ merchant_order_no: REF, amount_cents: 8000, order_ids: [A] })] },
  )
  mockQuery.mockResolvedValue(finaticPaid(80))

  const res = await run(h)

  expect(res.markedPaidIds).toEqual([A])
  expect((settleCalls(h.db)[0].args as Row).p_gateway_amount_cents).toBe(8000)
  expect(h.db.rows('terminal_payment_intents')[0].consumed_at).toBeTruthy()
})

it('gateway does not report paid: never marked paid on the device\'s word', async () => {
  const h = seed([order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 })], [deviceEvent(100, [A])])
  mockQuery.mockResolvedValue(finaticNotPaid())

  const res = await run(h)

  expect(res.markedPaidIds).toEqual([])
  expect(res.gatewayUnverifiedIds).toEqual([A])
  expect(paidIds(h.db)).toEqual([])
  expect(settleCalls(h.db)).toHaveLength(0)
})

it('gateway mismatch (off by a cent): not paid, both figures recorded', async () => {
  const h = seed([order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 })], [deviceEvent(100, [A])])
  mockQuery.mockResolvedValue(finaticPaid(99.99))

  const res = await run(h)

  expect(res.markedPaidIds).toEqual([])
  expect(res.amountMismatchIds).toEqual([A])
  expect(audits(h.db, 'payment.amount_mismatch')).toHaveLength(1)
})

describe('gateway unavailable: must not mark paid', () => {
  it('network failure', async () => {
    const h = seed([order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 })], [deviceEvent(100, [A])])
    mockQuery.mockRejectedValue(new Error('fetch failed: ETIMEDOUT'))
    const res = await run(h)
    expect(res.markedPaidIds).toEqual([])
    expect(res.gatewayUnverifiedIds).toEqual([A])
    expect(paidIds(h.db)).toEqual([])
  })

  it('E04111 (no record yet)', async () => {
    const h = seed([order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 })], [deviceEvent(100, [A])])
    mockQuery.mockRejectedValue(e04111Error())
    const res = await run(h)
    expect(res.markedPaidIds).toEqual([])
    expect(paidIds(h.db)).toEqual([])
  })

  it('no Finatic credentials', async () => {
    const h = seed([order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 })], [deviceEvent(100, [A])])
    mockCredentialsMissing = true
    const res = await run(h)
    expect(res.markedPaidIds).toEqual([])
    expect(mockQuery).not.toHaveBeenCalled()
    expect(paidIds(h.db)).toEqual([])
  })
})

it('duplicate reconciliation: a second run spends no gateway call and settles nothing', async () => {
  const h = seed([order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 })], [deviceEvent(100, [A])])
  mockQuery.mockResolvedValue(finaticPaid(100))

  const first = await run(h)
  const second = await run(h)

  expect(first.markedPaidIds).toEqual([A])
  expect(second.markedPaidIds).toEqual([])
  expect(mockQuery).toHaveBeenCalledTimes(1)
  expect(settleCalls(h.db)).toHaveLength(1)
  expect(h.db.rows('payment_events')).toHaveLength(1)
})

it('a device event naming orders the reference was not prepared for is not reconciled', async () => {
  // The reference is on A (N$100); the device names B (also N$100).
  const h = seed(
    [
      order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 }),
      order(B, { pending_charge_cents: 10000 }),
    ],
    [deviceEvent(100, [B])],
  )
  mockQuery.mockResolvedValue(finaticPaid(100))

  const res = await run(h)

  expect(res.markedPaidIds).toEqual([])
  expect(res.unverifiableIds).toEqual([B])
  expect(paidIds(h.db)).toEqual([])
  expect(mockQuery).not.toHaveBeenCalled()
})

it('a reference already consumed by a server-verified payment is not applied again', async () => {
  const h = seed(
    [order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 })],
    [deviceEvent(100, [A], { origin: null, device_amount_check: null, raw_gateway_response: { recorded_by: 'server' } })],
  )
  mockQuery.mockResolvedValue(finaticPaid(100))

  const res = await run(h)

  expect(res.markedPaidIds).toEqual([])
  expect(res.unverifiableIds).toEqual([A])
  expect(paidIds(h.db)).toEqual([])
})

it('an E04111-auto-cancelled order is recovered, through the RPC\'s allow-list', async () => {
  const h = seed(
    [
      order(A, {
        paycloud_merchant_order_no: REF,
        pending_charge_cents: 10000,
        status: 'cancelled',
        payment_status: 'cancelled',
        cancellation_reason: 'auto_cancelled_e04111_persisted',
        cancelled_at: '2026-09-28T00:00:00Z',
      }),
    ],
    [deviceEvent(100, [A])],
  )
  mockQuery.mockResolvedValue(finaticPaid(100))

  const res = await run(h)

  expect(res.recoveredAfterAutoCancelIds).toEqual([A])
  expect(paidIds(h.db)).toEqual([A])
  expect(h.db.rows('orders')[0].cancelled_at).toBeNull()
  expect(audits(h.db, 'payment.recovered_after_auto_cancel')).toHaveLength(1)
})

it('#223 folded in: a two-order event is checked ONCE against the whole prepared set', async () => {
  const h = seed(
    [
      order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 4015, pending_settlement_id: 'dddddddd-0000-4000-8000-000000000009' }),
      order(B, { pending_charge_cents: 3820, pending_settlement_id: 'dddddddd-0000-4000-8000-000000000009' }),
    ],
    [deviceEvent(78.35, [A, B])],
  )
  mockQuery.mockResolvedValue(finaticPaid(78.35))

  const res = await run(h)

  expect(res.markedPaidIds.sort()).toEqual([A, B].sort())
  expect(settleCalls(h.db)).toHaveLength(1)
  expect((settleCalls(h.db)[0].args as Row).p_order_ids).toEqual(expect.arrayContaining([A, B]))
})

it('one event failing to settle does not abort the sweep', async () => {
  const REF2 = 'FT-DEV-2'
  const h = seed(
    [
      order(A, { paycloud_merchant_order_no: REF, pending_charge_cents: 10000 }),
      order(B, { paycloud_merchant_order_no: REF2, pending_charge_cents: 10000 }),
    ],
    [
      deviceEvent(100, [A], { id: 'pe-a', created_at: '2026-09-29T10:00:01.000Z' }),
      deviceEvent(100, [B], { id: 'pe-b', business_order_no: REF2, idempotency_key: REF2, created_at: '2026-09-29T10:00:00.000Z' }),
    ],
  )
  mockQuery.mockResolvedValue(finaticPaid(100))
  const realRpc = h.client.rpc
  h.client.rpc = async (name: string, args: Row) =>
    args.p_merchant_order_no === REF ? { data: null, error: { message: 'connection reset' } } : realRpc(name, args)

  const res = await run(h)

  expect(res.markedPaidIds).toEqual([B])
  expect(paidIds(h.db)).toEqual([B])
})
