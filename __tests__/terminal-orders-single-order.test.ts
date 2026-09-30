/**
 * GET /api/terminal/orders?orderId=<id> answers for ONE order (Payment screen performance).
 *
 * The terminal's getOrder() needs one order. Until this change the route had no way to be asked
 * for one, so the terminal pulled the restaurant's entire live-order list -- 4,675 rows / 11.8 MB
 * at FNB ChowNow on 2026-09-30 -- and the server paginated through all of it, read payment
 * projections for all of it and computed financials for all of it, one sequential batch at a time,
 * so that the device could Array.find one row. Production logs that morning: p90 >= 13 s, max >= 55 s.
 *
 * WHAT THIS SUITE MEASURES, NOT ASSERTS ABOUT THE CODE. Every Supabase read goes through a
 * recording proxy, so the tests count the ORDER ROWS the route actually loaded and the ORDER IDS
 * the projection/financials reads were asked about. A route that returned the right order after
 * loading all of them would pass every "returns the right order" check and fail these.
 *
 * Projections and financials are the REAL implementations over the in-memory PostgREST fake, so
 * the single-order response is compared field-for-field with the list's row for the same order.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OTHER_RESTAURANT = 'b2999166-ddfa-40d1-ad1f-2f01282a1653'

let mockDb: InMemoryDb
const mockSweep = jest.fn(async (..._args: unknown[]) => undefined)
let mockPermissions: string[] = ['orders:update', 'orders:read']

/** One record per `.from(table)` call: the builder calls made on it and the rows it returned. */
type QueryRecord = { table: string; calls: Array<[string, unknown[]]>; rowsReturned: number }
let mockQueries: QueryRecord[] = []

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    get permissions() {
      return mockPermissions
    },
  }),
  validateTerminalRecord: async () => undefined,
}))
// The POST half of the route's module graph, stubbed so the GET can load without a browser client.
jest.mock('@/lib/supabase/restaurants', () => ({ resolveOrderRestaurantScope: async () => null }))
jest.mock('@/lib/order-routing', () => ({ enrichOrderItemsWithRouteTo: async () => [] }))
jest.mock('@/lib/orders/check-stock-sufficiency', () => ({ checkStockSufficiency: async () => ({ ok: true }) }))
jest.mock('@/lib/orders/create-order', () => ({ createOrder: async () => null }))
jest.mock('@/lib/orders/auto-cancel-stale-pos-orders', () => ({
  autoCancelStalePosOrders: (...args: unknown[]) => mockSweep(...args),
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const real = mockDb.client()
    return {
      ...real,
      from(table: string) {
        const record: QueryRecord = { table, calls: [], rowsReturned: 0 }
        mockQueries.push(record)
        return mockRecordingBuilder(real.from(table), record)
      },
    }
  },
}))

function mockCountRows(data: unknown): number {
  if (Array.isArray(data)) return data.length
  return data ? 1 : 0
}

/** Passes every call through to the fake, recording it, and counts the rows each await yields. */
function mockRecordingBuilder(target: any, record: QueryRecord): any {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') {
        return (ok?: (v: any) => unknown, err?: (e: unknown) => unknown) =>
          t.then((res: any) => {
            record.rowsReturned += mockCountRows(res?.data)
            return ok ? ok(res) : res
          }, err)
      }
      const value = t[prop]
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        record.calls.push([String(prop), args])
        const out = value.apply(t, args)
        if (out === t) return mockRecordingBuilder(t, record)
        if (out && typeof out.then === 'function') {
          return Promise.resolve(out).then((res: any) => {
            record.rowsReturned += mockCountRows(res?.data)
            return res
          })
        }
        return out
      }
    },
  })
}

beforeEach(() => {
  mockQueries = []
  mockSweep.mockClear()
  mockPermissions = ['orders:update', 'orders:read']
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

// ---------------------------------------------------------------------------------------------
// Fixture: a busy restaurant, one target order on a tab with a voided line and a card sale, a
// cancelled order, and another restaurant's order.
// ---------------------------------------------------------------------------------------------

function uuid(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

type Seeded = { target: string; untabbed: string; cancelled: string; foreign: string; bulk: string[] }

function seed(bulkCount: number): Seeded {
  const f = new AmendFixture('0000cccc-0000-4000-8000-000000000077')
  const target = f.place([
    { name: 'Burger', quantity: 1, total: 220 },
    { name: 'Steak', quantity: 1, total: 500 },
  ]).id
  f.amend(target, 'Steak', 0)
  const cancelled = f.place([{ name: 'Soup', quantity: 1, total: 80 }], { status: 'cancelled' }).id

  const untabbed = uuid('0000dddd', 1)
  const foreign = uuid('0000eeee', 1)
  const bulk = Array.from({ length: bulkCount }, (_, i) => uuid('0000ffff', i + 1))

  const plain = (id: string, restaurant: string, minute: number) => ({
    id,
    restaurant_id: restaurant,
    tab_id: null,
    status: 'pending',
    payment_status: 'pending',
    total: 5,
    subtotal: 5,
    order_number: minute,
    placed_at: new Date(Date.UTC(2026, 8, 1) + minute * 60_000).toISOString(),
  })

  mockDb = new InMemoryDb({
    orders: [
      ...f.orders.map((o, i) => ({
        ...o,
        restaurant_id: RESTAURANT,
        placed_at: `2026-09-30T07:4${i}:00.000Z`,
      })),
      plain(untabbed, RESTAURANT, 2),
      plain(foreign, OTHER_RESTAURANT, 3),
      ...bulk.map((id, i) => plain(id, RESTAURANT, 10 + i)),
    ],
    order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
    payment_events: [
      {
        restaurant_id: RESTAURANT,
        event_type: 'sale',
        business_order_no: 'FT-TARGET-1',
        amount: 220,
        currency: 'NAD',
        order_ids: [target],
        created_at: '2026-09-30T07:45:00.000Z',
      },
    ],
  })
  return { target, untabbed, cancelled, foreign, bulk }
}

type Listed = Record<string, unknown> & { id: string }

async function get(query = ''): Promise<{ status: number; body: { orders?: Listed[]; error?: string; code?: string } }> {
  const { GET } = await import('@/app/api/terminal/orders/route')
  const res = await GET(new Request(`http://localhost/api/terminal/orders${query}`))
  return { status: res.status, body: await res.json() }
}

/** Order rows the route loaded from the `orders` table, across every query it made. */
function orderRowsLoaded(): number {
  return mockQueries.filter((q) => q.table === 'orders').reduce((n, q) => n + q.rowsReturned, 0)
}

/**
 * Every order id any NON-orders read was asked about -- the projection read (`order_ids`
 * overlaps) and the financials reads (`.in('order_id', ...)` and friends).
 */
function orderIdsEnriched(): Set<string> {
  const ids = new Set<string>()
  for (const q of mockQueries) {
    if (q.table === 'orders') continue
    for (const [method, args] of q.calls) {
      if (!['in', 'overlaps', 'contains'].includes(method)) continue
      const [column, values] = args as [string, unknown[]]
      if (!/order_id/.test(column)) continue
      for (const v of values ?? []) ids.add(String(v))
    }
  }
  return ids
}

// ---------------------------------------------------------------------------------------------

describe('single-order path: one order requested -> one order loaded', () => {
  it('returns ONLY the requested order', async () => {
    const s = seed(50)
    const { status, body } = await get(`?orderId=${s.target}`)
    expect(status).toBe(200)
    expect(body.orders?.map((o) => o.id)).toEqual([s.target])
  })

  it('does not run the full restaurant order-list query: exactly one order row is loaded', async () => {
    const s = seed(50)
    await get(`?orderId=${s.target}`)
    expect(orderRowsLoaded()).toBe(1)
    // And no paginated list read: the list path's `.range()` pagination never runs.
    const ordersCalls = mockQueries.filter((q) => q.table === 'orders').flatMap((q) => q.calls.map(([m]) => m))
    expect(ordersCalls).not.toContain('range')
  })

  it('projections and financials are read for the requested order and no other', async () => {
    const s = seed(50)
    await get(`?orderId=${s.target}`)
    const ids = orderIdsEnriched()
    expect([...ids]).toEqual([s.target])
  })

  it('does NOT run the restaurant-wide stale-order sweep', async () => {
    const s = seed(5)
    await get(`?orderId=${s.target}`)
    expect(mockSweep).not.toHaveBeenCalled()
  })

  it('SCALING: the work is the same for 30 live orders and for 3,000', async () => {
    const measure = async (bulk: number) => {
      const s = seed(bulk)
      mockQueries = []
      const { body } = await get(`?orderId=${s.target}`)
      expect(body.orders?.map((o) => o.id)).toEqual([s.target])
      return { rows: orderRowsLoaded(), ids: orderIdsEnriched().size, queries: mockQueries.length }
    }
    const small = await measure(30)
    const large = await measure(3000)
    expect(large).toEqual(small)
    expect(large.rows).toBe(1)
    expect(large.ids).toBe(1)
  })

  it('BEFORE/AFTER on the same 3,000-order restaurant: the list loads them all, the single path loads one', async () => {
    const s = seed(3000)
    await get('')
    const listRows = orderRowsLoaded()
    const listIds = orderIdsEnriched().size
    mockQueries = []
    await get(`?orderId=${s.target}`)
    // The list is what the old getOrder() fetched: every live order (3,000 bulk + target + untabbed).
    expect(listRows).toBe(3002)
    expect(listIds).toBe(3002)
    expect(orderRowsLoaded()).toBe(1)
    expect(orderIdsEnriched().size).toBe(1)
  })
})

describe('single-order path: same answer the old client-side find gave', () => {
  it('the single-order row is field-for-field the list row for the same order (tab order, voided line, card sale)', async () => {
    const s = seed(20)
    const list = await get('')
    const fromList = list.body.orders!.find((o) => o.id === s.target)
    const single = await get(`?orderId=${s.target}`)
    expect(single.body.orders).toHaveLength(1)
    expect(single.body.orders![0]).toEqual(fromList)
    // The enrichment is really there, not two equally empty rows.
    expect(fromList).toMatchObject({
      payment_status_derived: expect.any(String),
      financials: expect.objectContaining({ live_cents: 22000, voided_cents: 50000 }),
    })
  })

  it('a NON-tab order resolves the same way', async () => {
    const s = seed(20)
    const fromList = (await get('')).body.orders!.find((o) => o.id === s.untabbed)
    const single = await get(`?orderId=${s.untabbed}`)
    expect(single.body.orders).toEqual([fromList])
  })
})

describe('single-order path: isolation and not-found', () => {
  it("cannot retrieve another restaurant's order: answers exactly like a nonexistent one", async () => {
    const s = seed(5)
    const foreign = await get(`?orderId=${s.foreign}`)
    const missing = await get(`?orderId=${uuid('0000abcd', 99)}`)
    expect(foreign).toEqual({ status: 200, body: { orders: [] } })
    // Indistinguishable from a missing id, so the response says nothing about other venues.
    expect(foreign).toEqual(missing)
  })

  it('a nonexistent order answers 200 with no orders -- the shape the terminal already reads as "Order not found"', async () => {
    seed(5)
    const res = await get(`?orderId=${uuid('0000abcd', 42)}`)
    expect(res).toEqual({ status: 200, body: { orders: [] } })
  })

  it('an order outside the live-status set is not returned (the list never offered it either)', async () => {
    const s = seed(5)
    const res = await get(`?orderId=${s.cancelled}`)
    expect(res.body.orders).toEqual([])
  })

  it.each([
    ['not a uuid', 'abc'],
    ['PostgREST grammar', 'x,restaurant_id.neq.0)'],
    ['empty', ''],
  ])('a malformed orderId (%s) is refused with 400 and reads nothing', async (_label, raw) => {
    seed(5)
    const res = await get(`?orderId=${encodeURIComponent(raw)}`)
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_ORDER_ID')
    expect(mockQueries.filter((q) => q.table === 'orders')).toHaveLength(0)
  })
})

describe('single-order path: the permission gate still applies', () => {
  it('a terminal without orders:read gets 403 for a single order, and nothing is read', async () => {
    const s = seed(5)
    mockPermissions = ['orders:update']
    const res = await get(`?orderId=${s.target}`)
    expect(res.status).toBe(403)
    expect(res.body.orders).toBeUndefined()
    expect(mockQueries.filter((q) => q.table === 'orders')).toHaveLength(0)
  })
})

describe('list path (no orderId): unchanged', () => {
  it('returns every live order of this restaurant, newest first, and nothing else', async () => {
    const s = seed(30)
    const { status, body } = await get('')
    expect(status).toBe(200)
    const ids = body.orders!.map((o) => o.id)
    expect(ids).toHaveLength(32)
    expect(ids).toContain(s.target)
    expect(ids).toContain(s.untabbed)
    expect(ids).not.toContain(s.cancelled)
    expect(ids).not.toContain(s.foreign)
    const placed = body.orders!.map((o) => String(o.placed_at))
    expect([...placed].sort().reverse()).toEqual(placed)
  })

  it('still runs the stale-order sweep, once, for this restaurant', async () => {
    seed(5)
    await get('')
    expect(mockSweep).toHaveBeenCalledTimes(1)
    expect(mockSweep.mock.calls[0][1]).toEqual({ restaurantId: RESTAURANT, verifyWithFinatic: false })
  })

  it('still enriches every row (payment_status_derived, refunded_amount, financials)', async () => {
    const s = seed(5)
    const { body } = await get('')
    for (const o of body.orders!) {
      expect(o).toHaveProperty('payment_status_derived')
      expect(o).toHaveProperty('refunded_amount')
      expect(o).toHaveProperty('financials')
    }
    expect(body.orders!.find((o) => o.id === s.target)!.payment_status_derived).not.toBeNull()
  })
})
