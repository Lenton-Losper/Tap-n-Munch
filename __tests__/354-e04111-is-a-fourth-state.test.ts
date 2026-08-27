/**
 * #354 — E04111 is a FOURTH payment state, and it was rendering as the most alarming one.
 *
 * THE DEFECT. `queryPaymentOrder` throws on any non-success gateway code, so an E04111 ("no record
 * of this merchant order number") fell past every branch to the route's outer catch and came back
 * as HTTP 502 `payment_provider_unreachable` — "we could not complete the check, try again
 * shortly". Wrong in both directions at once: the provider WAS reached and answered immediately,
 * and staff were told to retry a check whose answer does not change by retrying.
 *
 * It is the same conflation #153 fixed one level up (unreachable vs unconfigured), surviving in a
 * state nobody had separated out.
 *
 * WHY IT MAPS TO NOT_CONFIRMED AND NOT SOMETHING STRONGER. E04111 means "not registered at the
 * gateway YET" and is time-dependent: order #149 answered E04111 and was confirmed PAID on the
 * same reference 22 SECONDS LATER. So it must never be presented as a final "not paid" — and the
 * signed NOT_CONFIRMED copy says exactly the right thing.
 *
 * BOTH DIRECTIONS ARE ASSERTED. A suite that only pinned the new 200 would be satisfied by a route
 * that returned 200 for every gateway failure, which would tell staff a real outage was a clean
 * answer. The genuinely-unreachable case is pinned at 502 in the same file so the split cannot
 * drift — the same shape as the #153 suite next door.
 */
import { NextRequest } from 'next/server'
import { VERIFY_PAYMENT_OUTCOME_CODES } from '@/lib/payments/verify-payment-outcome'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const MERCHANT_ORDER_NO = 'FT17866007453150737'

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
  markOrderPaidConfirmed: (...a: unknown[]) => markOrderPaidConfirmed(...(a as [])),
}))

/**
 * The E04111 predicate is REAL, not stubbed true. The route must recognise the error by its
 * gateway code, and a stub returning `true` would pass against a route that treated every
 * exception as E04111 — which is the 502-for-everything defect inverted.
 */
const queryFinaticOrderPaid = jest.fn()
jest.mock('@/lib/payments/query-finatic-order-paid', () => {
  const actual = jest.requireActual('@/lib/payments/query-finatic-order-paid')
  return {
    ...actual,
    queryFinaticOrderPaid: (...a: unknown[]) => queryFinaticOrderPaid(...(a as [])),
  }
})

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: '342600160494', storeNo: '4426016800' }),
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

/** The real shape thrown by `queryPaymentOrder` for a business-phase gateway refusal. */
function e04111Error() {
  const err = new Error('PayCloud query failed: E04111 [E04111]Merchant order number is invalid')
  ;(err as unknown as { responseBody: unknown }).responseBody = {
    code: 'E04111',
    msg: 'Merchant order number is invalid',
  }
  return err
}

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
  queryFinaticOrderPaid.mockReset()
  // mockReset() strips the implementation as well as the calls, so this must be re-established or
  // the route reads `claim.claimed` off undefined and throws into the outer catch -- surfacing as
  // a 502 that looks like a route defect and is not. The positive control below caught exactly
  // that, which is what a positive control is for.
  markOrderPaidConfirmed.mockReset()
  markOrderPaidConfirmed.mockImplementation(async () => ({ claimed: true, tabId: null, reason: null }))
  orderRow = {
    id: ORDER_ID,
    restaurant_id: RESTAURANT_UUID,
    payment_status: 'pending',
    total: 55,
    paycloud_merchant_order_no: MERCHANT_ORDER_NO,
  }
})

describe('#354 E04111 is answered, not unreachable', () => {
  it('answers 200 with isE04111, NOT 502 provider_unreachable — the defect this closes', async () => {
    queryFinaticOrderPaid.mockImplementation(async () => {
      throw e04111Error()
    })

    const { status, body } = await post()

    // The whole issue in one assertion: the gateway answered, so this is not a 502.
    expect(status).toBe(200)
    expect(body.code).not.toBe(VERIFY_PAYMENT_OUTCOME_CODES.PROVIDER_UNREACHABLE)
    expect(body.isE04111).toBe(true)
    expect(body.gatewayCode).toBe('E04111')
    // `verified: true` is what separates this from the credentials branch, where the question was
    // never put at all.
    expect(body.verified).toBe(true)
    expect(body.paid).toBe(false)
    expect(body.applied).toBe(false)
  })

  it('maps to NOT_CONFIRMED, which forbids a second payment — never to a final "not paid"', () => {
    // Order #149 answered E04111 and was confirmed PAID on the same reference 22 seconds later.
    // Any state that reads as terminal invites staff to charge a card that may already be charged.
    return post().then(() => {
      queryFinaticOrderPaid.mockImplementation(async () => {
        throw e04111Error()
      })
      return post().then(({ body }) => {
        expect(body.code).toBe(VERIFY_PAYMENT_OUTCOME_CODES.NOT_CONFIRMED)
        expect(String(body.staffMessage)).toContain('do not take a second payment')
        expect(String(body.staffMessage)).toContain('can still change')
      })
    })
  })

  it('writes the audit row the 72h persistence ruling reads its observations from', async () => {
    // The ruling requires TWO E04111 observations at least 24h apart before a cancel is
    // authorised, and they are read back from exactly these rows keyed on businessOrderNo. If this
    // write stops happening, the persistence rule silently stops being satisfiable.
    queryFinaticOrderPaid.mockImplementation(async () => {
      throw e04111Error()
    })

    await post()

    const row = auditInserts.find((r) => r.action === 'payment.verification_uncertain')
    expect(row).toBeDefined()
    const meta = row!.metadata as Row
    expect(meta.isE04111).toBe(true)
    expect(meta.gatewayCode).toBe('E04111')
    expect(meta.businessOrderNo).toBe(MERCHANT_ORDER_NO)
    // Distinguishes this from the no-credentials case, which also writes verification_uncertain.
    expect(meta.credentialsMissing).toBe(false)
  })

  it('never marks the order paid on an E04111', async () => {
    queryFinaticOrderPaid.mockImplementation(async () => {
      throw e04111Error()
    })
    await post()
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
  })

  it('a genuinely unreachable gateway STILL answers 502 — the split must not drift', async () => {
    // The other direction. Without this, returning 200 for every gateway failure would pass.
    queryFinaticOrderPaid.mockImplementation(async () => {
      throw new Error('socket hang up')
    })

    const { status, body } = await post()

    expect(status).toBe(502)
    expect(body.code).toBe(VERIFY_PAYMENT_OUTCOME_CODES.PROVIDER_UNREACHABLE)
    expect(body.isE04111).toBeUndefined()
    expect(auditInserts.filter((r) => r.action === 'payment.verification_uncertain')).toHaveLength(0)
  })

  it('a PAID answer is unaffected by any of this', async () => {
    // Positive control. Every assertion above is about a refusal; without this the suite would be
    // satisfied by a route that never confirms a payment at all.
    queryFinaticOrderPaid.mockImplementation(async () => ({
      paid: true,
      statusRecognised: true,
      merchantOrderNo: MERCHANT_ORDER_NO,
      status: '2',
      transactionId: 'TXN-1',
      amount: 55,
      raw: {},
    }))

    const { status, body } = await post()

    expect(status).toBe(200)
    expect(body.paid).toBe(true)
    expect(body.isE04111).toBeUndefined()
    expect(markOrderPaidConfirmed).toHaveBeenCalled()
  })
})
