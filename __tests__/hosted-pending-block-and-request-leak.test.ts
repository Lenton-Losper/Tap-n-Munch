/**
 * #243 and #248, and the fact that ONE MASKS THE OTHER.
 *
 * This file is an INVESTIGATION ARTIFACT AND A TRIPWIRE. It asserts the CURRENT behaviour of
 * `fetchGuestActiveTableOrders` at this commit, including the parts that are wrong, so the
 * interaction between the two issues is a measured fact rather than a reading of the code. It
 * deliberately does NOT encode what the behaviour should become — see the ruling packet.
 *
 * READ THIS BEFORE "FIXING" A FAILURE HERE. The assertions in the last two describe blocks pin
 * DEFECTIVE behaviour on purpose. When #248 is fixed they SHOULD go red, and that red is the
 * signal working, not a regression — invert them to assert the leak is closed and say so in the
 * commit. A green suite that pins a defect is a recorded hazard in this repo (#131, #146); this
 * header is the mitigation. Nothing here should be read as a specification.
 *
 * #243 — app/menu/[restaurantId]/v2/page.tsx:594 asks for the recent hosted-pending order with
 * neither `sessionId` nor `countOnly`. queries.ts:231-233 fails closed on exactly that pair, so
 * the call returns `{orders: [], count: 0}` unconditionally, `recentHostedPending` is always set
 * to null, and `blockOrderingForHostedPending` (v2:625) is ALWAYS FALSE. The banner at v2:1069
 * and the six `disabled=` bindings it feeds have never fired.
 *
 * #248 — the `payment_status` / `payment_channel` filters are applied to the `orders` query only
 * (queries.ts:246-251). The `order_requests` query (271-284) is scoped by restaurant, table,
 * status and session, and NOT by payment. Both are merged. So a caller asking specifically for
 * "pending hosted payments" is also handed every `waiting_review` order request in the window —
 * rows that carry no payment at all. `mapOrderRequestToGuestRow` sets `payment_status: status`
 * (queries.ts:32), so such a row reports `payment_status: 'waiting_review'`.
 *
 * THE INTERACTION, which is the reason neither should be fixed alone: today #243 MASKS #248 on
 * this call path. The fail-closed return happens BEFORE either query runs, so the unfiltered
 * order_requests never reach the v2 page. Passing `sessionId` to fix #243 removes the early
 * return and the unfiltered rows start arriving — at a call site that does no re-filtering and
 * takes `recentPending[0]`. The last test below is that proof.
 *
 * PROOF CEILING: UNIT, against a PostgREST-shaped stub that APPLIES filters rather than
 * recording them — so a filter the code fails to apply shows up as a row that should not be
 * there, not as a missing assertion. It models query construction faithfully; it is not the
 * database, and it says nothing about how many real rows exist in either state.
 */
import { fetchGuestActiveTableOrders } from '@/lib/guest-orders/queries'

type Row = Record<string, unknown>

const RESTAURANT = 'riviera'
const TABLE = 5
const SESSION = 'sess-a'
const TEN_MIN_AGO = '2026-08-11T10:00:00.000Z'

/** A genuine abandoned hosted checkout — the row the block was built to notice. */
const ORDER_HOSTED_PENDING: Row = {
  id: 'order-hosted',
  restaurant_id: RESTAURANT,
  table_number: TABLE,
  session_id: SESSION,
  is_closed: false,
  status: 'pending',
  payment_status: 'pending',
  payment_channel: 'hosted',
  placed_at: '2026-08-11T10:05:00.000Z',
  total: 250,
}

/** Same table, another customer's session. Must never reach this customer. */
const ORDER_HOSTED_PENDING_OTHER_SESSION: Row = {
  ...ORDER_HOSTED_PENDING,
  id: 'order-hosted-other',
  session_id: 'sess-b',
}

/** A paid order — excluded by payment_status. */
const ORDER_PAID: Row = {
  ...ORDER_HOSTED_PENDING,
  id: 'order-paid',
  payment_status: 'paid',
}

/**
 * A PLAIN QR ORDER REQUEST. No payment has been attempted: no hosted checkout, no payment
 * channel, nothing pending at a gateway. It is simply waiting for staff to review it. This row
 * is the whole of #248 — it must not come back from a query asking for hosted pending payments.
 */
const REQUEST_WAITING_NO_PAYMENT: Row = {
  id: 'req-waiting',
  restaurant_id: RESTAURANT,
  table_number: TABLE,
  session_id: SESSION,
  status: 'waiting_review',
  payment_channel: null,
  placed_at: '2026-08-11T10:07:00.000Z',
  items: [{ name: 'Latte', quantity: 1 }],
  total: 30,
}

/** Mutable so a test can model a table with NO pending payment at all. Reset in beforeEach. */
let ORDERS: Row[] = []
let REQUESTS: Row[] = []

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (input: string) => String(input),
}))

/**
 * PostgREST-shaped stub that APPLIES filters. Same approach as
 * guest-orders-declined-visibility.test.ts: a stub that only RECORDED calls would let an
 * unapplied filter pass silently, which is exactly the defect under investigation.
 */
function makeSupabaseStub() {
  const applied: Record<string, string[]> = { orders: [], order_requests: [] }

  function builder(table: string, rows: Row[], head: boolean) {
    const filters: Array<(row: Row) => boolean> = []
    const self = {
      eq(column: string, value: unknown) {
        applied[table].push(`eq:${column}`)
        filters.push((row) => String(row[column] ?? '') === String(value))
        return self
      },
      gte(column: string, value: unknown) {
        applied[table].push(`gte:${column}`)
        filters.push((row) => String(row[column] ?? '') >= String(value))
        return self
      },
      lt(column: string, value: unknown) {
        applied[table].push(`lt:${column}`)
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
    applied,
    client: {
      from(table: string) {
        if (table !== 'orders' && table !== 'order_requests') {
          throw new Error(`unexpected table ${table}`)
        }
        return {
          select: (_cols: string, opts?: { head?: boolean }) =>
            builder(table, table === 'orders' ? ORDERS : REQUESTS, Boolean(opts?.head)),
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
  ORDERS = [ORDER_HOSTED_PENDING, ORDER_HOSTED_PENDING_OTHER_SESSION, ORDER_PAID]
  REQUESTS = [REQUEST_WAITING_NO_PAYMENT]
  stub = makeSupabaseStub()
})

/** Exactly what v2/page.tsx:594 sends today — no sessionId, no countOnly. */
const V2_CALL_AS_SHIPPED = {
  restaurantId: RESTAURANT,
  tableNumber: TABLE,
  paymentStatus: 'pending',
  paymentChannel: 'hosted',
  placedAfter: TEN_MIN_AGO,
}

describe('#243 — the hosted-pending ordering block can never fire', () => {
  it('returns nothing for the call v2 actually makes, so the block is always false', async () => {
    const { orders, count } = await fetchGuestActiveTableOrders(V2_CALL_AS_SHIPPED)

    expect(orders).toEqual([])
    expect(count).toBe(0)
  })

  it('fails closed BEFORE querying — no query is built at all', async () => {
    await fetchGuestActiveTableOrders(V2_CALL_AS_SHIPPED)

    // This is what makes #243 mask #248: the early return precedes both queries, so the
    // unfiltered order_requests cannot reach the caller no matter what they contain.
    expect(stub.applied.orders).toEqual([])
    expect(stub.applied.order_requests).toEqual([])
  })

  it('the matching row DOES exist — the block is dark, not unnecessary', async () => {
    // Same call WITH session scope. The abandoned hosted checkout is right there.
    const { orders } = await fetchGuestActiveTableOrders({
      ...V2_CALL_AS_SHIPPED,
      sessionId: SESSION,
    })

    expect(orders.map((o) => String(o.id))).toContain('order-hosted')
  })

  it('the sibling countOnly call on the same screen is unaffected', async () => {
    // v2:577 passes countOnly, so it bypasses the guard and works. Only the second call is dark.
    const { count } = await fetchGuestActiveTableOrders({
      restaurantId: RESTAURANT,
      tableNumber: TABLE,
      paymentStatus: 'pending',
      paymentChannel: 'hosted',
      placedBefore: '2026-08-11T23:59:59.000Z',
      countOnly: true,
    })

    expect(count).toBeGreaterThan(0)
  })
})

describe('#248 — payment filters are applied to orders only, not to order_requests', () => {
  it('applies payment_status and payment_channel to the orders query', async () => {
    await fetchGuestActiveTableOrders({ ...V2_CALL_AS_SHIPPED, sessionId: SESSION })

    expect(stub.applied.orders).toContain('eq:payment_status')
    expect(stub.applied.orders).toContain('eq:payment_channel')
  })

  it('does NOT apply them to the order_requests query', async () => {
    await fetchGuestActiveTableOrders({ ...V2_CALL_AS_SHIPPED, sessionId: SESSION })

    expect(stub.applied.order_requests).not.toContain('eq:payment_status')
    expect(stub.applied.order_requests).not.toContain('eq:payment_channel')
  })

  it('so a request with NO payment comes back from a hosted-payment query', async () => {
    const { orders } = await fetchGuestActiveTableOrders({
      ...V2_CALL_AS_SHIPPED,
      sessionId: SESSION,
    })

    const leaked = orders.find((o) => String(o.id) === 'req-waiting')
    expect(leaked).toBeDefined()
    // It does not even claim to be a pending payment; it reports the request's own status.
    expect(String(leaked?.payment_status)).toBe('waiting_review')
    expect(leaked?.payment_channel).toBeNull()
  })
})

describe('the interaction — #243 masks #248, and fixing #243 alone unmasks it', () => {
  it('AS SHIPPED: the leak cannot reach the page, because the query never runs', async () => {
    const { orders } = await fetchGuestActiveTableOrders(V2_CALL_AS_SHIPPED)

    expect(orders).toEqual([])
  })

  it('WITH #243 FIXED IN ISOLATION: a plain QR request becomes the hosted-pending row', async () => {
    // The minimal #243 fix is to pass the session id. Nothing else changes.
    const { orders } = await fetchGuestActiveTableOrders({
      ...V2_CALL_AS_SHIPPED,
      sessionId: SESSION,
    })

    // v2:603 takes the FIRST row of the merged, placed_at-descending list and does no
    // re-filtering. mapOrderRequestToGuestRow puts requests ahead of orders in the merge, and
    // this request is also the most recent.
    const rowThePageWouldUse = orders[0]

    expect(String(rowThePageWouldUse.id)).toBe('req-waiting')
    expect(String(rowThePageWouldUse.payment_status)).toBe('waiting_review')

    // Consequence, stated plainly: v2 would set recentHostedPending from this row, show
    // "A payment is being processed for this table", and disable ordering — for a customer who
    // has started no payment at all.
  })

  it('WITH #243 FIXED IN ISOLATION: it fires with NO pending payment on the table at all', async () => {
    // The cleanest statement of the leak, and it depends on no timestamp ordering: a table where
    // nobody has attempted any payment, and one customer is waiting for staff to review a plain
    // QR order request.
    ORDERS = []

    const { orders } = await fetchGuestActiveTableOrders({
      ...V2_CALL_AS_SHIPPED,
      sessionId: SESSION,
    })

    expect(orders).toHaveLength(1)
    expect(String(orders[0].id)).toBe('req-waiting')

    // So the page would tell a customer who has paid nothing that "A payment is being processed
    // for this table", and disable every ordering control for ten minutes. There is no pending
    // payment anywhere in this scenario.
  })
})
