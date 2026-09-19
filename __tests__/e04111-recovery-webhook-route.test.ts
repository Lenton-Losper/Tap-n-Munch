/**
 * PR1 — route-level: a Finatic-verified payment that we FAIL to apply must never be
 * ACKed. A 200 tells Finatic to stop retrying, so a swallowed claim result is the exact
 * shape of "real payment discarded, success logged".
 *
 * ==================================================================================================
 * UPDATED 2026-09-19 FOR THE ATOMIC SETTLEMENT
 * ==================================================================================================
 *
 * The route no longer inspects per-order claim results. `settle_order_payment` either applies the
 * whole target set or applies none of it, and the route's job is to decide whether the gateway
 * should retry. So the three outcomes this suite has always cared about are now:
 *
 *   a transient failure       -> 503, gateway retries          (was: claim_conflict)
 *   already settled           -> 200 ACK                       (was: already_paid)
 *   settled now               -> 200 ACK                       (unchanged)
 *
 * The E04111 recovery is likewise no longer a `fromPaymentStatuses` argument. The rule still lives
 * in lib/payments/e04111-recovery.ts -- it weighs cancellation_reason, which SQL should not
 * re-implement -- and its verdict now travels as `p_allow_cancelled_recovery`: the explicit list of
 * order ids the settlement may take from `cancelled` to `paid`. An id absent from that list is
 * refused by the function, which is asserted against a real Postgres in
 * supabase/tests/settlement-rpc.test.sql (`illegal/*` and `recovery/*`).
 */
import { POST } from '@/app/api/webhooks/paycloud/route'
import {
  createFakeClient,
  createFakeState,
  order,
  type FakeState,
  type Row,
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

const confirmWebhookOrderViaFinaticFallback = jest.fn()
jest.mock('@/lib/payments/webhook-sig-fallback', () => ({
  confirmWebhookOrderViaFinaticFallback: (...args: unknown[]) =>
    confirmWebhookOrderViaFinaticFallback(...args),
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
    headers: { 'content-type': 'application/json', 'x-paycloud-sign': 'deadbeef' },
    body: JSON.stringify(body),
  })
}

const PAID_FALLBACK = {
  path: 'fallback_verified_paid',
  finatic: {
    paid: true,
    merchantOrderNo: 'FT17857583233613303',
    status: '2',
    transactionId: 'TXN-149',
    amount: 42.5,
    raw: {},
  },
  orderIds: ['ord-1'],
  restaurantId: 'rest-1',
  orderTotal: 42.5,
}

const settleArgs = () => state.rpcCalls.find((c) => c.fn === 'settle_order_payment')?.args ?? null

describe('webhook must not ACK a payment it could not apply', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    state = createFakeState()
    enforceWebhookRateLimit.mockReturnValue({ allowed: true })
    verifyWebhook.mockReturnValue({ ok: false, reason: 'Encryption block is invalid.' })
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({ orderIds: ['ord-1'], source: 'orders' })
    confirmWebhookOrderViaFinaticFallback.mockResolvedValue(PAID_FALLBACK)
    state.orders.set(
      'ord-1',
      order('ord-1', 42.5, { payment_method: 'card', payment_status: 'pending' }),
    )
  })

  test('a transient settlement failure → 503 so Finatic retries, NOT a 200 ACK', async () => {
    // The settlement could not be completed -- a lock timeout, a rolled-back transaction. The
    // money is real and unrecorded, so the one thing that must not happen is an ACK.
    state.rpcResult = () => ({ ok: false, reason: 'orders_missing', claimed_order_ids: [] })

    const res = await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))
    const json = await res.json()

    expect(res.status).toBe(503)
    expect(String(json.error || '')).toMatch(/not applied/i)
  })

  test('already settled is benign → 200 ACK (another caller won the race)', async () => {
    state.rpcResult = () => ({
      ok: true,
      reason: 'already_consumed',
      applied: false,
      claimed_order_ids: ['ord-1'],
    })

    const res = await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))
    const text = await res.text()

    expect(res.status).toBe(200)
    expect(text.trim()).toBe('success')
  })

  test('successful settlement still ACKs 200', async () => {
    const res = await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe('success')
  })

  test('valid-signature path also refuses to ACK an unapplied settlement', async () => {
    verifyWebhook.mockReturnValue({ ok: true, mode: 'rsa' })
    state.rpcResult = () => ({ ok: false, reason: 'orders_missing', claimed_order_ids: [] })

    // #223: the amount must agree with the order total (42.5) to pass the gateway amount gate and
    // reach the settlement this test is actually about.
    const res = await POST(
      makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2, amount: 42.5 }),
    )
    expect(res.status).toBe(503)
  })

  test('a REFUSAL the gateway cannot resolve by retrying is ACKed instead', async () => {
    // An illegal transition will be refused identically on every future delivery, and it is
    // already recorded. 503-ing forever would only bury the event in the retry queue.
    state.rpcResult = () => ({
      ok: false,
      reason: 'illegal_transition',
      order_id: 'ord-1',
      claimed_order_ids: [],
    })

    const res = await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))
    expect(res.status).toBe(200)
  })
})

describe('auto-cancelled order recovery through the webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    state = createFakeState()
    enforceWebhookRateLimit.mockReturnValue({ allowed: true })
    verifyWebhook.mockReturnValue({ ok: false, reason: 'Encryption block is invalid.' })
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({ orderIds: ['ord-1'], source: 'orders' })
    confirmWebhookOrderViaFinaticFallback.mockResolvedValue(PAID_FALLBACK)
    state.orders.set(
      'ord-1',
      order('ord-1', 42.5, {
        payment_method: 'card',
        payment_status: 'cancelled',
        cancellation_reason: 'auto_cancelled_e04111_persistent',
        cancelled_at: '2026-08-03T10:00:00.000Z',
      }),
    )
  })

  test('clears the order for cancelled → paid and raises payment.recovered_after_auto_cancel', async () => {
    const res = await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))

    expect(res.status).toBe(200)
    // The E04111 verdict travels as an explicit allow-list. An id absent from it is refused by
    // settle_order_payment itself.
    expect(settleArgs()!.p_allow_cancelled_recovery).toEqual(['ord-1'])

    const recovery = state.auditInserts.find(
      (a) => a.action === 'payment.recovered_after_auto_cancel',
    )
    expect(recovery).toBeDefined()
    expect(recovery!.entity_id).toBe('ord-1')
    expect(recovery!.metadata).toEqual(
      expect.objectContaining({
        severity: 'error',
        previousCancellationReason: 'auto_cancelled_e04111_persistent',
        previousCancelledAt: '2026-08-03T10:00:00.000Z',
        requiresReconciliation: true,
      }),
    )
  })

  test('a staff-cancelled order is NOT revived by a webhook', async () => {
    const row = state.orders.get('ord-1') as Row
    row.cancellation_reason = 'terminal_cancelled'

    await POST(makeReq({ merchant_order_no: 'FT17857583233613303', trans_status: 2 }))

    // Not cleared, so the settlement function refuses the cancelled -> paid transition outright.
    expect(settleArgs()!.p_allow_cancelled_recovery).toEqual([])
    expect(
      state.auditInserts.find((a) => a.action === 'payment.recovered_after_auto_cancel'),
    ).toBeUndefined()
  })
})
