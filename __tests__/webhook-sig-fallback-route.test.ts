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

const safeIssueReceiptsForOrders = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: (...args: unknown[]) => safeIssueReceiptsForOrders(...args),
}))

const orderUpdate = jest.fn()
const auditInsert = jest.fn(async (..._args: unknown[]) => ({ error: null }))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'orders') {
        return {
          update: () => ({
            in: (..._a: unknown[]) => {
              orderUpdate()
              const result = Promise.resolve({ error: null }) as Promise<{ error: null }> & {
                is: () => Promise<{ error: null }>
              }
              result.is = async () => ({ error: null })
              return result
            },
          }),
          select: () => ({
            in: async () => ({
              data: [{ id: 'ord-1', payment_status: 'pending' }],
              error: null,
            }),
          }),
        }
      }
      if (table === 'audit_logs') {
        return {
          insert: async (row: unknown) => {
            auditInsert(row)
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
    expect(orderUpdate).toHaveBeenCalled()
    expect(auditInsert).toHaveBeenCalled()
    expect(safeIssueReceiptsForOrders).toHaveBeenCalledWith(['ord-1'], 'webhooks/paycloud')
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
    expect(orderUpdate).not.toHaveBeenCalled()
    expect(auditInsert).not.toHaveBeenCalled()
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
    expect(orderUpdate).not.toHaveBeenCalled()
    console.log('SCENARIO_C_FALLBACK_QUERY_FAILED_OK')
  })
})
