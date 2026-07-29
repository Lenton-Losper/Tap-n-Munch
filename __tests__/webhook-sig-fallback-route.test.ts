/**
 * Route-level coverage: invalid signature → Finatic fallback decision tree.
 * Mocks verifyWebhook failure and Finatic confirmation; asserts HTTP outcomes.
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

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'orders') {
        return {
          select: () => ({
            in: async () => ({
              data: [{ id: 'ord-1', restaurant_id: 'rest-1', total: 11.5, payment_method: 'card' }],
              error: null,
            }),
          }),
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

describe('POST /api/webhooks/paycloud signature-fallback paths', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    enforceWebhookRateLimit.mockReturnValue({ allowed: true })
    verifyWebhook.mockReturnValue({
      ok: false,
      reason: 'Encrypted message length is invalid.',
    })
    resolveOrderIdsByMerchantOrderNo.mockResolvedValue({
      orderIds: ['ord-1'],
      source: 'orders',
    })
  })

  test('SCENARIO_A HTTP: fallback_verified_paid → 200 success + mark paid', async () => {
    confirmWebhookOrderViaFinaticFallback.mockResolvedValue({
      path: 'fallback_verified_paid',
      finatic: {
        paid: true,
        merchantOrderNo: 'MO-A',
        status: '2',
        transactionId: 'TXN-A',
        amount: 11.5,
        raw: {},
      },
      orderIds: ['ord-1'],
      restaurantId: 'rest-1',
      orderTotal: 11.5,
    })

    const res = await POST(
      makeReq(
        {
          merchant_order_no: 'MO-A',
          // Untrusted payload claims NOT paid — must be ignored.
          trans_status: 1,
          sign: 'deadbeef',
        },
        { 'x-paycloud-sign': 'deadbeef' },
      ),
    )
    const text = await res.text()
    console.log(
      'SCENARIO_A_HTTP_PAID_FALLBACK',
      JSON.stringify({ status: res.status, text }, null, 2),
    )
    expect(res.status).toBe(200)
    expect(text.trim()).toBe('success')
    expect(markOrderPaidConfirmed).toHaveBeenCalledTimes(1)
    expect(markOrderPaidConfirmed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: 'ord-1',
        restaurantId: 'rest-1',
        reference: 'MO-A',
        amount: 11.5,
        source: 'paycloud_webhook_fallback_finatic_verified',
        extraAuditMetadata: expect.objectContaining({
          path: 'fallback_verified_paid',
          finaticTransactionId: 'TXN-A',
        }),
      }),
    )
    console.log('SCENARIO_A_FALLBACK_VERIFIED_PAID_OK')
  })

  test('SCENARIO_B HTTP: fallback_verified_not_paid → 200 success, do NOT mark paid', async () => {
    confirmWebhookOrderViaFinaticFallback.mockResolvedValue({
      path: 'fallback_verified_not_paid',
      finatic: {
        paid: false,
        merchantOrderNo: 'MO-B',
        status: 'failed',
        transactionId: null,
        amount: null,
        raw: {},
      },
      orderIds: ['ord-1'],
    })

    const res = await POST(
      makeReq(
        {
          merchant_order_no: 'MO-B',
          // Untrusted payload claims PAID — must be ignored.
          trans_status: 2,
          sign: 'deadbeef',
        },
        { 'x-paycloud-sign': 'deadbeef' },
      ),
    )
    const text = await res.text()
    console.log(
      'SCENARIO_B_HTTP_NOT_PAID_FALLBACK',
      JSON.stringify({ status: res.status, text }, null, 2),
    )
    expect(res.status).toBe(200)
    expect(text.trim()).toBe('success')
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    console.log('SCENARIO_B_FALLBACK_VERIFIED_NOT_PAID_OK')
  })

  test('SCENARIO_C HTTP: fallback_query_failed → 503, do NOT mark paid', async () => {
    confirmWebhookOrderViaFinaticFallback.mockResolvedValue({
      path: 'fallback_query_failed',
      reason: 'PayCloud service unavailable (network failure)',
      orderIds: ['ord-1'],
    })

    const res = await POST(
      makeReq(
        {
          merchant_order_no: 'MO-C',
          trans_status: 2,
          sign: 'deadbeef',
        },
        { 'x-paycloud-sign': 'deadbeef' },
      ),
    )
    const json = await res.json()
    console.log(
      'SCENARIO_C_HTTP_UNREACHABLE_FALLBACK',
      JSON.stringify({ status: res.status, json }, null, 2),
    )
    expect(res.status).toBe(503)
    expect(String(json.error || '')).toMatch(/Finatic fallback query unavailable/)
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    console.log('SCENARIO_C_FALLBACK_QUERY_FAILED_OK')
  })
})
