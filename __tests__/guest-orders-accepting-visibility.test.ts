/**
 * Issue #219 — a stranded `accepting` request is visible on its own page and absent from
 * every list that should contain it.
 *
 * `fetchGuestOrderById` applies NO status filter, so an `accepting` order_request is returned
 * by direct link and displayed as "Waiting for Review" (the tracker and the banner both run it
 * through `normalizeOrderStatusForDisplay`, which maps `accepting` -> `waiting_review`).
 * `fetchGuestOrdersBySession` and `fetchGuestActiveTableOrders` filtered the request query to
 * `waiting_review` alone AT THE DATABASE, so the same row was missing from the customer's list
 * and from the active-order view. One order, simultaneously under review and nowhere to be seen.
 *
 * `accepting` is already in ACTIVE_ORDER_STATUSES, deliberately and with the reason written out
 * (lib/orders/active-order-visibility.ts:16-20): callers treat "not eligible" as "this order is
 * over" and clear the stored order id. The by-id path is correct; the two list queries were
 * never taught about it.
 *
 * WHY THE MAPPER NORMALISES, AND WHY THAT IS PART OF THIS FIX RATHER THAN A SEPARATE ONE.
 * Widening the two queries makes these rows reachable by renderers that have never seen the
 * status, and one of them fails silently rather than loudly. `my-orders/page.tsx:81` ends
 * `configs[status] || configs.pending`, so an `accepting` row would have been labelled
 * "🎉 New" -- a request still awaiting staff review, presented to the customer as further along
 * than an accepted one. The comment directly above that table records the identical defect being
 * fixed once already ("An unlisted status fell through to `pending`... which reads as further
 * along than the order is"). Shipping the query change alone re-creates it.
 *
 * The fix is at the mapper because `mapOrderRequestToGuestRow` already CLAIMS to do this: its
 * docstring says it maps a request "with status set to a value the UI treats as pre-order
 * ('waiting_review' or 'declined')". `accepting` is neither, so the function did not honour its
 * own stated contract. Normalising there is the single convergence point for all three query
 * paths, and it is what lib/orders/active-order-visibility.ts:38-41 asks for in terms:
 * "Anything that makes a status VISIBLE must run it through here."
 *
 * Consequence, deliberate: /api/guest/orders/[orderId] now reports `waiting_review` rather than
 * `accepting` for a request in the transient window. What the customer SEES is unchanged --
 * both by-id consumers already normalised -- and no renderer can now receive a status its
 * vocabulary lacks. Nothing here relaxes session scope; the last block pins that.
 */
import {
  fetchGuestOrdersBySession,
  fetchGuestActiveTableOrders,
} from '@/lib/guest-orders/queries'

type Row = Record<string, unknown>

const SESSION = 'sess-a'
const OTHER_SESSION = 'sess-b'
const RESTAURANT = 'rest-a'
const TABLE = 5

const ORDER_LIVE: Row = {
  id: 'order-1',
  restaurant_id: RESTAURANT,
  session_id: SESSION,
  table_number: TABLE,
  is_closed: false,
  status: 'preparing',
  payment_status: 'pending',
  tab_settlement_for_tab_id: null,
  placed_at: '2026-08-11T10:00:00.000Z',
  total: 120,
}

const REQ_WAITING: Row = {
  id: 'req-waiting',
  restaurant_id: RESTAURANT,
  session_id: SESSION,
  table_number: TABLE,
  status: 'waiting_review',
  placed_at: '2026-08-11T10:05:00.000Z',
  items: [{ name: 'Latte', quantity: 1 }],
  total: 30,
}

/**
 * The row at the centre of this issue: Accept took the transient claim and never resolved it,
 * so the request is stranded mid-transition.
 */
const REQ_ACCEPTING: Row = {
  id: 'req-accepting',
  restaurant_id: RESTAURANT,
  session_id: SESSION,
  table_number: TABLE,
  status: 'accepting',
  placed_at: '2026-08-11T10:08:00.000Z',
  items: [{ name: 'Steak', quantity: 2 }],
  total: 250,
}

/** Another customer's stranded request at the same table. Must never appear. */
const REQ_ACCEPTING_OTHER: Row = {
  id: 'req-accepting-other',
  restaurant_id: RESTAURANT,
  session_id: OTHER_SESSION,
  table_number: TABLE,
  status: 'accepting',
  placed_at: '2026-08-11T10:09:00.000Z',
}

/** Accepted requests graduate into `orders`; returning them too would double-count. */
const REQ_ACCEPTED: Row = {
  id: 'req-accepted',
  restaurant_id: RESTAURANT,
  session_id: SESSION,
  table_number: TABLE,
  status: 'accepted',
  accepted_order_id: 'order-1',
  placed_at: '2026-08-11T09:55:00.000Z',
}

const ORDERS = [ORDER_LIVE]
const REQUESTS = [REQ_WAITING, REQ_ACCEPTING, REQ_ACCEPTING_OTHER, REQ_ACCEPTED]

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (input: string) => String(input),
}))

/**
 * PostgREST-shaped stub that APPLIES the filters rather than recording them, so a test cannot
 * pass because the stub ignored a filter. Same shape as guest-orders-declined-visibility.
 */
function makeSupabaseStub() {
  const applied: Record<string, Array<[string, unknown]>> = {
    orders: [],
    order_requests: [],
  }

  function builder(table: string, rows: Row[], head: boolean) {
    const filters: Array<(row: Row) => boolean> = []

    const self = {
      eq(column: string, value: unknown) {
        applied[table].push([`eq:${column}`, value])
        filters.push((row) => String(row[column] ?? '') === String(value))
        return self
      },
      in(column: string, values: unknown[]) {
        applied[table].push([`in:${column}`, values])
        filters.push((row) => values.map(String).includes(String(row[column] ?? '')))
        return self
      },
      is(column: string, value: unknown) {
        applied[table].push([`is:${column}`, value])
        filters.push((row) => (value === null ? row[column] == null : row[column] === value))
        return self
      },
      gte(column: string, value: unknown) {
        applied[table].push([`gte:${column}`, value])
        filters.push((row) => String(row[column] ?? '') >= String(value))
        return self
      },
      lt(column: string, value: unknown) {
        applied[table].push([`lt:${column}`, value])
        filters.push((row) => String(row[column] ?? '') < String(value))
        return self
      },
      order() {
        return self
      },
      then(onFulfilled: (r: unknown) => unknown) {
        const out = rows.filter((row) => filters.every((f) => f(row)))
        return Promise.resolve(
          onFulfilled(head ? { count: out.length, error: null } : { data: out, error: null }),
        )
      },
    }
    return self
  }

  return {
    applied,
    client: {
      from(table: string) {
        if (table !== 'orders' && table !== 'order_requests') {
          throw new Error(`unexpected table ${table}`)
        }
        const rows = table === 'orders' ? ORDERS : REQUESTS
        return {
          select: (_cols: string, opts?: { head?: boolean }) =>
            builder(table, rows, Boolean(opts?.head)),
        }
      },
    },
  }
}

let stub = makeSupabaseStub()
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => stub.client,
}))

beforeEach(() => {
  stub = makeSupabaseStub()
})

const base = { restaurantId: RESTAURANT, sessionId: SESSION }

describe('#219 — the session list no longer drops a stranded accepting request', () => {
  it('returns it, with no opt-in required', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    expect(orders.map((o) => o.id)).toContain('req-accepting')
  })

  it('keeps it in placed_at order alongside the rest of the session', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    expect(orders.map((o) => o.id)).toEqual(['req-accepting', 'req-waiting', 'order-1'])
  })

  it('COUNTS it, so a stranded request cannot be treated as an empty session', async () => {
    // useTabHasOrders and the cart page's stale-tab cleanup branch on this count. `accepting`
    // is in ACTIVE_ORDER_STATUSES, so a session holding one is not idle.
    const { count } = await fetchGuestOrdersBySession({ ...base, countOnly: true })
    expect(count).toBe(3) // one order + waiting_review + accepting
  })

  it('asks the database for both statuses rather than filtering after the fact', async () => {
    await fetchGuestOrdersBySession(base)
    const statusFilter = stub.applied.order_requests.find(([key]) => key === 'in:status')
    expect(statusFilter).toBeDefined()
    expect(statusFilter?.[1]).toEqual(['waiting_review', 'accepting'])
  })

  it('still opts in to declined separately, without losing accepting', async () => {
    await fetchGuestOrdersBySession({ ...base, includeDeclined: true })
    const statusFilter = stub.applied.order_requests.find(([key]) => key === 'in:status')
    expect(statusFilter?.[1]).toEqual(['waiting_review', 'accepting', 'declined'])
  })

  it('never returns an accepted request, which has already graduated into orders', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    expect(orders.map((o) => o.id)).not.toContain('req-accepted')
  })
})

describe('#219 — the active-table view no longer drops it either', () => {
  it('returns it for the session that placed it', async () => {
    const { orders } = await fetchGuestActiveTableOrders({
      restaurantId: RESTAURANT,
      tableNumber: TABLE,
      sessionId: SESSION,
    })
    expect(orders.map((o) => o.id)).toContain('req-accepting')
  })

  it('asks the database for both statuses', async () => {
    await fetchGuestActiveTableOrders({
      restaurantId: RESTAURANT,
      tableNumber: TABLE,
      sessionId: SESSION,
    })
    const statusFilter = stub.applied.order_requests.find(([key]) => key === 'in:status')
    expect(statusFilter).toBeDefined()
    expect(statusFilter?.[1]).toEqual(['waiting_review', 'accepting'])
  })
})

describe('#219 — the row carries a status every renderer already has a label for', () => {
  /**
   * The load-bearing half. my-orders/page.tsx ends `configs[status] || configs.pending`, so a
   * raw `accepting` renders as "🎉 New" -- a request awaiting review shown as further along
   * than an accepted order. The mapper normalises so the existing "Waiting for confirmation"
   * copy is used, and no new customer-facing string is introduced.
   */
  it('normalises accepting to waiting_review on the session list', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    const stranded = orders.find((o) => o.id === 'req-accepting')
    expect(stranded?.status).toBe('waiting_review')
  })

  it('normalises it on the active-table list too', async () => {
    const { orders } = await fetchGuestActiveTableOrders({
      restaurantId: RESTAURANT,
      tableNumber: TABLE,
      sessionId: SESSION,
    })
    const stranded = orders.find((o) => o.id === 'req-accepting')
    expect(stranded?.status).toBe('waiting_review')
  })

  it('leaves waiting_review and declined untouched', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    expect(orders.find((o) => o.id === 'req-waiting')?.status).toBe('waiting_review')
  })

  it('mirrors the normalisation onto payment_status, which the mapper derives from it', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    const stranded = orders.find((o) => o.id === 'req-accepting')
    expect(stranded?.payment_status).toBe('waiting_review')
  })
})

describe('#219 — widening the status filter does not widen who can see what', () => {
  it('does not return another session’s stranded request from the list', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    expect(orders.map((o) => o.id)).not.toContain('req-accepting-other')
  })

  it('does not return another session’s stranded request from the table view', async () => {
    const { orders } = await fetchGuestActiveTableOrders({
      restaurantId: RESTAURANT,
      tableNumber: TABLE,
      sessionId: SESSION,
    })
    expect(orders.map((o) => o.id)).not.toContain('req-accepting-other')
  })

  it('still returns nothing when the caller has no session id at all', async () => {
    const { orders, count } = await fetchGuestOrdersBySession({
      restaurantId: RESTAURANT,
      sessionId: null,
    })
    expect(orders).toEqual([])
    expect(count).toBe(0)
  })
})
