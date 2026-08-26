/**
 * #234 — staff reconcile marked orders paid with NO `paid_at`.
 *
 * `app/api/payments/reconcile/route.ts` wrote `{ status, payment_status: 'paid',
 * paycloud_transaction_id }` and never stamped `paid_at`. `orders.paid_at` is nullable with no
 * default and no trigger, so the column simply stayed NULL.
 *
 * That is not a cosmetic gap. It disabled the compensating control. The paid-but-never-issued
 * sweep in `lib/payments/reconcile-orphan-payments.ts` selects:
 *
 *     .eq('payment_status', 'paid').gte('paid_at', since)
 *
 * A NULL never satisfies `.gte(...)`, so a staff-reconciled order was PERMANENTLY invisible to the
 * one mechanism that exists to catch orders which were paid but never issued a receipt — not
 * merely late to it. The customer was charged, marked paid, and never issued a receipt, and the
 * safety net could not see them to fix it.
 *
 * WHAT THESE TESTS ASSERT, AND WHY IT IS NOT "the field is present"
 * ----------------------------------------------------------------
 * Asserting `patch.paid_at !== undefined` would pass for `paid_at: null`, which is the defect
 * itself. So every assertion below runs the written patch through `visibleToPaidNeverIssuedSweep`,
 * a local restatement of the sweep's own predicate. The test therefore fails when the ORDER STOPS
 * BEING VISIBLE TO THE SAFETY NET, which is the actual consequence #234 is about.
 *
 * The route is FIX-FORWARD only. `paid_at` records when the RECONCILIATION happened; the true
 * gateway settlement moment is not recoverable here and is deliberately not invented. The
 * `if (!data.paid_at)` guard means a re-run cannot move a date a real settlement already wrote —
 * that guard is load-bearing and has its own test below.
 *
 * Before this file, deleting the stamp from the route left the entire reconcile/payment test
 * estate green.
 */
// A module, not a global script: reconcile-gateway-amount-exact-match.test.ts covers the same
// route and declares the same fixture names at top level, so without this the two files collide
// in the global scope and tsc fails both with TS6200.
export {}

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_A = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const ORDER_B = '9d2b7e14-55a8-4c31-8f6a-0b3e7c9d1a42'
const MERCHANT_ORDER_NO = 'FT17863184148250674'

const TOTAL_A = 40.15
const TOTAL_B = 38.2
const SERVER_TOTAL = 78.35

/** `lib/payments/reconcile-orphan-payments.ts` — `options.lookbackHours ?? 48`. */
const SWEEP_LOOKBACK_HOURS = 48

/** A settlement date a REAL payment path already wrote. The re-run must not move it. */
const PRE_EXISTING_PAID_AT = '2026-07-04T09:15:00.000Z'

type Row = Record<string, unknown>

/**
 * The sweep's own filter, restated: `.eq('payment_status','paid').gte('paid_at', since)`.
 *
 * PostgREST's `.gte()` is a SQL comparison, and any comparison against NULL yields NULL, which
 * is not TRUE — the row is excluded. Hence the `typeof !== 'string'` arm: an absent or null stamp
 * is invisible, not "old". ISO-8601 UTC strings are fixed-width and Z-suffixed, so lexicographic
 * comparison matches chronological order exactly.
 */
function visibleToPaidNeverIssuedSweep(patch: Row, sinceISO: string): boolean {
  if (String(patch.payment_status) !== 'paid') return false
  const stamp = patch.paid_at
  if (typeof stamp !== 'string' || stamp === '') return false
  return stamp >= sinceISO
}

const sweepSince = () =>
  new Date(Date.now() - SWEEP_LOOKBACK_HOURS * 60 * 60 * 1000).toISOString()

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

let orderRows: Row[]
/** Every `orders` UPDATE the route issued, in order, paired with the id it targeted. */
const mockUpdates: { orderId: string | null; patch: Row }[] = []

/** Table-aware PostgREST stand-in. Records which order each patch was aimed at. */
function makeSupabase() {
  return {
    from: (table: string) => {
      const state = {
        table,
        op: 'select',
        patch: null as Row | null,
        eqId: null as string | null,
      }
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        update: (patch: Row) => {
          state.op = 'update'
          state.patch = patch
          return b
        },
        insert: async () => ({ data: null, error: null }),
        eq: (col: string, val: unknown) => {
          if (col === 'id') state.eqId = String(val)
          return b
        },
        in: () => b,
        is: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (state.table === 'orders' && state.op === 'update') {
            mockUpdates.push({ orderId: state.eqId, patch: state.patch as Row })
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

jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (r: unknown) => r instanceof Response,
  requireCallerRestaurantPermission: async () => ({
    userId: 'staff-1',
    restaurantId: RESTAURANT_UUID,
    supabase: mockSupabaseSingleton(),
  }),
}))

let supabaseSingleton: ReturnType<typeof makeSupabase> | null = null
function mockSupabaseSingleton() {
  if (!supabaseSingleton) supabaseSingleton = makeSupabase()
  return supabaseSingleton
}

// ---------------------------------------------------------------- fixtures

function orderRow(id: string, total: number, overrides: Row = {}): Row {
  return {
    id,
    restaurant_id: RESTAURANT_UUID,
    status: 'pending',
    total,
    payment_status: 'pending',
    paid_at: null,
    paycloud_merchant_order_no: MERCHANT_ORDER_NO,
    ...overrides,
  }
}

beforeEach(() => {
  queryPaymentOrder.mockClear()
  mockUpdates.length = 0
  supabaseSingleton = null
  orderRows = [orderRow(ORDER_A, TOTAL_A), orderRow(ORDER_B, TOTAL_B)]
})

/** Finatic reports paid (trans_status 2) for `amount`. */
function finaticPaidAt(amount: number) {
  queryPaymentOrder.mockResolvedValueOnce({
    rawResponse: { data: JSON.stringify({ trans_status: 2, amount }), psn: 'TXN-1' },
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

const patchFor = (orderId: string) =>
  mockUpdates.find((u) => u.orderId === orderId)?.patch as Row

// ----------------------------------------------------------------

describe('#234 — staff reconcile must stamp paid_at, or the safety net cannot see the order', () => {
  it('stamps paid_at on every order it marks paid', async () => {
    finaticPaidAt(SERVER_TOTAL)
    const before = new Date().toISOString()
    const { res, body } = await call()
    const after = new Date().toISOString()

    expect({ status: res.status, paid: body.paid }).toEqual({ status: 200, paid: true })
    expect(mockUpdates).toHaveLength(2)

    for (const orderId of [ORDER_A, ORDER_B]) {
      const patch = patchFor(orderId)
      expect(patch.payment_status).toBe('paid')
      // A real instant, taken during this request — not null, not undefined, not a sentinel.
      expect(typeof patch.paid_at).toBe('string')
      expect(String(patch.paid_at) >= before && String(patch.paid_at) <= after).toBe(true)
      expect(Number.isNaN(Date.parse(String(patch.paid_at)))).toBe(false)
    }
  })

  it('leaves the order VISIBLE to the paid-but-never-issued sweep', async () => {
    // The consequence, not the field. Before #234's fix this was false for every reconciled
    // order, forever — a NULL paid_at can never satisfy `.gte('paid_at', since)`.
    finaticPaidAt(SERVER_TOTAL)
    await call()

    const since = sweepSince()
    for (const orderId of [ORDER_A, ORDER_B]) {
      expect(visibleToPaidNeverIssuedSweep(patchFor(orderId), since)).toBe(true)
    }
  })

  it('CONTROL: the pre-#234 patch shape is invisible to that same sweep predicate', async () => {
    // Guards the test above from becoming decoration. If `visibleToPaidNeverIssuedSweep` ever
    // starts returning true for everything, this fails and says so.
    const since = sweepSince()
    const preFixShape: Row = {
      status: 'accepted',
      payment_status: 'paid',
      paycloud_transaction_id: 'TXN-1',
    }
    expect(visibleToPaidNeverIssuedSweep(preFixShape, since)).toBe(false)
    expect(visibleToPaidNeverIssuedSweep({ ...preFixShape, paid_at: null }, since)).toBe(false)
    // And a stamp older than the window is excluded for a DIFFERENT reason — being out of
    // lookback is not the same failure as being invisible, and the predicate must tell them apart.
    expect(
      visibleToPaidNeverIssuedSweep({ ...preFixShape, paid_at: PRE_EXISTING_PAID_AT }, since),
    ).toBe(false)
  })

  it('does not move a paid_at that a real settlement already wrote', async () => {
    // A mixed batch: ORDER_A was genuinely settled earlier and carries the gateway's own date;
    // ORDER_B is still pending, so the batch does not short-circuit and A is re-patched. The
    // route's `if (!data.paid_at)` guard must leave A's date alone — stamping now() over it would
    // replace a true settlement moment with a reconciliation moment, losing the real one.
    orderRows = [
      orderRow(ORDER_A, TOTAL_A, {
        status: 'completed',
        payment_status: 'paid',
        paid_at: PRE_EXISTING_PAID_AT,
      }),
      orderRow(ORDER_B, TOTAL_B),
    ]
    finaticPaidAt(SERVER_TOTAL)
    const { res } = await call()

    expect(res.status).toBe(200)
    expect(mockUpdates).toHaveLength(2)

    // A: marked paid again, but its original settlement date is untouched.
    const a = patchFor(ORDER_A)
    expect(a.payment_status).toBe('paid')
    expect(a.paid_at).toBeUndefined()

    // B: newly reconciled, so it gets today's reconciliation stamp and becomes sweep-visible.
    const b = patchFor(ORDER_B)
    expect(typeof b.paid_at).toBe('string')
    expect(visibleToPaidNeverIssuedSweep(b, sweepSince())).toBe(true)
  })

  it('writes no paid_at at all when the gateway amount does not verify', async () => {
    // The stamp must ride WITH the paid decision, never ahead of it: a refused reconcile must
    // leave the order untouched, so nothing is stamped paid on an unverified amount.
    finaticPaidAt(SERVER_TOTAL + 0.01)
    const { res } = await call()

    expect(res.status).toBe(409)
    expect(mockUpdates).toHaveLength(0)
  })
})
