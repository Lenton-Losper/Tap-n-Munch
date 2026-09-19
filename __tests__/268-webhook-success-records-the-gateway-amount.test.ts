/**
 * #268 — the valid-signature webhook path recorded NO gateway amount on SUCCESS.
 *
 * `markOrdersPaidConfirmedByIds` used `params.gatewayAmount` to GATE the write, then wrote it to
 * the audit trail only on the FAILURE path (`payment.verification_uncertain`). Every SUCCESSFUL
 * webhook therefore landed `gatewayAmount: null` and `amountMeaning: 'order_total'` — so the
 * provider's own number, the one thing that made the payment auditable, survived only when it
 * DISAGREED.
 *
 * THE OBVIOUS FIX IS A NEW DEFECT, and pinning that is most of what this suite is for. A webhook
 * event can name SEVERAL orders at once (a tab settle) and the gateway's single figure covers all
 * of them. Handing that settlement-level number to a PER-ORDER record writes "the gateway reported
 * N$240 for this N$60 order", four times, wrong every time. That is the #226 shape: an event
 * amount is per-settle, never per-order.
 *
 * ==================================================================================================
 * UPDATED 2026-09-19 — THE INVARIANT IS THE SAME; THE SEAM IT IS ASSERTED AT HAS MOVED
 * ==================================================================================================
 *
 * There is no longer a per-order `markOrderPaidConfirmed` call for this suite to inspect. One
 * target set goes to `settle_order_payment`, which writes ONE settlement audit row and decides
 * there whether a per-order figure exists at all.
 *
 * So the invariant is now asserted in two halves, and BOTH exist:
 *
 *   here                                   what the ROUTE hands the settlement -- the whole target
 *                                          set, and the gateway's figure as a settlement-level
 *                                          number that is never divided among orders
 *
 *   supabase/tests/settlement-rpc.test.sql what the SETTLEMENT records --
 *                                          `riviera/audit_per_order_amount_is_null` (a 2-order
 *                                          settlement writes no per-order gateway figure) and
 *                                          `single/per_order_amount_recorded` (a 1-order one does).
 *                                          Those run against a real Postgres, because what a
 *                                          plpgsql function writes cannot be proved against a mock.
 *
 * Mutation M1 in supabase/tests/run-db-tests.mjs turns the second half red on demand.
 */
import { POST } from '@/app/api/webhooks/paycloud/route'
import {
  createFakeClient,
  createFakeState,
  order,
  settledOrderIds,
  type FakeState,
} from './helpers/settlement-supabase-fake'

const verifyWebhook = jest.fn()
const enforceWebhookRateLimit = jest.fn((..._args: unknown[]) => ({ allowed: true }))
jest.mock('@/payments/webhook', () => ({
  verifyWebhook: (...args: unknown[]) => verifyWebhook(...args),
  enforceWebhookRateLimit: (...args: unknown[]) => enforceWebhookRateLimit(...args),
}))

const resolveOrderIdsByMerchantOrderNo = jest.fn()
jest.mock('@/lib/payments/resolve-order-by-merchant-order', () => ({
  resolveOrderIdsByMerchantOrderNo: (...args: unknown[]) =>
    resolveOrderIdsByMerchantOrderNo(...args),
}))

jest.mock('@/lib/payments/webhook-sig-fallback', () => ({
  confirmWebhookOrderViaFinaticFallback: jest.fn(),
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: jest.fn(async () => undefined),
  safeIssueReceiptForOrder: jest.fn(async () => undefined),
}))

let state: FakeState
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => createFakeClient(state),
}))

function makeReq(body: Record<string, unknown>) {
  return new Request('https://example.test/api/webhooks/paycloud', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The one settlement call, with everything the route decided. */
const settleArgs = () =>
  state.rpcCalls.find((c) => c.fn === 'settle_order_payment')?.args ?? null

beforeEach(() => {
  jest.clearAllMocks()
  state = createFakeState()
  state.orders.set('ord-1', order('ord-1', 100, { payment_method: 'card' }))
  enforceWebhookRateLimit.mockReturnValue({ allowed: true })
  verifyWebhook.mockReturnValue({ ok: true, mode: 'hmac' })
  resolveOrderIdsByMerchantOrderNo.mockResolvedValue({ orderIds: ['ord-1'], source: 'orders' })
})

describe('#268 a SINGLE-order settlement records the gateway figure', () => {
  test('the gateway amount reaches the settlement, in cents, as the authoritative figure', async () => {
    const res = await POST(makeReq({ merchant_order_no: 'MO-1', trans_status: 2, amount: 100 }))
    expect(res.status).toBe(200)
    const args = settleArgs()
    expect(args).not.toBeNull()
    // THE ASSERTION THE FIX EXISTS FOR. Before #268 the provider's figure never reached the write.
    expect(args!.p_gateway_amount_cents).toBe(10000)
    expect(args!.p_expected_amount_cents).toBe(10000)
  })

  test('the gateway transaction id reaches it too — without it the ledger row cannot be reconciled', async () => {
    await POST(
      makeReq({
        merchant_order_no: 'MO-1',
        trans_status: 2,
        amount: 100,
        transaction_id: 'TXN-268',
      }),
    )
    expect(settleArgs()!.p_gateway_transaction_id).toBe('TXN-268')
  })
})

describe('#268 a MULTI-order settlement never divides the figure among the orders', () => {
  beforeEach(() => {
    state.orders.clear()
    for (const id of ['a', 'b', 'c', 'd']) {
      state.orders.set(id, order(id, 60, { payment_method: 'card' }))
    }
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({
      orderIds: ['a', 'b', 'c', 'd'],
      source: 'orders',
    })
  })

  test('ONE settlement is issued for all four orders, not four settlements of one', async () => {
    await POST(makeReq({ merchant_order_no: 'MO-TAB', trans_status: 2, amount: 240 }))
    expect(state.rpcCalls.filter((c) => c.fn === 'settle_order_payment')).toHaveLength(1)
    expect(settledOrderIds(state).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  test('the figure passed is the SETTLEMENT total, never one order’s share of it', async () => {
    await POST(makeReq({ merchant_order_no: 'MO-TAB', trans_status: 2, amount: 240 }))
    const args = settleArgs()!
    // 24000 is the settlement. 6000 would be one order's share — the #226 trap.
    expect(args.p_gateway_amount_cents).toBe(24000)
    expect(args.p_expected_amount_cents).toBe(24000)
  })
})

describe('#268 #223’s refusals are unchanged', () => {
  test('an ABSENT amount still never reaches the settlement', async () => {
    await POST(makeReq({ merchant_order_no: 'MO-3', trans_status: 2 }))
    expect(settleArgs()).toBeNull()
    expect(state.auditInserts.some((a) => a.action === 'payment.verification_uncertain')).toBe(true)
  })

  test('a DISAGREEING amount is still refused, and nothing is written', async () => {
    await POST(makeReq({ merchant_order_no: 'MO-2', trans_status: 2, amount: 20 }))
    expect(settleArgs()).toBeNull()
    expect(state.auditInserts.some((a) => a.action === 'payment.amount_mismatch')).toBe(true)
  })
})
