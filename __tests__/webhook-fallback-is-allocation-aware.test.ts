/**
 * A SPLIT CARD PAYMENT MUST NEVER CLOSE A WHOLE ORDER — ON EITHER WEBHOOK PATH.
 *
 * ==================================================================================================
 * THE PRODUCTION FAILURE THIS REPRODUCES
 * ==================================================================================================
 *
 * Digi Cofee, 2026-09-07 12:37:26. Order #45, total N$37.00, seven lines.
 *
 *   settled item revenue   N$17.00   (one Coffee, two cheese toast)
 *   gratuity               N$20.00   (payment_tips, kept out of revenue by design)
 *   charged at the reader  N$37.00   = 17 + 20
 *
 * The gateway callback failed signature verification, so it took the fallback path. That path
 * resolved the reference — it had `resolved.intent` in hand, scope 'allocations' — and then passed
 * the order ids to the WHOLE-ORDER writer. The whole-order amount check compared the N$37.00
 * gateway amount against the N$37.00 order total, saw no mismatch, and marked all seven lines paid.
 *
 * N$17.00 of revenue was collected against an order recorded as N$37.00 paid. Three Cappucinos, a
 * Coffee and a cheese toast were marked paid by a card that never covered them, and the same
 * N$20.00 was counted once as a tip and again as revenue.
 *
 * THE COINCIDENCE IS THE POINT. 17 + 20 == 37 is what defeated the amount check. Had the tip been
 * any other figure the mismatch guard would have caught it, which is exactly why a guard that can
 * be satisfied by adding a gratuity to an item payment is the wrong guard for a part-order charge.
 *
 * ==================================================================================================
 * WHAT MAKES THE FIX CORRECT, RATHER THAN JUST DIFFERENT
 * ==================================================================================================
 *
 * settleAllocationsForIntent settles EXACTLY the intent's own allocation ids and records the tip
 * separately, so items and gratuity can never be summed into "fully paid". Closing the order stays
 * the sole responsibility of `order_is_fully_paid_by_allocations`, an integer-cent SQL predicate.
 *
 * So these tests assert two different things and never conflate them:
 *   - the allocation writer WAS called, with the intent
 *   - the whole-order writer was NOT called at all
 * The second is the one that would have caught the defect. A test that only checked the first
 * would have passed on the broken code, because on the broken code neither ran the split path.
 */
import { POST } from '@/app/api/webhooks/paycloud/route'

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

/** THE WHOLE-ORDER WRITER. Every assertion that matters here is that this did NOT run. */
const markOrderPaidConfirmed = jest.fn(async (..._args: unknown[]) => ({
  claimed: true,
  orderId: 'ord-45',
  tabId: 'tab-1',
}))
jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: (...args: unknown[]) => markOrderPaidConfirmed(...args),
}))

const settleAllocationsForIntent = jest.fn()
jest.mock('@/lib/payments/settle-allocations-for-intent', () => ({
  settleAllocationsForIntent: (...args: unknown[]) => settleAllocationsForIntent(...args),
}))

const markIntentConfirmed = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock('@/lib/payments/payment-intents', () => ({
  markIntentConfirmed: (...args: unknown[]) => markIntentConfirmed(...args),
}))

const auditInserts: unknown[] = []
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({
            in: async () => ({
              // Order #45 as it stood: N$37.00 total, not yet paid.
              data: [
                { id: 'ord-45', restaurant_id: 'rest-1', total: 37, payment_method: 'card' },
              ],
              error: null,
            }),
          }),
        }
      }
      if (table === 'audit_logs') {
        return {
          insert: async (row: unknown) => {
            auditInserts.push(row)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

function makeReq(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('https://example.test/api/webhooks/paycloud', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** The real shape: three of seven lines allocated, N$17.00 of them settled by this charge. */
const ALLOCATION_INTENT = {
  id: 'intent-45',
  restaurantId: 'rest-1',
  tabId: 'tab-1',
  scope: 'allocations' as const,
  status: 'launched' as const,
  merchantOrderNo: 'FT17887846298594421',
  amountCents: 3700,
  tipCents: 2000,
  allocationIds: ['alloc-coffee-500', 'alloc-toast-1200'],
  orderIds: null,
}

const WHOLE_ORDER_INTENT = {
  ...ALLOCATION_INTENT,
  id: 'intent-whole',
  scope: 'orders' as const,
  tipCents: 0,
  allocationIds: null,
  orderIds: ['ord-45'],
}

/** Signature FAILS -> the fallback path. This is the one that broke production. */
function signatureFails() {
  verifyWebhook.mockReturnValue({ ok: false, reason: 'Encrypted message length is invalid.' })
  confirmWebhookOrderViaFinaticFallback.mockResolvedValue({
    path: 'fallback_verified_paid',
    finatic: {
      paid: true,
      merchantOrderNo: 'FT17887846298594421',
      status: '2',
      transactionId: 'TXN-45',
      // The gateway amount INCLUDES the gratuity, and equals the order total. The coincidence.
      amount: 37,
      raw: {},
    },
    orderIds: ['ord-45'],
    restaurantId: 'rest-1',
    orderTotal: 37,
  })
}

/** Signature VALID -> the path that was already allocation-aware. The control. */
function signatureValid() {
  verifyWebhook.mockReturnValue({ ok: true, mode: 'hmac' })
}

const PAID_BODY = {
  merchant_order_no: 'FT17887846298594421',
  trans_status: 2,
  amount: 37,
  sign: 'deadbeef',
}

beforeEach(() => {
  jest.clearAllMocks()
  auditInserts.length = 0
  enforceWebhookRateLimit.mockReturnValue({ allowed: true })
  settleAllocationsForIntent.mockResolvedValue({
    ok: true,
    settledAllocationIds: ALLOCATION_INTENT.allocationIds,
    ordersClosed: [],
    alreadySettled: false,
    tipRecorded: 'recorded',
  })
  resolveOrderIdsByMerchantOrderNo.mockResolvedValue({
    orderIds: ['ord-45'],
    source: 'intent',
    intent: ALLOCATION_INTENT,
  })
})

// ==================================================================================================
// THE REGRESSION
// ==================================================================================================

describe('signature FAILED + allocation-scope intent (the production defect)', () => {
  it('settles the allocations and NEVER reaches the whole-order writer', async () => {
    signatureFails()

    const res = await POST(makeReq(PAID_BODY, { 'x-paycloud-sign': 'deadbeef' }))

    expect(res.status).toBe(200)
    expect(settleAllocationsForIntent).toHaveBeenCalledTimes(1)
    expect(settleAllocationsForIntent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        intent: expect.objectContaining({ id: 'intent-45', scope: 'allocations' }),
        paymentReference: 'FT17887846298594421',
      }),
    )
    // THE ASSERTION THAT WOULD HAVE CAUGHT IT. On the broken code this ran and closed order #45.
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
  })

  it('settles ONLY the two allocations the charge covered, not the whole order', async () => {
    /**
     * N$17.00 of items. The other four lines of order #45 are not named here and must stay unpaid;
     * the N$20.00 gratuity is not an allocation and cannot become one.
     */
    signatureFails()
    await POST(makeReq(PAID_BODY, { 'x-paycloud-sign': 'deadbeef' }))

    const params = settleAllocationsForIntent.mock.calls[0][1] as {
      intent: { allocationIds: string[]; tipCents: number }
    }
    expect(params.intent.allocationIds).toEqual(['alloc-coffee-500', 'alloc-toast-1200'])
    expect(params.intent.allocationIds).toHaveLength(2)
    // The tip travels as its own figure and is never folded into the settled items.
    expect(params.intent.tipCents).toBe(2000)
  })

  it('does not let 17 + 20 === 37 close the order', async () => {
    /**
     * The arithmetic, stated. Nothing in the split path compares a gateway amount to an order
     * total, so the coincidence that defeated the whole-order guard cannot arise here.
     */
    signatureFails()
    await POST(makeReq(PAID_BODY, { 'x-paycloud-sign': 'deadbeef' }))

    const params = settleAllocationsForIntent.mock.calls[0][1] as {
      intent: { amountCents: number; tipCents: number }
    }
    const itemCents = params.intent.amountCents - params.intent.tipCents
    expect(itemCents).toBe(1700)
    expect(params.intent.amountCents).toBe(3700) // what the reader was charged
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
  })
})

// ==================================================================================================
// THE CONTROL: the path that was already right
// ==================================================================================================

describe('signature VALID + allocation-scope intent', () => {
  it('behaves identically — same writer, same refusal to close the order', async () => {
    signatureValid()

    const res = await POST(makeReq(PAID_BODY))

    expect(res.status).toBe(200)
    expect(settleAllocationsForIntent).toHaveBeenCalledTimes(1)
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
  })
})

// ==================================================================================================
// WHOLE-ORDER REFERENCES ARE UNTOUCHED
// ==================================================================================================

describe('whole-order references still take the whole-order path', () => {
  it('an intent with scope "orders" reaches the whole-order writer', async () => {
    /**
     * THE POSITIVE CONTROL, and this suite is worthless without it. Every assertion above is that
     * the whole-order writer did NOT run; if the fork simply swallowed every callback, they would
     * all pass while payments stopped being recorded at all.
     */
    signatureFails()
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({
      orderIds: ['ord-45'],
      source: 'intent',
      intent: WHOLE_ORDER_INTENT,
    })

    const res = await POST(makeReq(PAID_BODY, { 'x-paycloud-sign': 'deadbeef' }))

    expect(res.status).toBe(200)
    expect(markOrderPaidConfirmed).toHaveBeenCalled()
    expect(settleAllocationsForIntent).not.toHaveBeenCalled()
  })

  it('a legacy reference with NO intent reaches the whole-order writer', async () => {
    // Every reference minted before intents existed, which is most of production.
    signatureFails()
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({
      orderIds: ['ord-45'],
      source: 'orders',
    })

    const res = await POST(makeReq(PAID_BODY, { 'x-paycloud-sign': 'deadbeef' }))

    expect(res.status).toBe(200)
    expect(markOrderPaidConfirmed).toHaveBeenCalled()
    expect(settleAllocationsForIntent).not.toHaveBeenCalled()
  })
})

// ==================================================================================================
// THE OTHER GUARDS THE FALLBACK WAS ALSO MISSING
// ==================================================================================================

describe('an already-confirmed allocation intent', () => {
  it('does not settle twice, on the fallback path', async () => {
    signatureFails()
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({
      orderIds: ['ord-45'],
      source: 'intent',
      intent: { ...ALLOCATION_INTENT, status: 'confirmed' as const },
    })

    const res = await POST(makeReq(PAID_BODY, { 'x-paycloud-sign': 'deadbeef' }))

    expect(res.status).toBe(200)
    expect(settleAllocationsForIntent).not.toHaveBeenCalled()
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
  })
})

describe('an allocation intent the DEVICE reported failed', () => {
  it('settles nothing and records the disagreement', async () => {
    signatureFails()
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({
      orderIds: ['ord-45'],
      source: 'intent',
      intent: { ...ALLOCATION_INTENT, status: 'failed' as const },
    })

    const res = await POST(makeReq(PAID_BODY, { 'x-paycloud-sign': 'deadbeef' }))

    expect(res.status).toBe(200)
    expect(settleAllocationsForIntent).not.toHaveBeenCalled()
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    expect(
      auditInserts.some(
        (r) => (r as { action?: string }).action === 'payment.split_intent_gateway_disagrees',
      ),
    ).toBe(true)
  })
})

describe('when the settlement itself fails', () => {
  it('answers 503 so Finatic retries, and closes nothing', async () => {
    // The charge is real and the items are still unsettled. Failing loudly is the safe direction.
    signatureFails()
    settleAllocationsForIntent.mockResolvedValue({ ok: false, reason: 'rpc exploded' })

    const res = await POST(makeReq(PAID_BODY, { 'x-paycloud-sign': 'deadbeef' }))

    expect(res.status).toBe(503)
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    expect(markIntentConfirmed).not.toHaveBeenCalled()
  })
})
