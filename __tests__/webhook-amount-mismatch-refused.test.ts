/**
 * #223 — the PayCloud webhook's two paths (signature-valid and signature-fallback) both
 * marked orders paid on the gateway's word with no amount comparison at all. This asserts the
 * fix: a disagreeing or absent gateway amount is REFUSED (not applied, not cancelled, both
 * figures recorded), and an agreeing amount still applies exactly as before.
 *
 * Not quarantined — that outcome is #223's cron leg only (auto-cancel-stale-pos-orders.ts),
 * because refusing there would let the same sweep cancel a card that had already been charged.
 * The webhook has no such follow-up sweep, so ACKing after refusing is the safe default.
 *
 * ==================================================================================================
 * UPDATED 2026-09-19 FOR THE ATOMIC SETTLEMENT, WITH EVERY ASSERTION PRESERVED
 * ==================================================================================================
 *
 * The route no longer calls `markOrderPaidConfirmed` once per order; it hands ONE target set to
 * `settle_order_payment`. So "was it applied?" is now asked of the RPC call rather than of that
 * mock. Nothing asserted here has been relaxed: the same four cases, the same HTTP statuses, the
 * same audit rows and the same figures under the same metadata keys. `gatewayAmount` and
 * `expectedAmount` are retained by the new writer deliberately, so that this contract -- shared
 * with the auto-cancel cron and the E04111 resolution procedure -- keeps holding.
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

// Receipt issuance is a post-settlement follow-up that reaches the network. Stubbed so a failure
// to issue one can never look like a failure to settle.
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: jest.fn(async () => undefined),
  safeIssueReceiptForOrder: jest.fn(async () => undefined),
}))

let state: FakeState
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => createFakeClient(state),
}))

function makeReq(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('https://example.test/api/webhooks/paycloud', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** Did the route ask the database to settle anything at all? */
const settled = () => state.rpcCalls.filter((c) => c.fn === 'settle_order_payment')

describe('#223 — webhook amount mismatch is refused, not applied', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    state = createFakeState()
    state.orders.set('ord-1', order('ord-1', 100, { payment_method: 'card' }))
    enforceWebhookRateLimit.mockReturnValue({ allowed: true })
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({ orderIds: ['ord-1'], source: 'orders' })
  })

  describe('signature-valid path', () => {
    beforeEach(() => {
      verifyWebhook.mockReturnValue({ ok: true, mode: 'hmac' })
    })

    test('agreeing amount: applied exactly as before (control)', async () => {
      const res = await POST(makeReq({ merchant_order_no: 'MO-1', trans_status: 2, amount: 100 }))
      const text = await res.text()
      expect(res.status).toBe(200)
      expect(text.trim()).toBe('success')
      expect(settled()).toHaveLength(1)
      expect(state.auditInserts.some((a) => a.action === 'payment.verification_uncertain')).toBe(
        false,
      )
    })

    test('disagreeing amount: NOT applied, ACKed, both figures recorded', async () => {
      const res = await POST(makeReq({ merchant_order_no: 'MO-2', trans_status: 2, amount: 20 }))
      const text = await res.text()
      expect(res.status).toBe(200)
      expect(text.trim()).toBe('success')
      expect(settled()).toHaveLength(0)

      const uncertain = state.auditInserts.find(
        (a) => a.action === 'payment.verification_uncertain',
      )
      expect(uncertain).toBeDefined()
      expect((uncertain!.metadata as Row).gatewayAmount).toBe(20)
      expect((uncertain!.metadata as Row).expectedAmount).toBe(100)
      expect((uncertain!.metadata as Row).amountVerified).toBe(false)

      const mismatch = state.auditInserts.find((a) => a.action === 'payment.amount_mismatch')
      expect(mismatch).toBeDefined()
      expect((mismatch!.metadata as Row).receivedAmount).toBe(20)
      expect((mismatch!.metadata as Row).expectedAmount).toBe(100)
    })

    test('absent amount: NOT applied, ACKed, verification_uncertain only (no mismatch row — never checked, not disagreed)', async () => {
      const res = await POST(makeReq({ merchant_order_no: 'MO-3', trans_status: 2 }))
      const text = await res.text()
      expect(res.status).toBe(200)
      expect(text.trim()).toBe('success')
      expect(settled()).toHaveLength(0)

      const uncertain = state.auditInserts.find(
        (a) => a.action === 'payment.verification_uncertain',
      )
      expect(uncertain).toBeDefined()
      expect((uncertain!.metadata as Row).gatewayAmount).toBeNull()

      expect(state.auditInserts.find((a) => a.action === 'payment.amount_mismatch')).toBeUndefined()
    })
  })

  describe('signature-fallback path', () => {
    beforeEach(() => {
      verifyWebhook.mockReturnValue({ ok: false, reason: 'Invalid signature' })
    })

    test('Finatic-verified but disagreeing amount: NOT applied, ACKed', async () => {
      confirmWebhookOrderViaFinaticFallback.mockResolvedValue({
        path: 'fallback_verified_paid',
        finatic: {
          paid: true,
          merchantOrderNo: 'MO-4',
          status: '2',
          transactionId: 'TXN-4',
          amount: 20,
          raw: {},
        },
        orderIds: ['ord-1'],
        restaurantId: 'rest-1',
        orderTotal: 20,
      })

      const res = await POST(
        makeReq(
          { merchant_order_no: 'MO-4', trans_status: 1, sign: 'deadbeef' },
          { 'x-paycloud-sign': 'deadbeef' },
        ),
      )
      const text = await res.text()
      expect(res.status).toBe(200)
      expect(text.trim()).toBe('success')
      expect(settled()).toHaveLength(0)

      const uncertain = state.auditInserts.find(
        (a) => a.action === 'payment.verification_uncertain',
      )
      expect(uncertain).toBeDefined()
      expect((uncertain!.metadata as Row).gatewayAmount).toBe(20)
      expect((uncertain!.metadata as Row).expectedAmount).toBe(100)
    })
  })
})
