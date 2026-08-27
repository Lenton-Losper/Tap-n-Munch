/**
 * #153, SITE TWO — the terminal's "Check payment status" button must not blame the network for a
 * configuration fault.
 *
 * THE DEFECT. `getRestaurantFinaticCredentials` sat bare inside the route's outer try, so a venue
 * with no credentials fell into the catch at the bottom and came back as HTTP 502 with the raw
 * exception text. 502 is Bad Gateway. It tells staff the payment provider cannot be reached and
 * that waiting is the answer — for a venue whose network is fine and whose wait will never end.
 * On production 2026-08-26, 8 of 11 venues are in exactly that state.
 *
 * BOTH DIRECTIONS ARE ASSERTED. A test that only pinned the new 400 would be satisfied by
 * returning 400 for every failure, which would tell staff a real outage is a setup problem. So the
 * unreachable case is pinned at 502 in the same file, side by side, and the split cannot drift.
 *
 * WORDING IS NOT ASSERTED. The staff-facing strings are placeholders pending owner-signed copy
 * (lib/payments/verify-payment-outcome.ts). What is asserted is the CODE, which is the contract a
 * terminal build branches on, and the fact that a message is present at all.
 */
import { NextRequest } from 'next/server'
import { VERIFY_PAYMENT_OUTCOME_CODES } from '@/lib/payments/verify-payment-outcome'
import { MissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const MERCHANT_ORDER_NO = 'FT17863184148250674'

type Row = Record<string, unknown>

let orderRow: Row

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_UUID,
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))

const markOrderPaidConfirmed = jest.fn(async () => ({ claimed: true, tabId: null, reason: null }))
jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: (...args: unknown[]) => markOrderPaidConfirmed(...(args as [])),
}))

const queryFinaticOrderPaid = jest.fn()
jest.mock('@/lib/payments/query-finatic-order-paid', () => ({
  queryFinaticOrderPaid: (...args: unknown[]) => queryFinaticOrderPaid(...(args as [])),
  finaticErrorCode: () => null,
  isFinaticMerchantOrderInvalidError: () => false,
}))

const getCredentials = jest.fn()
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: (...args: unknown[]) => getCredentials(...(args as [])),
}))

const auditInserts: Row[] = []
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        update: () => b,
        insert: (row: Row) => {
          if (table === 'audit_logs') auditInserts.push(row)
          return { error: null }
        },
        maybeSingle: async () => ({ data: table === 'orders' ? orderRow : null, error: null }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      })
      return b
    },
  }),
}))

const post = async () => {
  const { POST } = await import('@/app/api/terminal/orders/[orderId]/verify-payment/route')
  const req = new NextRequest(`http://localhost/api/terminal/orders/${ORDER_ID}/verify-payment`, {
    method: 'POST',
  })
  const res = await POST(req, { params: Promise.resolve({ orderId: ORDER_ID }) })
  return { status: res.status, body: (await res.json()) as Row }
}

beforeEach(() => {
  auditInserts.length = 0
  getCredentials.mockReset()
  queryFinaticOrderPaid.mockReset()
  orderRow = {
    id: ORDER_ID,
    restaurant_id: RESTAURANT_UUID,
    payment_status: 'pending',
    total: 78.35,
    paycloud_merchant_order_no: MERCHANT_ORDER_NO,
  }
})

describe('verify-payment when the restaurant has no Finatic credentials', () => {
  it('answers 400 with a credentials code, NOT 502', async () => {
    getCredentials.mockImplementation(async () => {
      throw new MissingFinaticCredentialsError(RESTAURANT_UUID)
    })

    const { status, body } = await post()

    expect(status).toBe(400)
    expect(body.code).toBe(VERIFY_PAYMENT_OUTCOME_CODES.CREDENTIALS_NOT_CONFIGURED)
    // The gateway is never asked; there is nothing to ask it with.
    expect(queryFinaticOrderPaid).not.toHaveBeenCalled()
    // `paid: false` here is the ABSENCE of an answer, not a negative one, and the response has to
    // say so — otherwise staff read "not paid" and charge a card that may already be charged.
    expect(body.paid).toBe(false)
    expect(body.verified).toBe(false)
    expect(String(body.error ?? '')).not.toBe('')
    // Nothing is applied and nothing is written on this path.
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
  })
})

describe('verify-payment when the gateway is genuinely unreachable', () => {
  it('still answers 502 — the transient case keeps its own code', async () => {
    getCredentials.mockImplementation(async () => ({ merchantNo: 'M1', storeNo: 'S1' }))
    queryFinaticOrderPaid.mockImplementation(async () => {
      throw new Error('fetch failed: ETIMEDOUT')
    })

    const { status, body } = await post()

    expect(status).toBe(502)
    expect(body.code).toBe(VERIFY_PAYMENT_OUTCOME_CODES.PROVIDER_UNREACHABLE)
    expect(body.code).not.toBe(VERIFY_PAYMENT_OUTCOME_CODES.CREDENTIALS_NOT_CONFIGURED)
    expect(String(body.staffMessage ?? '')).not.toBe('')
  })
})

describe('verify-payment when the gateway answers and there is no payment', () => {
  it('is a THIRD state — 200, asked and answered, nothing to confirm yet', async () => {
    getCredentials.mockImplementation(async () => ({ merchantNo: 'M1', storeNo: 'S1' }))
    queryFinaticOrderPaid.mockImplementation(async () => ({
      paid: false,
      merchantOrderNo: MERCHANT_ORDER_NO,
      status: 'unpaid',
      transactionId: null,
      amount: null,
      raw: {},
    }))

    const { status, body } = await post()

    expect(status).toBe(200)
    expect(body.verified).toBe(true)
    expect(body.code).toBe(VERIFY_PAYMENT_OUTCOME_CODES.NOT_CONFIRMED)
  })

  it('and a CONFIRMED payment carries no failure code at all', async () => {
    getCredentials.mockImplementation(async () => ({ merchantNo: 'M1', storeNo: 'S1' }))
    queryFinaticOrderPaid.mockImplementation(async () => ({
      paid: true,
      merchantOrderNo: MERCHANT_ORDER_NO,
      status: 'paid',
      transactionId: 'TXN-1',
      amount: 78.35,
      raw: {},
    }))

    const { status, body } = await post()

    expect(status).toBe(200)
    expect(body.paid).toBe(true)
    expect(body.code).toBeNull()
    expect(body.staffMessage).toBeNull()
  })
})
