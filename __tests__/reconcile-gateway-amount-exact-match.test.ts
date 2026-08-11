/**
 * #197, riding inside #190 — the FIFTH gateway gate.
 *
 * app/api/payments/reconcile/route.ts:156 never called amountsMatch at all:
 *
 *     if (paidAmount !== null && Math.abs(paidAmount - expectedAmount) > 0.02)
 *
 * A raw float comparison at TWO cents. #180 swept the amountsMatch call sites, so this one was
 * invisible to it — which is why it survived. It carries both defects at once: the float
 * artefact #180 fixed, and #190's null hole (`paidAmount !== null` short-circuits and the
 * orders are marked paid with no amount check of any kind).
 *
 * This route is not the terminal's. It is staff-triggered behind PERMISSIONS.PAYMENTS_PROCESS,
 * it marks orders paid directly with an UPDATE, and it can carry a BATCH of orders whose totals
 * are summed into one expected figure. Nothing covered it before this file.
 *
 * It is a GATEWAY leg — the amount comes from Finatic's order.query response, not from a
 * client — so it takes the exact-match tolerance and the unverified-null rule, same as
 * verify-payment and handle-terminal-payment-failed.
 */
const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_A = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const ORDER_B = '9d2b7e14-55a8-4c31-8f6a-0b3e7c9d1a42'
const MERCHANT_ORDER_NO = 'FT17863184148250674'

/** Two orders summing to an exact one-cent pair against the fixtures below. */
const TOTAL_A = 40.15
const TOTAL_B = 38.2
const SERVER_TOTAL = 78.35
const ONE_CENT_OVER = 78.36

type Row = Record<string, unknown>

let orderRows: Row[]
const mockAudits: Row[] = []
const mockUpdates: Row[] = []

// ---------------------------------------------------------------- module mocks

const queryPaymentOrder = jest.fn(async (..._args: unknown[]) => ({
  rawResponse: {} as Record<string, unknown>,
}))
jest.mock('@/payments/paycloud', () => ({
  queryPaymentOrder: (...args: unknown[]) => queryPaymentOrder(...args),
}))

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({
    merchantNo: 'M1',
    storeNo: 'S1',
    terminalSn: 'SN1',
  }),
}))

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async () => RESTAURANT_UUID,
}))

/** Table-aware PostgREST stand-in capturing audit inserts and order updates. */
function makeSupabase() {
  return {
    from: (table: string) => {
      const state = { table, op: 'select', patch: null as Row | null }
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        update: (patch: Row) => {
          state.op = 'update'
          state.patch = patch
          return b
        },
        insert: async (row: Row) => {
          if (state.table === 'audit_logs') mockAudits.push(row)
          return { data: null, error: null }
        },
        eq: () => b,
        in: () => b,
        is: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (state.table === 'orders' && state.op === 'update') {
            mockUpdates.push(state.patch as Row)
            return resolve({ data: null, error: null })
          }
          if (state.table === 'orders') return resolve({ data: orderRows, error: null })
          return resolve({ data: [], error: null })
        },
      })
      return b
    },
  }
}

// NextResponse extends the Response global, so the structural check is equivalent to the real
// `r instanceof NextResponse` without pulling an import into the mock factory.
jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (r: unknown) => r instanceof Response,
  requireCallerRestaurantPermission: async () => ({
    userId: 'staff-1',
    restaurantId: RESTAURANT_UUID,
    // Same client instance the route will read AND write through.
    supabase: mockSupabaseSingleton(),
  }),
}))

let supabaseSingleton: ReturnType<typeof makeSupabase> | null = null
function mockSupabaseSingleton() {
  if (!supabaseSingleton) supabaseSingleton = makeSupabase()
  return supabaseSingleton
}

// ---------------------------------------------------------------- fixtures

beforeEach(() => {
  queryPaymentOrder.mockClear()
  mockAudits.length = 0
  mockUpdates.length = 0
  supabaseSingleton = null

  orderRows = [
    {
      id: ORDER_A,
      restaurant_id: RESTAURANT_UUID,
      status: 'pending',
      total: TOTAL_A,
      payment_status: 'pending',
      paycloud_merchant_order_no: MERCHANT_ORDER_NO,
    },
    {
      id: ORDER_B,
      restaurant_id: RESTAURANT_UUID,
      status: 'pending',
      total: TOTAL_B,
      payment_status: 'pending',
      paycloud_merchant_order_no: MERCHANT_ORDER_NO,
    },
  ]
})

/** Finatic says paid (trans_status 2), for `amount`. Omit the key entirely for absent. */
function finaticPaidAt(amount: number | null) {
  const data: Record<string, unknown> = { trans_status: 2 }
  if (amount !== null) data.amount = amount
  queryPaymentOrder.mockResolvedValueOnce({
    rawResponse: { data: JSON.stringify(data), psn: 'TXN-1' },
  })
}

async function call() {
  const { POST } = await import('@/app/api/payments/reconcile/route')
  const res = await POST(
    new Request('https://staging.test/api/payments/reconcile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({ restaurantId: RESTAURANT_UUID, orderIds: [ORDER_A, ORDER_B] }),
    }),
  )
  return { res, body: await res.json() }
}

const uncertainAudits = () =>
  mockAudits.filter((a) => a.action === 'payment.verification_uncertain')

// ----------------------------------------------------------------

describe('POST /api/payments/reconcile — the gateway leg is EXACT', () => {
  it('marks the batch paid when the gateway echoes the summed total exactly', async () => {
    finaticPaidAt(SERVER_TOTAL)
    const { res, body } = await call()

    expect({ status: res.status, paid: body.paid }).toEqual({ status: 200, paid: true })
    expect(mockUpdates).toHaveLength(2)
    expect(mockUpdates.every((p) => p.payment_status === 'paid')).toBe(true)
  })

  it('REFUSES a one-cent gateway difference', async () => {
    // Accepted before #197: |78.36 - 78.35| = 0.010000000000005116, under the 0.02 float gate.
    finaticPaidAt(ONE_CENT_OVER)
    const { res, body } = await call()

    expect({ status: res.status, paid: body.paid }).toEqual({ status: 409, paid: false })
    expect(mockUpdates).toHaveLength(0)
  })

  it('treats an ABSENT gateway amount as unverified and does not mark anything paid', async () => {
    // `paidAmount !== null &&` short-circuited here too, so a response with no amount field
    // marked the whole batch paid with no check of any kind.
    finaticPaidAt(null)
    const { res, body } = await call()

    expect({ status: res.status, paid: body.paid }).toEqual({ status: 409, paid: false })
    expect(mockUpdates).toHaveLength(0)
  })

  it('leaves one findable audit row PER ORDER on a refusal, carrying both figures', async () => {
    // A staff member sees the 409; nobody else does. These orders are charged and unpaid, and
    // the resolution procedure finds them by entity_id on this action.
    finaticPaidAt(ONE_CENT_OVER)
    await call()

    const audits = uncertainAudits()
    expect(audits.map((a) => a.entity_id).sort()).toEqual([ORDER_A, ORDER_B].sort())
    const metadata = audits[0].metadata as Row
    expect({
      finaticAmount: metadata.finaticAmount,
      expectedAmount: metadata.expectedAmount,
    }).toEqual({ finaticAmount: ONE_CENT_OVER, expectedAmount: SERVER_TOTAL })
  })

  it('records an absent amount as null rather than as agreement', async () => {
    finaticPaidAt(null)
    await call()

    const metadata = uncertainAudits()[0]?.metadata as Row
    expect({ finaticAmount: metadata.finaticAmount, expectedAmount: metadata.expectedAmount })
      .toEqual({ finaticAmount: null, expectedAmount: SERVER_TOTAL })
  })
})
