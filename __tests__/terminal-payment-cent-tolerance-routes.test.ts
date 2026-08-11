/**
 * #180 at the ROUTE level — a one-cent CLIENT difference must not cost the restaurant the order.
 *
 * __tests__/amounts-match-cent-tolerance.test.ts pins the helper. That is not enough on its
 * own: what matters is what the payment routes DO with the answer.
 *
 *   payment/route.ts:79    400 AMOUNT_MISMATCH — the card is already charged by then
 *   settle/route.ts:224    400 AMOUNT_MISMATCH — same, for a whole tab
 *
 * SCOPE NARROWED BY #190. This file covered verify-payment/route.ts as a third case, asserting
 * that a one-cent difference there was APPLIED. That is no longer the behaviour and the
 * assertion was reversed, not deleted: verify-payment is a GATEWAY leg, where Finatic echoes
 * back our own figure and a cent of daylight means the reference correlated to a different
 * sale. It now takes exact agreement, and an absent amount is refused as unverified.
 *
 * That route's coverage moved WHOLE to __tests__/gateway-amount-exact-match.test.ts, which
 * asserts strictly more about it (exact applies, one cent refused, null refused, audit row
 * written) and holds it side by side with the two client legs below so the split cannot drift.
 * What remains here is the client-tolerance half of that split.
 *
 * Every case is asserted in BOTH directions: one cent must pass, two cents must still fail.
 * Without the two-cent half, widening the tolerance to something absurd would satisfy every
 * assertion here and the suite would pin nothing.
 *
 * The amounts are deliberately 78.35/78.36 — an exact one-cent pair that the float comparison
 * refused (78.36 - 78.35 === 0.010000000000005116). A pair like 34.99/35.00 would have passed
 * against the broken code and proved nothing.
 */
import { NextRequest } from 'next/server'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const TAB_ID = '7c2f9a51-3f0e-4a6d-9a3e-1f5c2b8d4e77'
const MERCHANT_ORDER_NO = 'FT17863184148250674'

/** The order total every case is measured against. One cent above/below it are the fixtures. */
const SERVER_TOTAL = 78.35
const ONE_CENT_OVER = 78.36
const TWO_CENTS_OVER = 78.37

type Row = Record<string, unknown>

let orderRow: Row
let tabRow: Row
let tabOrders: Row[]

// ---------------------------------------------------------------- module mocks

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_UUID,
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))

const markOrderPaidConfirmed = jest.fn(async (..._args: unknown[]) => ({
  claimed: true,
  tabId: null as string | null,
  reason: null as string | null,
}))
jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: (...args: unknown[]) => markOrderPaidConfirmed(...args),
}))

const queryFinaticOrderPaid = jest.fn(async (..._args: unknown[]) => ({
  paid: true,
  merchantOrderNo: MERCHANT_ORDER_NO,
  status: 'paid',
  transactionId: 'TXN-1',
  amount: ONE_CENT_OVER,
  raw: {},
}))
jest.mock('@/lib/payments/query-finatic-order-paid', () => ({
  queryFinaticOrderPaid: (...args: unknown[]) => queryFinaticOrderPaid(...args),
  finaticErrorCode: () => null,
  isFinaticMerchantOrderInvalidError: () => false,
}))

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({
    merchantNo: 'M1',
    storeNo: 'S1',
    terminalSn: 'SN1',
  }),
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: async () => undefined,
}))

/**
 * Table-aware PostgREST stand-in, same shape as the one in
 * __tests__/table-close-payment-safety.test.ts: `from(table)` returns a builder that records
 * the operation and its filters, and resolves from the mutable fixtures above.
 */
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const state = { table, op: 'select', filters: [] as string[] }
      const b: Record<string, unknown> = {}
      const resolveList = () => {
        if (state.table === 'orders' && state.op === 'update') {
          // The settle route's atomic claim, read back via .select('id').
          return { data: tabOrders.map((o) => ({ id: o.id })), error: null }
        }
        if (state.table === 'orders' && state.filters.includes('in:id')) {
          return { data: tabOrders, error: null }
        }
        // Any remaining orders read is a "what is still unpaid" question; nothing is.
        return { data: [], error: null }
      }
      Object.assign(b, {
        select: () => b,
        update: () => {
          state.op = 'update'
          return b
        },
        insert: async () => ({ data: null, error: null }),
        eq: () => b,
        neq: () => b,
        in: (col: string) => {
          state.filters.push(`in:${col}`)
          return b
        },
        is: () => b,
        or: () => b,
        order: () => b,
        limit: () => b,
        single: async () => ({
          data: state.table === 'tabs' ? tabRow : orderRow,
          error: null,
        }),
        maybeSingle: async () => ({
          data: state.table === 'tabs' ? tabRow : orderRow,
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) => resolve(resolveList()),
      })
      return b
    },
  }),
}))

// ---------------------------------------------------------------- fixtures

beforeEach(() => {
  markOrderPaidConfirmed.mockClear()
  queryFinaticOrderPaid.mockClear()

  orderRow = {
    id: ORDER_ID,
    tab_id: null,
    restaurant_id: RESTAURANT_UUID,
    status: 'pending',
    total: SERVER_TOTAL,
    payment_status: 'pending',
    paycloud_merchant_order_no: MERCHANT_ORDER_NO,
  }
  tabRow = {
    id: TAB_ID,
    table_id: 'table-uuid-1',
    total: SERVER_TOTAL,
    status: 'open',
    settled_at: null,
  }
  tabOrders = [
    {
      id: ORDER_ID,
      total: SERVER_TOTAL,
      payment_status: 'pending',
      terminal_pushed_at: null,
    },
  ]
})

function jsonRequest(url: string, body: unknown, method = 'POST') {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------- payment route

describe('POST /api/terminal/orders/[orderId]/payment — amount tolerance', () => {
  const call = async (amount: number) => {
    const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
    const res = await POST(
      jsonRequest('https://staging.test/api/terminal/orders/x/payment', {
        status: 'success',
        reference: 'FT-OK-1',
        amount,
        paymentMethod: 'card',
        businessOrderNo: MERCHANT_ORDER_NO,
      }),
      { params: Promise.resolve({ orderId: ORDER_ID }) },
    )
    return { res, body: await res.json() }
  }

  it('accepts a one-cent difference and marks the order paid', async () => {
    const { res, body } = await call(ONE_CENT_OVER)

    // The card has already been charged at this point; a 400 here takes the money and
    // leaves the order unpaid.
    expect({ status: res.status, code: body.code }).toEqual({ status: 200, code: undefined })
    expect(body.success).toBe(true)
    expect(markOrderPaidConfirmed).toHaveBeenCalledTimes(1)
  })

  it('still rejects a two-cent difference', async () => {
    const { res, body } = await call(TWO_CENTS_OVER)

    expect({ status: res.status, code: body.code }).toEqual({
      status: 400,
      code: 'AMOUNT_MISMATCH',
    })
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- settle route

describe('POST /api/terminal/tabs/[tabId]/settle — amount tolerance', () => {
  const call = async (amount: number) => {
    const { POST } = await import('@/app/api/terminal/tabs/[tabId]/settle/route')
    const res = await POST(
      jsonRequest('https://staging.test/api/terminal/tabs/x/settle', {
        order_ids: [ORDER_ID],
        amount,
        method: 'card',
        gateway_reference: 'GW-1',
      }),
      { params: Promise.resolve({ tabId: TAB_ID }) },
    )
    return { res, body: await res.json() }
  }

  it('accepts a one-cent difference and settles the tab', async () => {
    const { res, body } = await call(ONE_CENT_OVER)

    expect({ status: res.status, code: body.code }).toEqual({ status: 200, code: undefined })
    expect(body.success).toBe(true)
  })

  it('still rejects a two-cent difference', async () => {
    const { res, body } = await call(TWO_CENTS_OVER)

    expect({ status: res.status, code: body.code }).toEqual({
      status: 400,
      code: 'AMOUNT_MISMATCH',
    })
  })
})

// verify-payment/route.ts moved to __tests__/gateway-amount-exact-match.test.ts — see the
// SCOPE NARROWED BY #190 note in the file header above.
