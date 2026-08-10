/**
 * The user-cancel bypass was unreachable over HTTP for its entire life, and every existing test
 * passed the whole time.
 *
 * `handleTerminalPaymentFailed` honours `noGatewayAttempt` + an exact `cancellationReason`, and
 * __tests__/terminal-user-cancel-bypass.test.ts proves it does — by calling the function
 * DIRECTLY. Neither route forwarded the fields:
 *
 *   POST /api/terminal/orders/[orderId]/payment  — read neither field off the body
 *   PATCH /api/terminal/orders/[orderId]/status  — forwarded cancellationReason, never the flag
 *
 * The route reads `body` as `any` and pulls named fields off it one at a time, so unknown fields
 * are silently discarded. There is no type error to catch: the terminal's payload type and the
 * server's params type are separate declarations either side of an HTTP boundary, and nothing
 * links them. Staging order #79 (2026-08-09 23:33:50Z) is the recorded consequence — the operator
 * cancelled, the terminal classified it correctly, and the audit row still read
 * `requestedCancellationReason: "payment_declined"`, the server's default for "no reason sent".
 *
 * THIS SUITE THEREFORE ASSERTS ON THE BOUNDARY, NOT THE BEHAVIOUR. It drives the real exported
 * route handlers over a real Request with a real JSON body, and inspects the params object
 * `handleTerminalPaymentFailed` was actually called with. A test that calls the function
 * directly — however thorough about the bypass logic — cannot fail when the wiring is missing,
 * which is precisely how this shipped.
 */
import { NextRequest } from 'next/server'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const MERCHANT_ORDER_NO = 'FT17863184148250674'
const CANCEL_REASON = 'terminal_cancelled_by_user_pre_gateway'

/** Records the params every call receives, so the assertions are about the boundary. */
const handleTerminalPaymentFailed = jest.fn(async () => ({
  outcome: 'cancelled' as const,
  tabId: null,
}))

jest.mock('@/lib/payments/handle-terminal-payment-failed', () => ({
  handleTerminalPaymentFailed: (...args: unknown[]) =>
    (handleTerminalPaymentFailed as unknown as (...a: unknown[]) => unknown)(...args),
  TERMINAL_USER_CANCELLED_REASON: 'terminal_cancelled_by_user_pre_gateway',
}))

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_UUID,
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    permissions: ['orders:update'],
  }),
  validateTerminalRecord: async () => undefined,
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

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const builder: Record<string, unknown> = {}
    Object.assign(builder, {
      select: () => builder,
      eq: () => builder,
      neq: () => builder,
      in: () => builder,
      is: () => builder,
      update: () => builder,
      insert: async () => ({ data: null, error: null }),
      order: () => builder,
      limit: () => builder,
      single: async () => ({ data: ORDER_ROW, error: null }),
      maybeSingle: async () => ({ data: ORDER_ROW, error: null }),
      then: (resolve: (v: unknown) => unknown) => resolve({ data: [ORDER_ROW], error: null }),
    })
    return { from: () => builder }
  },
}))

jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: async () => ({ claimed: true, tabId: null }),
}))
// `virtual: true` because this module does not exist on every base this suite may be applied to
// (it arrives with #123). The route only imports it where present; mocking it virtually keeps the
// suite identical across branches rather than forking the test file per base.
jest.mock(
  '@/lib/tabs/settle-tab-state',
  () => ({ clearReadyToPayAndReopenTab: async () => undefined }),
  { virtual: true },
)

function paymentRequest(body: unknown) {
  return new NextRequest('https://staging.test/api/terminal/orders/x/payment', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(body),
  })
}

function statusRequest(body: unknown) {
  return new NextRequest('https://staging.test/api/terminal/orders/x/status', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(body),
  })
}

const routeParams = { params: Promise.resolve({ orderId: ORDER_ID }) }

/** The exact payload src/screens/PaymentScreen.tsx sends for outcomeKind 'user_cancelled'. */
const TERMINAL_CANCEL_BODY = {
  status: 'failed',
  reference: 'UNCONFIRMED-1786318429901',
  amount: 25,
  paymentMethod: 'card',
  businessOrderNo: MERCHANT_ORDER_NO,
  cancellationReason: CANCEL_REASON,
  noGatewayAttempt: true,
}

beforeEach(() => {
  handleTerminalPaymentFailed.mockClear()
})

describe('POST /api/terminal/orders/[orderId]/payment forwards the cancel classification', () => {
  it('passes cancellationReason and noGatewayAttempt through to the handler', async () => {
    const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
    await POST(paymentRequest(TERMINAL_CANCEL_BODY), routeParams)

    expect(handleTerminalPaymentFailed).toHaveBeenCalledTimes(1)
    const params = (handleTerminalPaymentFailed.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >

    // The two assertions that were false in production for the whole life of the feature.
    expect(params.cancellationReason).toBe(CANCEL_REASON)
    expect(params.noGatewayAttempt).toBe(true)
  })

  it('does not invent a reason when the terminal sends none', async () => {
    // The server defaults an absent reason to 'payment_declined' inside the handler. The ROUTE
    // must not pre-empt that with a value of its own, or the handler's exact-match check is
    // comparing against something this layer made up.
    const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
    await POST(
      paymentRequest({ status: 'failed', reference: 'UNCONFIRMED-1', amount: 25, paymentMethod: 'card' }),
      routeParams,
    )

    const params = (handleTerminalPaymentFailed.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >
    expect(params.cancellationReason).toBeUndefined()
    expect(params.noGatewayAttempt).toBe(false)
  })

  it('does not treat the STRING "false" as a bypass', async () => {
    // `body.noGatewayAttempt` is untyped JSON. "false" is truthy, so a truthy check here would
    // hand the handler a bypass the terminal never asked for.
    const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
    await POST(
      paymentRequest({ ...TERMINAL_CANCEL_BODY, noGatewayAttempt: 'false' }),
      routeParams,
    )

    const params = (handleTerminalPaymentFailed.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >
    expect(params.noGatewayAttempt).toBe(false)
  })

  it('passes the reason through UNCHANGED — no trim-to-lowercase, no rewording', async () => {
    // The handler matches with ===. Any normalisation here silently breaks the bypass, and it
    // would break it in a way that looks like the terminal's fault.
    const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
    await POST(paymentRequest(TERMINAL_CANCEL_BODY), routeParams)

    const params = (handleTerminalPaymentFailed.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >
    expect(params.cancellationReason).toBe('terminal_cancelled_by_user_pre_gateway')
  })
})

describe('PATCH /api/terminal/orders/[orderId]/status forwards it too', () => {
  it('passes noGatewayAttempt, which this route dropped while forwarding the reason', async () => {
    const { PATCH } = await import('@/app/api/terminal/orders/[orderId]/status/route')
    await PATCH(
      statusRequest({
        status: 'cancelled',
        cancellationReason: CANCEL_REASON,
        noGatewayAttempt: true,
      }),
      routeParams,
    )

    expect(handleTerminalPaymentFailed).toHaveBeenCalled()
    const params = (handleTerminalPaymentFailed.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >
    expect(params.cancellationReason).toBe(CANCEL_REASON)
    expect(params.noGatewayAttempt).toBe(true)
  })
})
