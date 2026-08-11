/**
 * #219 — a request stranded in `accepting` vanished from the customer's list while its OWN page
 * still said "Waiting for Review".
 *
 * `accepting` is the transient claim `POST /api/order-requests/{id}/accept` takes before it
 * creates the order (accept/route.ts:73). Normally it lasts one `createOrder()` call. If the
 * release UPDATE fails or the worker dies it lasts forever (#215), and nothing sweeps it.
 *
 * THE ASYMMETRY THIS FIXES. Three customer-facing reads disagreed about the same row:
 *
 *   fetchGuestOrderById        no status filter -> row IS returned, and
 *                              normalizeOrderStatusForDisplay maps `accepting` -> `waiting_review`,
 *                              so the direct link reads "Waiting for Review", indefinitely.
 *   fetchGuestOrdersBySession  filtered to `waiting_review` -> row GONE from the list.
 *   fetchGuestActiveTableOrders(non-count) same -> row GONE from the table view.
 *
 * So one order was simultaneously "still being reviewed" on its own page and absent from every
 * list that should have contained it. `ACTIVE_ORDER_STATUSES` already includes `accepting`
 * deliberately (active-order-visibility.ts:21-30) — the two list queries were simply never taught
 * about it.
 *
 * WHY THIS IS NOT AN OPT-IN, unlike `declined` (see guest-orders-declined-visibility.test.ts).
 * `declined` is TERMINAL and the live view is right to drop it. `accepting` is a `waiting_review`
 * row that has been picked up: it is LIVE by the project's own classification, so both audiences
 * want it and it belongs in the default filter. It must also keep a tab alive and keep suppressing
 * the cart's stale-tab cleanup, exactly as the `waiting_review` it was a millisecond earlier did —
 * which is what the count test below pins.
 *
 * NO NEW CUSTOMER-FACING COPY. Every renderer that shows one of these rows runs it through
 * normalizeOrderStatusForDisplay, which already maps `accepting` to `waiting_review`, so these
 * rows render with the string a waiting-review row renders today.
 */
import { fetchGuestOrdersBySession, fetchGuestActiveTableOrders } from '@/lib/guest-orders/queries'
import { normalizeOrderStatusForDisplay, isActiveOrderStatus } from '@/lib/orders/active-order-visibility'

type Row = Record<string, unknown>

const SESSION = 'sess-a'
const OTHER_SESSION = 'sess-b'
const RESTAURANT = 'rest-a'
const TABLE = 5

const ORDER_ACCEPTED: Row = {
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

/** The row at the centre of this issue: claimed by an Accept that never finished. */
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
  total: 99,
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

const ORDERS = [ORDER_ACCEPTED]
const REQUESTS = [REQ_WAITING, REQ_ACCEPTING, REQ_ACCEPTING_OTHER, REQ_ACCEPTED]

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (input: string) => String(input),
}))

/** PostgREST-shaped stub that APPLIES filters rather than recording them. */
function makeSupabaseStub() {
  const applied: Record<string, Array<[string, unknown]>> = { orders: [], order_requests: [] }

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

describe('the premise: the project already classes `accepting` as live', () => {
  it('is an active order status', () => {
    expect(isActiveOrderStatus('accepting')).toBe(true)
  })

  it('renders as waiting_review, so surfacing it needs no new copy', () => {
    expect(normalizeOrderStatusForDisplay('accepting')).toBe('waiting_review')
  })
})

describe('fetchGuestOrdersBySession — a stranded request no longer vanishes', () => {
  it('returns the accepting request in the session list', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    expect(orders.map((o) => o.id)).toContain('req-accepting')
  })

  it('places it in placed_at order alongside the rest of the session', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    expect(orders.map((o) => o.id)).toEqual(['req-accepting', 'req-waiting', 'order-1'])
  })

  it('COUNTS it, so it keeps a tab alive exactly as the waiting_review it just was did', async () => {
    // useTabHasOrders and the cart page's stale-tab cleanup both branch on this count.
    const { count } = await fetchGuestOrdersBySession({ ...base, countOnly: true })
    expect(count).toBe(3) // one order + waiting_review + accepting
  })

  it('asks the database for both statuses rather than filtering after the fact', async () => {
    await fetchGuestOrdersBySession(base)
    const statusFilter = stub.applied.order_requests.find(([key]) => key === 'in:status')
    expect(statusFilter?.[1]).toEqual(['waiting_review', 'accepting'])
  })

  it('still excludes declined by default — this change does not widen that', async () => {
    await fetchGuestOrdersBySession(base)
    const statusFilter = stub.applied.order_requests.find(([key]) => key === 'in:status')
    expect(statusFilter?.[1]).not.toContain('declined')
  })

  it('still never returns an accepted request, which has graduated into orders', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    expect(orders.map((o) => o.id)).not.toContain('req-accepted')
  })
})

describe('fetchGuestActiveTableOrders — same row, same fix', () => {
  it('returns the accepting request for the session that placed it', async () => {
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
    expect(statusFilter?.[1]).toEqual(['waiting_review', 'accepting'])
  })
})

describe('surfacing it does not widen who can see what', () => {
  it('does not return another session’s stranded request', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    expect(orders.map((o) => o.id)).not.toContain('req-accepting-other')
  })

  it('does not return another session’s stranded request from the table view either', async () => {
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
