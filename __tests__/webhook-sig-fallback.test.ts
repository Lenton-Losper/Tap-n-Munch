/**
 * Unit coverage for invalid-signature webhook → Finatic order.query fallback.
 * Prints scenario output so CI/local logs match the HTTP probe shape.
 */
import {
  confirmWebhookOrderViaFinaticFallback,
} from '@/lib/payments/webhook-sig-fallback'

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: jest.fn(async () => ({
    merchantNo: 'MERCHANT-TEST',
    storeNo: 'STORE-TEST',
  })),
}))

const queryFinaticOrderPaid = jest.fn()
jest.mock('@/lib/payments/query-finatic-order-paid', () => ({
  queryFinaticOrderPaid: (...args: unknown[]) => queryFinaticOrderPaid(...args),
}))

const stagingFinaticQueryStub = jest.fn()
jest.mock('@/lib/payments/staging-finatic-stub', () => ({
  stagingFinaticQueryStub: (...args: unknown[]) => stagingFinaticQueryStub(...args),
}))

function makeSupabase(orders: Array<Record<string, unknown>>) {
  return {
    from: (table: string) => {
      if (table !== 'orders') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          in: async () => ({ data: orders, error: null }),
        }),
      }
    },
  } as any
}

describe('confirmWebhookOrderViaFinaticFallback', () => {
  beforeEach(() => {
    queryFinaticOrderPaid.mockReset()
    stagingFinaticQueryStub.mockReset()
    stagingFinaticQueryStub.mockReturnValue(undefined)
  })

  test('SCENARIO_A: Finatic confirms paid → fallback_verified_paid (never trusts payload)', async () => {
    queryFinaticOrderPaid.mockResolvedValue({
      paid: true,
      merchantOrderNo: 'FTWHPAID1',
      status: '2',
      transactionId: 'TXN-A',
      amount: 11.5,
      raw: { code: '0' },
    })

    const result = await confirmWebhookOrderViaFinaticFallback({
      supabase: makeSupabase([
        {
          id: 'order-a',
          restaurant_id: 'rest-1',
          total: 11.5,
          payment_status: 'pending',
        },
      ]),
      merchantOrderNo: 'FTWHPAID1',
      orderIds: ['order-a'],
      // Untrusted webhook may claim anything; stub unused — real query decides.
      stagingFinaticStub: undefined,
    })

    console.log('SCENARIO_A_FALLBACK_RESULT', JSON.stringify(result, null, 2))
    expect(result.path).toBe('fallback_verified_paid')
    if (result.path === 'fallback_verified_paid') {
      expect(result.orderIds).toEqual(['order-a'])
      expect(result.finatic.paid).toBe(true)
      expect(result.finatic.transactionId).toBe('TXN-A')
    }
    expect(queryFinaticOrderPaid).toHaveBeenCalledWith({
      merchantOrderNo: 'FTWHPAID1',
      merchantNo: 'MERCHANT-TEST',
      storeNo: 'STORE-TEST',
    })
    console.log('SCENARIO_A_FALLBACK_VERIFIED_PAID_OK')
  })

  test('SCENARIO_B: Finatic confirms not paid → fallback_verified_not_paid (ignore payload paid claim)', async () => {
    queryFinaticOrderPaid.mockResolvedValue({
      paid: false,
      merchantOrderNo: 'FTWHNP1',
      status: 'failed',
      transactionId: null,
      amount: null,
      raw: { code: '0' },
    })

    const result = await confirmWebhookOrderViaFinaticFallback({
      supabase: makeSupabase([
        {
          id: 'order-b',
          restaurant_id: 'rest-1',
          total: 11.5,
          payment_status: 'pending',
        },
      ]),
      merchantOrderNo: 'FTWHNP1',
      orderIds: ['order-b'],
    })

    console.log('SCENARIO_B_FALLBACK_RESULT', JSON.stringify(result, null, 2))
    expect(result.path).toBe('fallback_verified_not_paid')
    if (result.path === 'fallback_verified_not_paid') {
      expect(result.finatic.paid).toBe(false)
    }
    console.log('SCENARIO_B_FALLBACK_VERIFIED_NOT_PAID_OK')
  })

  test('SCENARIO_C: Finatic unreachable → fallback_query_failed (retry / cron safety net)', async () => {
    queryFinaticOrderPaid.mockRejectedValue(new Error('PayCloud service unavailable (network failure)'))

    const result = await confirmWebhookOrderViaFinaticFallback({
      supabase: makeSupabase([
        {
          id: 'order-c',
          restaurant_id: 'rest-1',
          total: 11.5,
          payment_status: 'pending',
        },
      ]),
      merchantOrderNo: 'FTWHUN1',
      orderIds: ['order-c'],
    })

    console.log('SCENARIO_C_FALLBACK_RESULT', JSON.stringify(result, null, 2))
    expect(result.path).toBe('fallback_query_failed')
    if (result.path === 'fallback_query_failed') {
      expect(result.reason).toMatch(/unavailable|network/i)
    }
    console.log('SCENARIO_C_FALLBACK_QUERY_FAILED_OK')
  })

  test('no local order → cannot resolve restaurant credentials', async () => {
    const result = await confirmWebhookOrderViaFinaticFallback({
      supabase: makeSupabase([]),
      merchantOrderNo: 'MISSING',
      orderIds: [],
    })
    expect(result.path).toBe('fallback_query_failed')
    expect(queryFinaticOrderPaid).not.toHaveBeenCalled()
  })

  test('staging stub paid bypasses live Finatic query', async () => {
    process.env.ENVIRONMENT = 'staging'
    const stubFn = jest.fn(async () => ({
      paid: true,
      merchantOrderNo: 'STUB',
      status: '2',
      transactionId: 'STUB-TXN',
      amount: null,
      raw: { stub: 'paid' },
    }))
    stagingFinaticQueryStub.mockReturnValue(stubFn)

    // Re-require path uses mocked stub module already wired above.
    const result = await confirmWebhookOrderViaFinaticFallback({
      supabase: makeSupabase([
        {
          id: 'order-stub',
          restaurant_id: 'rest-1',
          total: 9,
          payment_status: 'pending',
        },
      ]),
      merchantOrderNo: 'STUB-MO',
      orderIds: ['order-stub'],
      stagingFinaticStub: 'paid',
    })

    console.log('STAGING_STUB_PAID_RESULT', JSON.stringify(result, null, 2))
    expect(result.path).toBe('fallback_verified_paid')
    expect(queryFinaticOrderPaid).not.toHaveBeenCalled()
    expect(stubFn).toHaveBeenCalled()
    delete process.env.ENVIRONMENT
  })
})
