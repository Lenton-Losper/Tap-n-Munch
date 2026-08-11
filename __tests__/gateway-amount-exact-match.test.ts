/**
 * #190 — the gateway's echoed amount is held to EXACT agreement, and an absent amount is
 * treated as unverified. The client legs keep the one-cent tolerance #180 gave them.
 *
 * THE SPLIT THIS FILE EXISTS TO PIN. After #180 every amount comparison shared one tolerance.
 * That conflated two different questions:
 *
 *   CLIENT leg   — a terminal-submitted figure validated against the server's total. The device
 *                  and the server can legitimately land a cent apart, and the card is already
 *                  charged by the time the check runs. One cent is tolerated.
 *                    payment/route.ts:79     settle/route.ts:224
 *
 *   GATEWAY leg  — Finatic echoing back OUR OWN figure. push-to-terminal sends
 *                  Number(order.total) as order_amount and this compares against
 *                  Number(order.total). Nothing in that round trip can produce a legitimate
 *                  cent, so any daylight means the reference correlated to a DIFFERENT SALE.
 *                  Exact match, zero cents.
 *                    verify-payment/route.ts:117   handle-terminal-payment-failed.ts:190
 *
 * Both halves are asserted here on purpose. A test file holding only the gateway half would be
 * satisfied by tightening every site to zero, which would reintroduce #180 on the client legs;
 * one holding only the client half would be satisfied by reverting #190 entirely. Neither
 * change can pass this file.
 *
 * ABSENT AMOUNT (#190 part 2). `result.amount != null && !amountsMatch(...)` applied the
 * payment with no amount check of any kind when the field was absent, and the record could not
 * afterwards distinguish "checked and agreed" from "never checked". Both gateway legs now
 * refuse. This REVERSES the decision previously documented at
 * handle-terminal-payment-failed.ts:187-188 and asserted by
 * __tests__/terminal-payment-failed-amount-guard.test.ts — see the note there.
 *
 * The fixtures are 78.35/78.36: an exact one-cent pair that the pre-#180 float comparison
 * refused (78.36 - 78.35 === 0.010000000000005116). A pair like 34.99/35.00 would pass against
 * a broken comparison and prove nothing.
 */
import { NextRequest } from 'next/server'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const TAB_ID = '7c2f9a51-3f0e-4a6d-9a3e-1f5c2b8d4e77'
const MERCHANT_ORDER_NO = 'FT17863184148250674'

const SERVER_TOTAL = 78.35
const ONE_CENT_OVER = 78.36

type Row = Record<string, unknown>

let orderRow: Row
let tabRow: Row
let tabOrders: Row[]
const mockAudits: Row[] = []

// ---------------------------------------------------------------- module mocks

jest.mock('@/payments/paycloud', () => ({
  queryPaymentOrder: jest.fn(async () => {
    throw new Error('queryPaymentOrder must not be reached in this suite')
  }),
}))

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
  amount: SERVER_TOTAL as number | null,
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
 * Table-aware PostgREST stand-in, same shape as
 * __tests__/terminal-payment-cent-tolerance-routes.test.ts, extended to CAPTURE audit_logs
 * inserts — #190 turns "was this refusal recorded" into an assertion, so the audit write can
 * no longer be swallowed by the mock.
 */
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const state = { table, op: 'select', filters: [] as string[] }
      const b: Record<string, unknown> = {}
      const resolveList = () => {
        if (state.table === 'orders' && state.op === 'update') {
          return { data: tabOrders.map((o) => ({ id: o.id })), error: null }
        }
        if (state.table === 'orders' && state.filters.includes('in:id')) {
          return { data: tabOrders, error: null }
        }
        return { data: [], error: null }
      }
      Object.assign(b, {
        select: () => b,
        update: () => {
          state.op = 'update'
          return b
        },
        insert: async (row: Row) => {
          if (state.table === 'audit_logs') mockAudits.push(row)
          return { data: null, error: null }
        },
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
  mockAudits.length = 0

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
    { id: ORDER_ID, total: SERVER_TOTAL, payment_status: 'pending', terminal_pushed_at: null },
  ]
})

function jsonRequest(url: string, body: unknown, method = 'POST') {
  return new NextRequest(url, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(body),
  })
}

const uncertainAudits = () =>
  mockAudits.filter((a) => a.action === 'payment.verification_uncertain')

// ================================================================ GATEWAY LEG 1
// app/api/terminal/orders/[orderId]/verify-payment/route.ts:117

describe('verify-payment — the gateway leg is EXACT', () => {
  const call = async (finaticAmount: number | null) => {
    queryFinaticOrderPaid.mockResolvedValueOnce({
      paid: true,
      merchantOrderNo: MERCHANT_ORDER_NO,
      status: 'paid',
      transactionId: 'TXN-1',
      amount: finaticAmount,
      raw: {},
    })
    const { POST } = await import(
      '@/app/api/terminal/orders/[orderId]/verify-payment/route'
    )
    const res = await POST(
      jsonRequest('https://staging.test/api/terminal/orders/x/verify-payment', {}),
      { params: Promise.resolve({ orderId: ORDER_ID }) },
    )
    return { res, body: await res.json() }
  }

  it('applies the correction when the gateway echoes the total exactly', async () => {
    const { body } = await call(SERVER_TOTAL)

    expect({ paid: body.paid, applied: body.applied }).toEqual({ paid: true, applied: true })
    expect(markOrderPaidConfirmed).toHaveBeenCalledTimes(1)
    expect(uncertainAudits()).toHaveLength(0)
  })

  it('REFUSES a one-cent gateway difference', async () => {
    // The boundary. One cent was accepted here before #190; the gateway cannot legitimately
    // produce one, so a cent of daylight means a different sale.
    const { body } = await call(ONE_CENT_OVER)

    expect(body.applied).toBe(false)
    expect(body.outcome).toBe('left_pending_finatic_uncertain')
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
  })

  it('leaves a findable audit row carrying BOTH figures on a mismatch', async () => {
    // Q3: a console.error in a Worker is not a record, and the E04111 resolution procedure
    // keys off this audit action. Every refusal below is a charged customer whose order is
    // still unpaid, so the row is the only way staff find them.
    await call(ONE_CENT_OVER)

    const audit = uncertainAudits()[0]
    expect(audit).toBeDefined()
    expect(audit.entity_id).toBe(ORDER_ID)
    const metadata = audit.metadata as Row
    expect({
      finaticAmount: metadata.finaticAmount,
      expectedAmount: metadata.expectedAmount,
      outcome: metadata.outcome,
    }).toEqual({
      finaticAmount: ONE_CENT_OVER,
      expectedAmount: SERVER_TOTAL,
      outcome: 'left_pending_finatic_uncertain',
    })
  })

  it('treats an ABSENT gateway amount as unverified and does not apply', async () => {
    const { body } = await call(null)

    expect(body.applied).toBe(false)
    expect(body.outcome).toBe('left_pending_finatic_uncertain')
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
  })

  it('records the absent amount as null in the audit row, not as agreement', async () => {
    await call(null)

    const metadata = uncertainAudits()[0]?.metadata as Row
    expect({ finaticAmount: metadata.finaticAmount, expectedAmount: metadata.expectedAmount })
      .toEqual({ finaticAmount: null, expectedAmount: SERVER_TOTAL })
  })
})

// ================================================================ GATEWAY LEG 2
// lib/payments/handle-terminal-payment-failed.ts:190

/** Local stub — this handler takes its supabase client as an argument. */
function makeSupabase() {
  const audits: Row[] = []
  const updates: Row[] = []
  const client = {
    from(table: string) {
      if (table === 'audit_logs') {
        return {
          insert: (row: Row) => {
            audits.push(row)
            return Promise.resolve({ error: null })
          },
        }
      }
      const builder: Record<string, unknown> = {
        update(patch: Row) {
          updates.push(patch)
          return builder
        },
        eq: () => builder,
        in: () => builder,
        select: () => builder,
        maybeSingle: () =>
          Promise.resolve({
            data: { id: 'order-1', status: 'cancelled', payment_status: 'cancelled' },
            error: null,
          }),
        single: () => Promise.resolve({ data: { id: 'order-1' }, error: null }),
        then: (resolve: (r: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: [{ id: 'order-1' }], error: null })),
      }
      return builder
    },
  }
  return { client: client as never, audits, updates }
}

describe('handleTerminalPaymentFailed — the gateway leg is EXACT', () => {
  const run = async (amount: number | null) => {
    const { handleTerminalPaymentFailed } = await import(
      '@/lib/payments/handle-terminal-payment-failed'
    )
    const supabase = makeSupabase()
    const result = await handleTerminalPaymentFailed(
      supabase.client,
      {
        orderId: 'order-1',
        restaurantId: 'rest-1',
        paycloudMerchantOrderNo: MERCHANT_ORDER_NO,
        orderTotal: SERVER_TOTAL,
        amount: SERVER_TOTAL,
        reference: 'UNCONFIRMED-x',
      },
      {
        queryFinaticOrderPaidFn: (async () => ({
          paid: true,
          merchantOrderNo: MERCHANT_ORDER_NO,
          status: 'paid',
          transactionId: 'TXN-1',
          amount,
          raw: {},
        })) as never,
      },
    )
    return { result, supabase }
  }

  it('corrects to paid when the gateway echoes the total exactly', async () => {
    const { result } = await run(SERVER_TOTAL)

    expect(result.outcome).toBe('corrected_to_paid')
    expect(markOrderPaidConfirmed).toHaveBeenCalledTimes(1)
  })

  it('REFUSES a one-cent gateway difference', async () => {
    const { result, supabase } = await run(ONE_CENT_OVER)

    expect(result.outcome).toBe('left_pending_finatic_uncertain')
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    // Not cancelled either: the gateway has just said the customer WAS charged.
    expect(supabase.updates).toHaveLength(0)
  })

  it('treats an ABSENT gateway amount as unverified and does not correct to paid', async () => {
    // REVERSES the prior decision at handle-terminal-payment-failed.ts:187-188 ("a missing
    // amount is not a disagreeing amount"), which fell through to the order total. If the
    // gateway did not give us an amount, we did not verify the amount.
    const { result, supabase } = await run(null)

    expect(result.outcome).toBe('left_pending_finatic_uncertain')
    expect(markOrderPaidConfirmed).not.toHaveBeenCalled()
    expect(supabase.updates).toHaveLength(0)
  })

  it('records an absent amount as null in the audit row', async () => {
    const { supabase } = await run(null)

    const audit = supabase.audits.find((a) => a.action === 'payment.verification_uncertain')
    expect(audit).toBeDefined()
    const metadata = audit?.metadata as Row
    expect({
      finaticAmount: metadata.finaticAmount,
      expectedAmount: metadata.expectedAmount,
      outcome: metadata.outcome,
    }).toEqual({
      finaticAmount: null,
      expectedAmount: SERVER_TOTAL,
      outcome: 'left_pending_finatic_uncertain',
    })
  })
})

// ================================================================ CLIENT LEG 1
// app/api/terminal/orders/[orderId]/payment/route.ts:79

describe('payment route — the client leg KEEPS the one-cent tolerance', () => {
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

  it('still ACCEPTS a one-cent client difference', async () => {
    // The other half of the split. If #190 leaked onto this site the card would already be
    // charged and the order would be left unpaid — #180 exactly.
    const { res, body } = await call(ONE_CENT_OVER)

    expect({ status: res.status, code: body.code }).toEqual({ status: 200, code: undefined })
    expect(markOrderPaidConfirmed).toHaveBeenCalledTimes(1)
  })
})

// ================================================================ CLIENT LEG 2
// app/api/terminal/tabs/[tabId]/settle/route.ts:224

describe('settle route — the client leg KEEPS the one-cent tolerance', () => {
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

  it('still ACCEPTS a one-cent client difference', async () => {
    const { res, body } = await call(ONE_CENT_OVER)

    expect({ status: res.status, code: body.code }).toEqual({ status: 200, code: undefined })
    expect(body.success).toBe(true)
  })
})
