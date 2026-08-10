/**
 * END-TO-END over the HTTP boundary: real route handler -> REAL handleTerminalPaymentFailed.
 *
 * The sibling suite (terminal-cancel-payload-reaches-handler) mocks the handler and asserts on
 * the params it was handed. That proves the wiring but not the consequence, and "the call was
 * made" is exactly the weak assertion that let this ship: the ORIGINAL bypass suite proved the
 * handler's logic with a direct call, the route never forwarded the fields, and both were green.
 *
 * So this suite mocks NOTHING between the request body and the decision. It asserts on the two
 * things that actually matter to a customer:
 *
 *   1. Finatic was NOT queried  — the bypass fired
 *   2. the row was cancelled with cancellation_reason = terminal_cancelled_by_user_pre_gateway
 *
 * and, as the control, that an ordinary failure with the same shape DOES query Finatic. Without
 * that control, a handler that never queries anything would pass test 1 trivially.
 *
 * Staging order #79 (2026-08-09T23:33:50Z) is what this would have caught: operator cancelled,
 * terminal vc83 classified K026 correctly, and the audit row still read
 * requestedCancellationReason "payment_declined" because the route dropped both fields.
 */
import { NextRequest } from 'next/server'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const MERCHANT_ORDER_NO = 'FT17863184148250674'
const CANCEL_REASON = 'terminal_cancelled_by_user_pre_gateway'

/** Spy on the gateway call. Not calling this IS the bypass. */
const queryFinaticOrderPaid = jest.fn(async () => ({
  paid: false,
  status: 'NOT_PAID',
  transactionId: null,
  amount: null,
}))

jest.mock('@/lib/payments/query-finatic-order-paid', () => ({
  queryFinaticOrderPaid: (...a: unknown[]) =>
    (queryFinaticOrderPaid as unknown as (...x: unknown[]) => unknown)(...a),
  finaticErrorCode: () => null,
  isFinaticMerchantOrderInvalidError: () => false,
}))

/** Real credentials exist here, so a Finatic query WOULD succeed — the bypass is the only reason it does not happen. */
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({
    merchantNo: 'UAT-MERCHANT',
    storeNo: 'UAT-STORE',
  }),
}))

jest.mock('@/lib/payments/staging-finatic-stub', () => ({
  stagingFinaticQueryStub: () => null,
}))

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_UUID,
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    permissions: ['orders:update'],
  }),
  validateTerminalRecord: async () => undefined,
}))

jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: async () => ({ claimed: true, tabId: null }),
}))
jest.mock('@/lib/tabs/settle-tab-state', () => ({
  clearReadyToPayAndReopenTab: async () => undefined,
}))

const ORDER_ROW = {
  id: ORDER_ID,
  restaurant_id: RESTAURANT_UUID,
  total: 25,
  payment_status: 'pending',
  status: 'pending',
  payment_method: 'card',
  paycloud_merchant_order_no: MERCHANT_ORDER_NO,
  tab_id: null,
}

/** Records what the handler writes, so the assertions are about the row, not the return value. */
const writes: { updates: Record<string, unknown>[]; audits: Record<string, unknown>[] } = {
  updates: [],
  audits: [],
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {}
      Object.assign(builder, {
        select: () => builder,
        eq: () => builder,
        neq: () => builder,
        in: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        update: (patch: Record<string, unknown>) => {
          if (table === 'orders') writes.updates.push(patch)
          return builder
        },
        insert: async (row: Record<string, unknown>) => {
          if (table === 'audit_logs') writes.audits.push(row)
          return { data: null, error: null }
        },
        single: async () => ({ data: ORDER_ROW, error: null }),
        maybeSingle: async () => ({ data: ORDER_ROW, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: [{ id: ORDER_ID }], error: null }),
      })
      return builder
    },
  }),
}))

function post(body: unknown) {
  return new NextRequest('https://staging.test/api/terminal/orders/x/payment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(body),
  })
}
const routeParams = { params: Promise.resolve({ orderId: ORDER_ID }) }

const BASE = {
  status: 'failed',
  reference: 'UNCONFIRMED-1786318429901',
  amount: 25,
  paymentMethod: 'card',
  businessOrderNo: MERCHANT_ORDER_NO,
}

beforeEach(() => {
  queryFinaticOrderPaid.mockClear()
  writes.updates = []
  writes.audits = []
})

describe('user cancel travels from HTTP body to a cancelled row without touching Finatic', () => {
  it('does not query Finatic, and cancels with the terminal reason', async () => {
    const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
    await POST(
      post({ ...BASE, cancellationReason: CANCEL_REASON, noGatewayAttempt: true }),
      routeParams,
    )

    // 1. The bypass fired. Credentials are present and the merchant order number is set, so the
    //    ONLY thing that can suppress this call is the payload arriving intact.
    expect(queryFinaticOrderPaid).not.toHaveBeenCalled()

    // 2. The row was cancelled, carrying the terminal's reason rather than the server default.
    const cancel = writes.updates.find((u) => u.payment_status === 'cancelled')
    expect(cancel).toBeDefined()
    expect(cancel?.cancellation_reason).toBe(CANCEL_REASON)
    expect(cancel?.status).toBe('cancelled')

    // 3. The audit records this as the terminal's assertion, not gateway confirmation.
    const audit = writes.audits[0]?.metadata as Record<string, unknown> | undefined
    expect(audit?.cancellation_reason).toBe(CANCEL_REASON)
    expect(audit?.evidence_basis).toBe('terminal_asserted')
    expect(audit?.finaticVerifiedBeforeCancel).toBe(false)
  })

  it('CONTROL: the same request without the flag DOES query Finatic', async () => {
    // Without this, "Finatic was not called" would also pass if the query were broken outright,
    // or if the route rejected the request before reaching the handler at all.
    const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
    await POST(post({ ...BASE, cancellationReason: CANCEL_REASON }), routeParams)

    expect(queryFinaticOrderPaid).toHaveBeenCalledTimes(1)
    expect(queryFinaticOrderPaid).toHaveBeenCalledWith(
      expect.objectContaining({ merchantOrderNo: MERCHANT_ORDER_NO }),
    )
  })

  it('CONTROL: the flag alone, with the wrong reason, does NOT bypass', async () => {
    // Both halves are required. A stray flag on an ordinary decline must not skip verification.
    const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
    await POST(
      post({ ...BASE, cancellationReason: 'payment_declined', noGatewayAttempt: true }),
      routeParams,
    )

    expect(queryFinaticOrderPaid).toHaveBeenCalledTimes(1)
  })

  it('CONTROL: a near-miss reason does not bypass', async () => {
    // The handler matches with ===. Pinning one adjacent value here at the ROUTE level, because
    // the route is where a future "helpful" normalisation would be added.
    const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
    await POST(
      post({
        ...BASE,
        cancellationReason: 'Terminal_Cancelled_By_User_Pre_Gateway',
        noGatewayAttempt: true,
      }),
      routeParams,
    )

    expect(queryFinaticOrderPaid).toHaveBeenCalledTimes(1)
  })
})
