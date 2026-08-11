/**
 * The `accepting` claim has exactly one path that can strand a request row and say nothing.
 *
 * app/api/order-requests/[requestId]/accept/route.ts claims the row into the transient
 * 'accepting' status at :66 BEFORE calling createOrder(), then leaves it by one of two exits:
 *
 *   :150  finalize -> 'accepted'          (error captured, checked, logged loudly at :158-166)
 *   :138  release  -> 'waiting_review'    (error NOT captured at all)
 *
 * The release is the one that runs when things have ALREADY gone wrong, and it is the less
 * careful of the two. Its result is discarded, so if that UPDATE fails the row stays in
 * 'accepting' permanently and nothing anywhere records that it happened — no log line, and a
 * 500 body that talks only about the createOrder failure.
 *
 * That matters more than a dropped log because a row in 'accepting' is unreachable:
 *   - lib/supabase/order-requests.ts:19 lists only status = 'waiting_review', and :42-44
 *     actively evicts anything else from the live staff list, so no staff member has it on
 *     any screen.
 *   - accept:55, decline:37 and review both refuse a non-'waiting_review' row with 409.
 *   - lib/guest-orders/queries.ts:75 has no status filter, so the customer holding the order
 *     id still fetches it, and active-order-visibility.ts:55 renders 'accepting' as
 *     'waiting_review' — "Waiting for Review", indefinitely.
 *
 * Nothing sweeps it: both cron sweepers (lib/orders/auto-cancel-stale-pos-orders.ts,
 * lib/orders/expire-hosted-pending-orders.ts) operate on `orders` and never touch
 * `order_requests`.
 *
 * So: staff cannot see it, no route will act on it, nothing reaps it, and the customer is told
 * it is still being reviewed. The least this path can do is say so.
 *
 * Hermetic — supabase, auth, createOrder and the payment provider are all mocked. Nothing here
 * touches a database.
 */

type Result = { data: unknown; error: unknown }
type Call = { table: string; op: string; payload?: Record<string, unknown> }

let handler: (call: Call) => Result

/** Minimal PostgREST-shaped builder: chainable, and thenable so a bare `await` resolves it. */
function makeClient() {
  return {
    from(table: string) {
      const state: Call = { table, op: '' }
      const builder: Record<string, unknown> = {
        select() {
          if (!state.op) state.op = 'select'
          return builder
        },
        update(payload: Record<string, unknown>) {
          state.op = 'update'
          state.payload = payload
          return builder
        },
        eq() {
          return builder
        },
        maybeSingle() {
          return Promise.resolve(handler(state))
        },
        single() {
          return Promise.resolve(handler(state))
        },
        then(onFulfilled: (v: Result) => unknown, onRejected: (e: unknown) => unknown) {
          return Promise.resolve(handler(state)).then(onFulfilled, onRejected)
        },
      }
      return builder
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeClient(),
}))

jest.mock('@/lib/api/require-staff-permission', () => ({
  requireStaffPermission: async () => ({ userId: 'staff-1' }),
  isAuthError: () => false,
}))

jest.mock('@/lib/permissions', () => ({ PERMISSIONS: { ORDERS_UPDATE: 'orders.update' } }))

jest.mock('@/lib/order-routing', () => ({
  enrichOrderItemsWithRouteTo: async (_c: unknown, items: unknown) => items,
}))

// The whole point of these cases: createOrder fails, so the claim must be released.
jest.mock('@/lib/orders/create-order', () => ({
  createOrder: async () => {
    throw new Error('stock check failed')
  },
}))

jest.mock('@/payments/paycloud', () => ({
  createPaymentRequest: async () => ({}),
  paycloudWireMerchantOrderNo: () => 'wire-1',
}))
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ checkoutMerchantNo: 'm', checkoutStoreNo: 's' }),
}))

import { POST } from '@/app/api/order-requests/[requestId]/accept/route'

const REQUEST_ID = '11111111-1111-1111-1111-111111111111'

const requestRow = {
  id: REQUEST_ID,
  restaurant_id: 'rest-1',
  status: 'waiting_review',
  channel: 'table',
  items: [{ id: 'i1', quantity: 1 }],
  subtotal: 10,
  tax: 0,
  total: 10,
  table_number: 4,
  idempotency_key: null,
  tab_id: null,
  payment_channel: 'cash',
}

/**
 * Drives the route to the release path.
 * `releaseFails` decides whether the 'accepting' -> 'waiting_review' UPDATE succeeds.
 * Returns the response, the parsed body, and every write the route attempted.
 */
async function runAcceptWhereCreateOrderFails(releaseFails: boolean) {
  const writes: Array<Record<string, unknown>> = []

  handler = (call) => {
    if (call.op === 'select') return { data: requestRow, error: null }
    if (call.op === 'update') {
      writes.push(call.payload ?? {})
      if (call.payload?.status === 'accepting') {
        return { data: { ...requestRow, status: 'accepting' }, error: null }
      }
      if (call.payload?.status === 'waiting_review') {
        return releaseFails
          ? { data: null, error: { message: 'row is locked', code: '55P03' } }
          : { data: null, error: null }
      }
    }
    return { data: null, error: null }
  }

  const res = await POST(new Request('http://x', { method: 'POST' }), {
    params: Promise.resolve({ requestId: REQUEST_ID }),
  })
  return { res, body: await res.json(), writes }
}

let errorLog: jest.SpyInstance

beforeEach(() => {
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorLog.mockRestore()
})

describe('accept: releasing the accepting claim', () => {
  // CONTROL. Passes before and after the change. If this goes red the harness is wrong,
  // not the code: the ordinary failure path must keep behaving exactly as it did.
  it('releases the claim and reports only the createOrder failure when the release works', async () => {
    const { res, body, writes } = await runAcceptWhereCreateOrderFails(false)

    expect(res.status).toBe(500)
    expect(writes).toEqual([{ status: 'accepting' }, { status: 'waiting_review' }])
    expect(body.error).toBe('stock check failed')
    // Nothing was stranded, so nothing should claim it was.
    expect(String(body.error)).not.toMatch(/stuck|stranded|accepting/i)
  })

  it('logs when the release fails and the request is left stuck in accepting', async () => {
    const { writes } = await runAcceptWhereCreateOrderFails(true)

    // The release was attempted and did not take: the row is still 'accepting'.
    expect(writes).toEqual([{ status: 'accepting' }, { status: 'waiting_review' }])

    const logged = errorLog.mock.calls
      .map((args) => args.map((a: unknown) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n')
    expect(logged).toMatch(/accepting/i)
    expect(logged).toMatch(/row is locked/)
  })

  it('tells the caller the request is stuck, not just that createOrder failed', async () => {
    const { res, body } = await runAcceptWhereCreateOrderFails(true)

    expect(res.status).toBe(500)
    // The createOrder cause must survive — it is why the accept failed at all.
    expect(String(body.error)).toMatch(/stock check failed/)
    // ...but a staff member retrying will hit "Cannot accept a request with status
    // \"accepting\"" (route:55) and have no idea why. Say it here.
    expect(String(body.error)).toMatch(/accepting/i)
  })
})
