/**
 * #160 — prepare-payment must not mint an identifier it cannot honour.
 *
 * THE DEFECT. The route gated on terminal auth and `orders:update`, then called
 * `ensureTerminalMerchantOrderNo`, which never reads Finatic credentials. At a venue with no
 * merchant/store pair that persisted `orders.paycloud_merchant_order_no` — a reference that looks
 * gateway-issued, is not, and can never be queried by anything afterwards. Four exist on
 * production (2026-08-27, all Digi Cofee: #18, #19, #28, #29); #28 and #29 were minted on the
 * evening of 2026-08-26 and #28's trail carries five `payment.verification_uncertain` rows in six
 * minutes, each one reading `No Finatic credentials configured for restaurant`.
 *
 * WHAT IS PINNED HERE IS THE ORDER OF TWO STEPS. Every refusal case asserts that the allocator was
 * NEVER CALLED and that no UPDATE reached `orders`. A test that only checked the status code would
 * be satisfied by allocating first and returning 400 afterwards, which leaves the burned number
 * behind and fixes nothing — that is precisely the shape of the bug.
 *
 * ALL THREE STATES ARE ASSERTED, SIDE BY SIDE AND AGAINST EACH OTHER. A file pinning only the
 * permanent refusal would be satisfied by refusing everything with one code, which would tell a
 * venue that takes cards every day that it has never been configured. A file pinning only the
 * happy path would be satisfied by reverting the fix.
 *
 * WORDING IS NOT ASSERTED. The staff-facing strings are placeholders pending owner-signed copy
 * (lib/payments/prepare-payment-outcome.ts). What is asserted is the `outcome`, which is the
 * contract a terminal build branches on, and that a message is present at all.
 *
 * THE CREDENTIALS MOCK BELOW IS ITSELF PART OF THE TEST. It is a factory returning ONLY
 * `getRestaurantFinaticCredentials`, exactly like the eighteen suites described in
 * lib/payments/finatic-credentials-error.ts's header. If the route ever imports
 * `isMissingFinaticCredentialsError` from `finatic-restaurant-credentials` instead of from
 * `finatic-credentials-error`, the predicate reads as `undefined` here and every case below fails
 * with a TypeError rather than classifying.
 */
import { NextRequest } from 'next/server'
import { PREPARE_PAYMENT_OUTCOME_CODES } from '@/lib/payments/prepare-payment-outcome'
import { MissingFinaticCredentialsError } from '@/lib/payments/finatic-credentials-error'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const MERCHANT_ORDER_NO = 'FT17863184148250674'

type Row = Record<string, unknown>

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_UUID,
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))

const getCredentials = jest.fn()
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: (...args: unknown[]) => getCredentials(...(args as [])),
}))

const ensureTerminalMerchantOrderNo = jest.fn()
jest.mock('@/lib/payments/terminal-merchant-order', () => ({
  ensureTerminalMerchantOrderNo: (...args: unknown[]) =>
    ensureTerminalMerchantOrderNo(...(args as [])),
}))

/** Every write the route issues, so "nothing was minted" can be asserted rather than assumed. */
const auditInserts: Row[] = []
const orderUpdates: Row[] = []
/** Forces the throwing shape a misconfigured or unreachable client has. */
let mockAuditInsertThrows = false

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: () => b,
        is: () => b,
        update: (patch: Row) => {
          if (table === 'orders') orderUpdates.push(patch)
          return b
        },
        insert: async (row: Row) => {
          if (table === 'audit_logs') {
            if (mockAuditInsertThrows) throw new Error('audit_logs unreachable')
            auditInserts.push(row)
          }
          return { error: null }
        },
        maybeSingle: async () => ({ data: null, error: null }),
        then: (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r),
      })
      return b
    },
  }),
}))

const post = async (orderId: string = ORDER_ID) => {
  const { POST } = await import('@/app/api/terminal/orders/[orderId]/prepare-payment/route')
  const req = new NextRequest(
    `http://localhost/api/terminal/orders/${orderId}/prepare-payment`,
    { method: 'POST' },
  )
  const res = await POST(req, { params: Promise.resolve({ orderId }) })
  return { status: res.status, body: (await res.json()) as Row }
}

beforeEach(() => {
  auditInserts.length = 0
  orderUpdates.length = 0
  mockAuditInsertThrows = false
  getCredentials.mockReset()
  ensureTerminalMerchantOrderNo.mockReset()
  ensureTerminalMerchantOrderNo.mockImplementation(async () => ({
    merchantOrderNo: MERCHANT_ORDER_NO,
    created: true,
  }))
})

describe('#160 — a venue with no Finatic credentials', () => {
  it('refuses BEFORE allocating: no merchant order number is minted at all', async () => {
    getCredentials.mockImplementation(async () => {
      throw new MissingFinaticCredentialsError(RESTAURANT_UUID)
    })

    const { status, body } = await post()

    // THE ASSERTION THAT IS THE FIX. Allocating and then returning 400 would satisfy every other
    // line in this test and would still burn a reference.
    expect(ensureTerminalMerchantOrderNo).not.toHaveBeenCalled()
    expect(orderUpdates).toHaveLength(0)

    expect(status).toBe(400)
    expect(body.outcome).toBe(PREPARE_PAYMENT_OUTCOME_CODES.CARD_NOT_AVAILABLE_HERE)
    expect(body.merchantOrderNo).toBeNull()
    expect(body.allocated).toBe(false)
    expect(String(body.staffMessage ?? '')).not.toBe('')
  })

  it('leaves a server-side record of the refusal, not only a Worker log line', async () => {
    getCredentials.mockImplementation(async () => {
      throw new MissingFinaticCredentialsError(RESTAURANT_UUID)
    })

    await post()

    // Rule 21: a console.error in a Worker is not an instrument. The refusal is the only
    // server-side evidence that a venue is being asked for a card it cannot take.
    expect(auditInserts).toHaveLength(1)
    expect(auditInserts[0].action).toBe('payment.prepare_refused_no_credentials')
    expect(auditInserts[0].entity_id).toBe(ORDER_ID)
    expect(auditInserts[0].restaurant_id).toBe(RESTAURANT_UUID)
  })

  it('still refuses when the audit write fails — the record must not gate the refusal', async () => {
    getCredentials.mockImplementation(async () => {
      throw new MissingFinaticCredentialsError(RESTAURANT_UUID)
    })
    mockAuditInsertThrows = true
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { status, body } = await post()

      // The refusal has already been DECIDED by the time the record is attempted. A failed write
      // must not turn a correct refusal into a 500, and must certainly not fall through to
      // allocating — which is what would happen if the insert were not caught.
      expect(status).toBe(400)
      expect(body.outcome).toBe(PREPARE_PAYMENT_OUTCOME_CODES.CARD_NOT_AVAILABLE_HERE)
      expect(ensureTerminalMerchantOrderNo).not.toHaveBeenCalled()
      expect(auditInserts).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('#160 — the credential read itself fails', () => {
  it('is a THIRD state: it refuses too, but must not claim the venue is unconfigured', async () => {
    getCredentials.mockImplementation(async () => {
      throw new Error('fetch failed: ETIMEDOUT')
    })

    const { status, body } = await post()

    expect(ensureTerminalMerchantOrderNo).not.toHaveBeenCalled()
    expect(orderUpdates).toHaveLength(0)

    expect(status).toBe(502)
    expect(body.outcome).toBe(PREPARE_PAYMENT_OUTCOME_CODES.READINESS_UNKNOWN)
    // The split is the point. Answering an absent answer with "card payment is not set up here"
    // tells a venue that takes cards every day that it has never been configured.
    expect(body.outcome).not.toBe(PREPARE_PAYMENT_OUTCOME_CODES.CARD_NOT_AVAILABLE_HERE)
    expect(String(body.staffMessage ?? '')).not.toBe('')
    // A read that failed is not evidence about the venue, so it is not recorded as such.
    expect(auditInserts).toHaveLength(0)
  })
})

describe('#160 — a venue that CAN take a card', () => {
  it('allocates exactly as before, and says so', async () => {
    getCredentials.mockImplementation(async () => ({
      merchantNo: '342600131153',
      storeNo: '4426015803',
      terminalSn: null,
      checkoutMerchantNo: '',
      checkoutStoreNo: '',
    }))

    const { status, body } = await post()

    expect(getCredentials).toHaveBeenCalledWith(RESTAURANT_UUID)
    expect(ensureTerminalMerchantOrderNo).toHaveBeenCalledTimes(1)
    expect(status).toBe(200)
    expect(body.merchantOrderNo).toBe(MERCHANT_ORDER_NO)
    expect(body.created).toBe(true)
    expect(body.outcome).toBeNull()
  })

  it('and an order that cannot take a fresh card is the PREPARE_FAILED state, not either other one',
    async () => {
      getCredentials.mockImplementation(async () => ({
        merchantNo: '342600131153',
        storeNo: '4426015803',
        terminalSn: null,
        checkoutMerchantNo: '',
        checkoutStoreNo: '',
      }))
      ensureTerminalMerchantOrderNo.mockImplementation(async () => {
        const e = new Error('Order is already paid') as Error & { status: number; code: string }
        e.status = 400
        e.code = 'ALREADY_PAID'
        throw e
      })

      const { status, body } = await post()

      expect(status).toBe(400)
      expect(body.outcome).toBe(PREPARE_PAYMENT_OUTCOME_CODES.PREPARE_FAILED)
      // `code` is untouched: push-to-terminal, payments/receipt, terminal payment and terminal
      // tabs settle all speak this string and a fielded build reads it.
      expect(body.code).toBe('ALREADY_PAID')
      expect(body.outcome).not.toBe(PREPARE_PAYMENT_OUTCOME_CODES.CARD_NOT_AVAILABLE_HERE)
      expect(body.outcome).not.toBe(PREPARE_PAYMENT_OUTCOME_CODES.READINESS_UNKNOWN)
    })
})
