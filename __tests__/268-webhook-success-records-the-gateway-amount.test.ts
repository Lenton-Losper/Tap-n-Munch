/**
 * #268 — the valid-signature webhook path recorded NO gateway amount on SUCCESS.
 *
 * `markOrdersPaidConfirmedByIds` used `params.gatewayAmount` to GATE the write, then wrote it to
 * the audit trail only on the FAILURE path (`payment.verification_uncertain`). Every SUCCESSFUL
 * webhook therefore landed `gatewayAmount: null` and `amountMeaning: 'order_total'`
 * (`lib/payments/mark-order-paid-confirmed.ts:144-145`) — so the provider's own figure, the one
 * thing that makes a historical amount mismatch auditable, survived only when it DISAGREED.
 *
 * THE OBVIOUS FIX IS A NEW DEFECT, and pinning that is most of what this suite is for.
 *
 * A webhook event can name SEVERAL orders at once (a tab settle), and the gateway's single figure
 * covers all of them — which is why `verified` compares it ONCE against the SUM, as that function's
 * own docblock says. Passing that settlement-level number into a PER-ORDER call would record "the
 * gateway reported 240 for this 60 order", four times, wrong every time. That is the #226 shape: an
 * event amount is per-settle, never per-order.
 *
 * So the two cases are recorded differently:
 *   ONE order covered  -> gatewayAmount IS that order's figure, and is passed.
 *   MANY orders        -> gatewayAmount stays null; the settlement's own numbers are recorded
 *                         under names that say what they are.
 *
 * FAILS WITHOUT THE FIX: at `ceea943` the single-order success call carries no `gatewayAmount` at
 * all, so the first assertion below reads `undefined`.
 *
 * Harness copied from `__tests__/webhook-amount-mismatch-refused.test.ts` — same route, same mocks,
 * driven through the exported POST rather than through a test-only export, because a Next route
 * module may not export arbitrary symbols.
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

const markOrderPaidConfirmed = jest.fn(async (..._args: unknown[]) => ({
  claimed: true,
  orderId: 'ord-1',
  tabId: null,
}))
jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: (...args: unknown[]) => markOrderPaidConfirmed(...args),
}))

type Row = Record<string, unknown>
const auditInserts: Row[] = []
let orderRows: Row[]

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({ in: async () => ({ data: orderRows, error: null }) }),
        }
      }
      if (table === 'audit_logs') {
        return {
          insert: async (row: Row) => {
            auditInserts.push(row)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

function makeReq(body: Record<string, unknown>) {
  return new Request('https://example.test/api/webhooks/paycloud', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function order(id: string, total: number): Row {
  return { id, restaurant_id: 'rest-1', total, payment_method: 'card' }
}

/** Every per-order call's second argument — what markOrderPaidConfirmed was actually told. */
const perOrderArgs = () => markOrderPaidConfirmed.mock.calls.map((c) => c[1] as Row)

beforeEach(() => {
  jest.clearAllMocks()
  auditInserts.length = 0
  orderRows = [order('ord-1', 100)]
  enforceWebhookRateLimit.mockReturnValue({ allowed: true })
  verifyWebhook.mockReturnValue({ ok: true, mode: 'hmac' })
  resolveOrderIdsByMerchantOrderNo.mockResolvedValue({ orderIds: ['ord-1'], source: 'orders' })
})

describe('#268 a SINGLE-order settlement records the gateway figure', () => {
  test('gatewayAmount reaches the per-order write, so amountMeaning becomes gateway_reported', async () => {
    const res = await POST(makeReq({ merchant_order_no: 'MO-1', trans_status: 2, amount: 100 }))
    expect(res.status).toBe(200)
    expect(markOrderPaidConfirmed).toHaveBeenCalledTimes(1)
    // THE ASSERTION THE FIX EXISTS FOR. Before it, this read `undefined`.
    expect(perOrderArgs()[0].gatewayAmount).toBe(100)
  })

  test('records nothing settlement-shaped — there is only one order to describe', async () => {
    await POST(makeReq({ merchant_order_no: 'MO-1', trans_status: 2, amount: 100 }))
    const meta = (perOrderArgs()[0].extraAuditMetadata ?? {}) as Row
    expect(meta).not.toHaveProperty('settlementGatewayAmount')
    expect(meta).not.toHaveProperty('settlementOrderCount')
  })
})

describe('#268 a MULTI-order settlement never claims the figure is one order’s', () => {
  beforeEach(() => {
    orderRows = [order('a', 60), order('b', 60), order('c', 60), order('d', 60)]
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({
      orderIds: ['a', 'b', 'c', 'd'],
      source: 'orders',
    })
  })

  test('gatewayAmount is NULL on every order — the #226 trap, pinned', async () => {
    await POST(makeReq({ merchant_order_no: 'MO-TAB', trans_status: 2, amount: 240 }))
    expect(markOrderPaidConfirmed).toHaveBeenCalledTimes(4)
    for (const args of perOrderArgs()) {
      // 240 is the SETTLEMENT. Each of these orders is 60. It must appear on none of them.
      expect(args.gatewayAmount).toBeNull()
      expect(args.amount).toBe(60)
    }
  })

  test('but the settlement stays reconstructable, under names that say what they are', async () => {
    await POST(makeReq({ merchant_order_no: 'MO-TAB', trans_status: 2, amount: 240 }))
    for (const args of perOrderArgs()) {
      expect(args.extraAuditMetadata).toMatchObject({
        settlementGatewayAmount: 240,
        settlementExpectedAmount: 240,
        settlementOrderCount: 4,
      })
    }
  })
})

describe('#268 #223’s refusals are unchanged', () => {
  test('an ABSENT amount still never reaches the success loop', async () => {
    await POST(makeReq({ merchant_order_no: 'MO-3', trans_status: 2 }))
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    expect(auditInserts.some((a) => a.action === 'payment.verification_uncertain')).toBe(true)
  })

  test('a DISAGREEING amount is still refused, and nothing is written', async () => {
    await POST(makeReq({ merchant_order_no: 'MO-2', trans_status: 2, amount: 20 }))
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    expect(auditInserts.some((a) => a.action === 'payment.amount_mismatch')).toBe(true)
  })
})
