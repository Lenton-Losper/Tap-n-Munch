/**
 * #249 and #248 — `fetchGuestActiveTableOrders`, count path versus row path.
 *
 * TWO DEFECTS IN ONE FUNCTION, and fixing either alone would have made the other worse:
 *
 *   #249  `countOnly` counted `orders` alone while the row path returned `requestRows + orders`
 *         and reported `count: merged.length`. The SAME function answered the same question two
 *         different ways depending on a boolean. The landing calls it with `countOnly` and, on a
 *         zero, wipes the customer's active-order banner state — so a customer whose only live
 *         item was an unaccepted request had the one thing telling them about it thrown away.
 *
 *   #248  the request query never applied `paymentStatus` / `paymentChannel`, so a lookup asking
 *         a specifically payment-shaped question got requests back that could not possibly match
 *         it. The live instance is the landing's hosted-checkout expiry check.
 *
 * Making the count include requests WITHOUT fixing #248 would have propagated the second defect
 * into the count path, and the landing would have fired `/api/orders/expire-pending` on the
 * strength of an unrelated `waiting_review` request. So they are fixed together, and
 * `countMatchesRows` below is the assertion that keeps them fixed together.
 *
 * The stub APPLIES filters rather than recording them — same shape as
 * `guest-orders-accepting-visibility` — so a test cannot pass because the stub ignored a filter.
 */
import { fetchGuestActiveTableOrders } from '@/lib/guest-orders/queries'

type Row = Record<string, unknown>

const RESTAURANT = 'rest-1'
const SESSION = 'sess-1'
const TABLE = 12

const ORDER_HOSTED_PENDING: Row = {
  id: 'order-hosted',
  restaurant_id: RESTAURANT,
  table_number: TABLE,
  session_id: SESSION,
  member_session_id: SESSION,
  status: 'pending',
  payment_status: 'pending',
  payment_channel: 'hosted',
  is_closed: false,
  placed_at: '2026-08-16T00:00:00.000Z',
  total: 100,
  items: [],
}

/** A live request. It has no payment_channel at all — that is the point of #248. */
const REQ_WAITING: Row = {
  id: 'req-waiting',
  restaurant_id: RESTAURANT,
  table_number: TABLE,
  session_id: SESSION,
  member_session_id: SESSION,
  status: 'waiting_review',
  is_closed: false,
  placed_at: '2026-08-16T00:05:00.000Z',
  total: 20,
  items: [],
}

const ORDERS = [ORDER_HOSTED_PENDING]
const REQUESTS = [REQ_WAITING]

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (input: string) => String(input),
}))

function makeSupabaseStub() {
  const touched: string[] = []

  function builder(table: string, rows: Row[], head: boolean) {
    const filters: Array<(row: Row) => boolean> = []
    const self = {
      eq(column: string, value: unknown) {
        filters.push((row) => String(row[column] ?? '') === String(value))
        return self
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.map(String).includes(String(row[column] ?? '')))
        return self
      },
      is(column: string, value: unknown) {
        filters.push((row) => (value === null ? row[column] == null : row[column] === value))
        return self
      },
      gte(column: string, value: unknown) {
        filters.push((row) => String(row[column] ?? '') >= String(value))
        return self
      },
      lt(column: string, value: unknown) {
        filters.push((row) => String(row[column] ?? '') < String(value))
        return self
      },
      order() {
        return self
      },
      then(onFulfilled: (r: unknown) => unknown) {
        const out = rows.filter((row) => filters.every((f) => f(row)))
        return Promise.resolve(
          onFulfilled(head ? { count: out.length, error: null } : { data: out, error: null })
        )
      },
    }
    return self
  }

  return {
    touched,
    client: {
      from(table: string) {
        touched.push(table)
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

const base = {
  restaurantId: RESTAURANT,
  tableNumber: TABLE,
  sessionId: SESSION,
  sessionIds: [SESSION],
}

describe('#249 — the count and the rows answer the same question', () => {
  it('countMatchesRows: countOnly equals the row path length', async () => {
    const rows = await fetchGuestActiveTableOrders({ ...base })
    const counted = await fetchGuestActiveTableOrders({ ...base, countOnly: true })

    // The assertion the whole file exists for. Before the fix: rows 2, count 1.
    expect(counted.count).toBe(rows.orders.length)
    expect(counted.count).toBe(2)
  })

  it('counts a live request, not just an order', async () => {
    const counted = await fetchGuestActiveTableOrders({ ...base, countOnly: true })
    // The landing wipes the active-order banner state on a zero. A customer whose only live
    // item is an unaccepted request must not read as zero.
    expect(counted.count).toBeGreaterThan(0)
    expect(stub.touched).toContain('order_requests')
  })
})

describe('#248 — a payment-shaped question excludes requests', () => {
  it('does not count a request when a payment filter is supplied', async () => {
    const counted = await fetchGuestActiveTableOrders({
      ...base,
      paymentStatus: 'pending',
      paymentChannel: 'hosted',
      countOnly: true,
    })
    // Only the hosted order. A waiting_review request has no payment_channel and cannot match.
    expect(counted.count).toBe(1)
  })

  it('does not RETURN a request when a payment filter is supplied', async () => {
    const { orders } = await fetchGuestActiveTableOrders({
      ...base,
      paymentStatus: 'pending',
      paymentChannel: 'hosted',
    })
    expect(orders.map((o) => o.id)).toEqual(['order-hosted'])
  })

  it('does not even query order_requests when a payment filter is supplied', async () => {
    await fetchGuestActiveTableOrders({
      ...base,
      paymentStatus: 'pending',
      paymentChannel: 'hosted',
      countOnly: true,
    })
    // Stronger than filtering the result: the question is not asked at all.
    expect(stub.touched).not.toContain('order_requests')
  })

  it('and the two paths still agree under a payment filter', async () => {
    const rows = await fetchGuestActiveTableOrders({
      ...base,
      paymentStatus: 'pending',
      paymentChannel: 'hosted',
    })
    const counted = await fetchGuestActiveTableOrders({
      ...base,
      paymentStatus: 'pending',
      paymentChannel: 'hosted',
      countOnly: true,
    })
    expect(counted.count).toBe(rows.orders.length)
  })
})
