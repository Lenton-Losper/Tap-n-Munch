/**
 * Phase 3.3 — a DECLINED order request vanished from the customer's order list.
 *
 * `fetchGuestOrdersBySession` merged `orders` rows with `order_requests` rows filtered
 * `.eq('status','waiting_review')`. The moment staff declined a request it dropped out of that
 * second query, so the customer's list lost it entirely — no row, no badge, no record it was
 * ever placed. By DIRECT LINK they were still told (`fetchGuestOrderById` has no status filter
 * and receipt-types maps `declined` to a DECLINED badge), so the customer who kept the tab open
 * saw the decline and the customer who navigated back to the list saw nothing at all. The staff
 * decline dialog meanwhile promises "The customer will see it was declined".
 *
 * WHY THIS IS AN OPT-IN RATHER THAN A WIDER FILTER. `fetchGuestOrdersBySession` has eight
 * callers and they are two different audiences. The LIVE view — the status tracker, the active
 * -order banner, and the `countOnly` callers that ask "does this session have orders?" — is
 * right to ignore a declined request: `lib/orders/active-order-visibility.ts` classifies
 * `declined` as TERMINAL alongside `completed` and `cancelled`, and a declined request must not
 * keep a tab alive or suppress the stale-tab cleanup in the cart page. The RECORD view — the
 * my-orders list — must show it. So the default is unchanged and the list opts in.
 *
 * HOW LONG A DECLINED REQUEST STAYS is therefore not a new rule: it stays exactly as long as
 * the two sibling terminal states already do. The list drops rows on `is_closed`, not on a
 * timer, so a completed or cancelled order remains for the life of the session and a declined
 * one now does too. Any time-based cutoff would be an unjustifiable number whose failure mode
 * is precisely the disappearing-order defect being fixed here.
 *
 * `declined_reason` IS DELIBERATELY NOT EXPOSED. Staff type it under an explicit promise — the
 * dashboard input reads "Reason (optional, shown to staff only)" — so it must not reach a
 * customer-facing payload, and the last test here pins that. (It is currently read by nobody at
 * all, staff included; that contradiction is raised as a ruling packet, not resolved here.)
 */
import { fetchGuestOrdersBySession } from '@/lib/guest-orders/queries'

type Row = Record<string, unknown>

const SESSION = 'sess-a'
const OTHER_SESSION = 'sess-b'
const RESTAURANT = 'rest-a'

/** A real order, already accepted and living in `orders`. */
const ORDER_ACCEPTED: Row = {
  id: 'order-1',
  restaurant_id: RESTAURANT,
  session_id: SESSION,
  table_number: 5,
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
  table_number: 5,
  status: 'waiting_review',
  placed_at: '2026-08-11T10:05:00.000Z',
  items: [{ name: 'Latte', quantity: 1 }],
  total: 30,
}

/**
 * The row at the centre of this issue. The reason is written to look like the internal note a
 * staff member would actually type given the "shown to staff only" label, so that the
 * no-leak test below fails loudly rather than decoratively.
 */
const REQ_DECLINED: Row = {
  id: 'req-declined',
  restaurant_id: RESTAURANT,
  session_id: SESSION,
  table_number: 5,
  status: 'declined',
  declined_reason: 'kitchen shut early, regular timewaster — do not tell them that',
  decided_at: '2026-08-11T10:12:00.000Z',
  placed_at: '2026-08-11T10:10:00.000Z',
  items: [{ name: 'Steak', quantity: 2 }],
  total: 250,
}

/** Accepted requests graduate into `orders`; returning them too would double-count. */
const REQ_ACCEPTED: Row = {
  id: 'req-accepted',
  restaurant_id: RESTAURANT,
  session_id: SESSION,
  status: 'accepted',
  accepted_order_id: 'order-1',
  placed_at: '2026-08-11T09:55:00.000Z',
}

/** Another customer's declined request at the same restaurant. Must never appear. */
const REQ_DECLINED_OTHER: Row = {
  id: 'req-declined-other',
  restaurant_id: RESTAURANT,
  session_id: OTHER_SESSION,
  status: 'declined',
  declined_reason: 'someone else business',
  placed_at: '2026-08-11T10:11:00.000Z',
}

const ORDERS = [ORDER_ACCEPTED]
const REQUESTS = [REQ_WAITING, REQ_DECLINED, REQ_ACCEPTED, REQ_DECLINED_OTHER]

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (input: string) => String(input),
}))

/**
 * PostgREST-shaped stub that APPLIES the filters rather than recording them. If it ignored
 * `.in('session_id', …)` the cross-session test below would pass for the wrong reason.
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
        const rows = table === 'orders' ? ORDERS : REQUESTS
        if (table !== 'orders' && table !== 'order_requests') {
          throw new Error(`unexpected table ${table}`)
        }
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

describe('the live view is unchanged — declined stays out by default', () => {
  it('does not return a declined request when nothing opts in', async () => {
    const { orders } = await fetchGuestOrdersBySession(base)
    expect(orders.map((o) => o.id)).toEqual(['req-waiting', 'order-1'])
  })

  it('does not COUNT a declined request by default, so it cannot keep a tab alive', async () => {
    // useTabHasOrders and the cart page's stale-tab cleanup both branch on this count.
    const { count } = await fetchGuestOrdersBySession({ ...base, countOnly: true })
    expect(count).toBe(2) // one order + one waiting_review request, not the declined one
  })

  it('never returns an accepted request, which has already graduated into orders', async () => {
    const { orders } = await fetchGuestOrdersBySession({ ...base, includeDeclined: true })
    expect(orders.map((o) => o.id)).not.toContain('req-accepted')
  })
})

describe('the record view — a declined request no longer vanishes from the list', () => {
  it('returns the declined request when the caller opts in', async () => {
    const { orders } = await fetchGuestOrdersBySession({ ...base, includeDeclined: true })
    expect(orders.map((o) => o.id)).toContain('req-declined')
  })

  it('keeps it in placed_at order alongside the rest of the session', async () => {
    const { orders } = await fetchGuestOrdersBySession({ ...base, includeDeclined: true })
    expect(orders.map((o) => o.id)).toEqual(['req-declined', 'req-waiting', 'order-1'])
  })

  it('carries a status the DECLINED badge can render', async () => {
    const { orders } = await fetchGuestOrdersBySession({ ...base, includeDeclined: true })
    const declined = orders.find((o) => o.id === 'req-declined')
    expect(declined?.status).toBe('declined')
  })

  it('asks the database for every opted-in status rather than filtering after the fact', async () => {
    // `accepting` joined the LIVE set in #219 -- it is the transient claim Accept takes and had
    // been filtered out at the database, so a stranded request vanished from this same list.
    // The opt-in this file is about is unaffected: `declined` is still added only on request,
    // which every other assertion here continues to pin.
    await fetchGuestOrdersBySession({ ...base, includeDeclined: true })
    const statusFilter = stub.applied.order_requests.find(([key]) => key === 'in:status')
    expect(statusFilter).toBeDefined()
    expect(statusFilter?.[1]).toEqual(['waiting_review', 'accepting', 'declined'])
  })
})

describe('opting in does not widen who can see what', () => {
  it('still returns nothing when the caller has no session id at all', async () => {
    const { orders, count } = await fetchGuestOrdersBySession({
      restaurantId: RESTAURANT,
      sessionId: null,
      includeDeclined: true,
    })
    expect(orders).toEqual([])
    expect(count).toBe(0)
  })

  it('does not return another session’s declined request', async () => {
    const { orders } = await fetchGuestOrdersBySession({ ...base, includeDeclined: true })
    expect(orders.map((o) => o.id)).not.toContain('req-declined-other')
  })

  it('scopes the request query by session in the query itself', async () => {
    await fetchGuestOrdersBySession({ ...base, includeDeclined: true })
    expect(stub.applied.order_requests).toContainEqual(['in:session_id', [SESSION]])
  })
})

describe('declined_reason is never handed to the customer', () => {
  /**
   * Staff type it under "Reason (optional, shown to staff only)". This payload is served to the
   * browser, so a field appearing here is disclosed whether or not any component renders it.
   */
  it('is absent from the returned row', async () => {
    const { orders } = await fetchGuestOrdersBySession({ ...base, includeDeclined: true })
    const declined = orders.find((o) => o.id === 'req-declined')

    expect(declined).toBeDefined()
    expect(declined).not.toHaveProperty('declined_reason')
    expect(JSON.stringify(declined)).not.toContain('timewaster')
  })
})
