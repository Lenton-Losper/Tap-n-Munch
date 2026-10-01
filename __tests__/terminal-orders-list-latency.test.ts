/**
 * GET /api/terminal/orders -- how many database calls, and how many of them one after another.
 *
 * PRODUCTION BASELINE (2026-10-01 audit): the worker runs in Johannesburg/Windhoek and Supabase in
 * Ireland, so every SEQUENTIAL database call costs ~200 ms while the queries themselves execute in
 * <1 ms. At FNB's size (4,675 live orders) the list measured p50 11.2 s / max 39.3 s.
 *
 * This suite reproduces that physics: every query against the in-memory PostgREST fake resolves
 * only after DELAY_MS, and the suite measures
 *   calls  -- total database calls the request made
 *   depth  -- how many of those calls stood strictly one behind another
 * at FNB's real size. Depth x 200 ms is what the P5 waits for.
 *
 * Correctness of WHAT is returned is pinned here too (every live order of this restaurant, newest
 * first, enriched), and in terminal-orders-list-financials / terminal-orders-single-order.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'

const RESTAURANT = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const OTHER = 'ed8bda2b-beb0-4da7-9531-5b597344e6d5'
const DELAY_MS = 8

let mockDb: InMemoryDb
let mockCalls = 0
/** [start, end] of every simulated round trip, for the sequential-depth measurement. */
let mockSpans: Array<[number, number]> = []
/**
 * A Workers invocation holds at most SIX simultaneous open connections; further requests queue
 * until one closes. Modelled here, so fan-out past six shows up as depth instead of looking free.
 */
const MAX_OPEN = 6
let mockOpen = 0
const mockQueue: Array<() => void> = []
async function mockTrip<T>(then: () => T): Promise<T> {
  mockCalls++
  if (mockOpen >= MAX_OPEN) await new Promise<void>((r) => mockQueue.push(r))
  mockOpen++
  const start = performance.now()
  await new Promise((r) => setTimeout(r, DELAY_MS))
  mockSpans.push([start, performance.now()])
  mockOpen--
  mockQueue.shift()?.()
  return then()
}
let mockSweepCancels: string[] = []
const mockSweep = jest.fn()

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'b161c758-582d-4dfa-839a-9fa35c492a49',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  // The real check is one query; model it as one delayed call.
  validateTerminalRecord: async () => {
    await mockTrip(() => undefined)
  },
}))
jest.mock('@/lib/supabase/restaurants', () => ({ resolveOrderRestaurantScope: async () => null }))
jest.mock('@/lib/order-routing', () => ({ enrichOrderItemsWithRouteTo: async () => [] }))
jest.mock('@/lib/orders/check-stock-sufficiency', () => ({ checkStockSufficiency: async () => ({ ok: true }) }))
jest.mock('@/lib/orders/create-order', () => ({ createOrder: async () => null }))
jest.mock('@/lib/orders/auto-cancel-stale-pos-orders', () => ({
  // Steady state in production: one candidate scan. Modelled as one delayed call that "cancels"
  // whatever the test says, by flipping those orders to cancelled -- as the real sweep would.
  autoCancelStalePosOrders: async (...args: unknown[]) => {
    mockSweep(...args)
    await mockTrip(() => undefined) // candidate read
    // A run that cancels writes too: the flip lands one round trip after the read, as it does live.
    if (mockSweepCancels.length > 0) await mockTrip(() => undefined)
    for (const o of mockDb.rows('orders')) if (mockSweepCancels.includes(String(o.id))) o.status = 'cancelled'
    return { cancelledIds: [...mockSweepCancels], cancelledCount: mockSweepCancels.length }
  },
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const real = mockDb.client()
    return {
      ...real,
      from(table: string) {
        return mockDelayed(real.from(table))
      },
    }
  },
}))

/** Every await on a query costs one DELAY_MS round trip and counts as one call. */
function mockDelayed(target: any): any {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') {
        return (ok?: (v: any) => unknown, err?: (e: unknown) => unknown) => mockTrip(() => t.then(ok, err))
      }
      const value = t[prop]
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const out = value.apply(t, args)
        if (out === t) return mockDelayed(t)
        if (out && typeof out.then === 'function') return mockTrip(() => out)
        return out
      }
    },
  })
}

function uuid(n: number, prefix = '0000ffff') {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** FNB's real shape on 2026-10-01: 4,543 completed + 131 pending + 1 preparing; ~26% card-paid. */
function seedFnbScale() {
  const orders: Record<string, unknown>[] = []
  const events: Record<string, unknown>[] = []
  const lines: Record<string, unknown>[] = []
  const statusFor = (i: number) => (i < 131 ? 'pending' : i === 131 ? 'preparing' : 'completed')
  for (let i = 0; i < 4675; i++) {
    const id = uuid(i + 1)
    const status = statusFor(i)
    orders.push({
      id,
      restaurant_id: RESTAURANT,
      status,
      payment_status: status === 'completed' ? 'paid' : 'pending',
      total: 45,
      tab_id: null,
      placed_at: new Date(Date.UTC(2026, 5, 26) + i * 60_000).toISOString(),
    })
    if (i % 4 === 0 && status === 'completed') {
      events.push({
        id: uuid(i + 1, '0000eeee'),
        restaurant_id: RESTAURANT,
        event_type: 'sale',
        business_order_no: `FT${i}`,
        amount: 45,
        currency: 'NAD',
        order_ids: [id],
        created_at: new Date(Date.UTC(2026, 5, 26) + i * 60_000 + 30_000).toISOString(),
      })
    }
    if (i % 10 === 0) lines.push({ id: uuid(i + 1, '0000dddd'), order_id: id, restaurant_id: RESTAURANT, total_cents: 4500, is_voided: false, voided_at: null, kitchen_state: 'done', source_item_index: 0, quantity: 1 })
  }
  // Another venue's orders: must never be listed, never enriched.
  for (let i = 0; i < 50; i++) orders.push({ id: uuid(i + 1, '0000aaaa'), restaurant_id: OTHER, status: 'completed', payment_status: 'paid', total: 9, tab_id: null, placed_at: new Date(Date.UTC(2026, 8, 1) + i * 1000).toISOString() })
  mockDb = new InMemoryDb({
    orders,
    payment_events: events,
    order_lines: lines,
    order_line_allocations: [],
    order_line_allocation_settlements: [],
  })
}

/**
 * Sequential depth = the most round trips that stood strictly one after another (greedy maximum set
 * of non-overlapping spans). Calls fired together overlap and count once; the fake's own CPU time
 * cannot inflate it, unlike elapsed / DELAY_MS.
 */
function sequentialDepth(spans: Array<[number, number]>): number {
  let depth = 0
  let lastEnd = -Infinity
  for (const [s, e] of [...spans].sort((a, b) => a[1] - b[1])) {
    if (s >= lastEnd) {
      depth++
      lastEnd = e
    }
  }
  return depth
}

async function timedList(query = ''): Promise<{ status: number; orders: Array<Record<string, any>>; calls: number; depth: number; body: any }> {
  const { GET } = await import('@/app/api/terminal/orders/route')
  mockCalls = 0
  mockSpans = []
  const res = await GET(new Request(`http://localhost/api/terminal/orders${query}`))
  const body = await res.json()
  return { status: res.status, orders: body.orders ?? [], calls: mockCalls, depth: sequentialDepth(mockSpans), body }
}

beforeAll(() => seedFnbScale())
beforeEach(() => {
  mockSweepCancels = []
  mockSweep.mockClear()
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('FNB scale (4,675 live orders): what an existing P5 (no parameters) gets', () => {
  jest.setTimeout(60_000)

  it('LATENCY: the sequential depth is bounded -- not one call behind another per batch of orders', async () => {
    const r = await timedList('')
    // Printed so the before/after numbers are on record in the test output.
    console.info(`[latency] list: ${r.orders.length} orders, ${r.calls} DB calls, sequential depth ~${r.depth}`)
    expect(r.status).toBe(200)
    expect(r.orders).toHaveLength(4675)
    // MEASURED at 682a2b2e with this harness: 131 calls, depth 84 (5 pages, 24 sales chunks, 24
    // financials batches... one after another). Each unit is one worker->Ireland round trip.
    // After: 133 calls, depth 25. THE FLOOR IS THE CONNECTION CAP, not the code: 133 calls through
    // six connections is >= 23 waves, plus auth, sweep and page 0 in front. Going lower means making
    // fewer calls (the bounded ?scope= views below: depth ~4), not more parallelism.
    expect(r.depth).toBeLessThanOrEqual(28)
  })

  it('no per-order database calls: the call count grows by batch, never by order', async () => {
    const r = await timedList('')
    // 4,675 orders -> at most a few hundred calls (pages + 200-order chunks), far below one per order.
    expect(r.calls).toBeLessThan(200)
  })

  it('returns exactly this restaurant\'s live orders, newest first, each enriched', async () => {
    const r = await timedList('')
    // Equivalence evidence: scripts/compare-terminal-orders-list.mjs runs this test on the
    // 682a2b2e sources and on these, with LIST_DUMP set, and requires byte-identical bodies.
    if (process.env.LIST_DUMP) require('node:fs').writeFileSync(process.env.LIST_DUMP, JSON.stringify(r.body))
    expect(r.orders.every((o) => o.restaurant_id === RESTAURANT)).toBe(true)
    const placed = r.orders.map((o) => String(o.placed_at))
    expect([...placed].sort().reverse()).toEqual(placed)
    expect(r.orders.every((o) => 'payment_status_derived' in o && 'refunded_amount' in o)).toBe(true)
    // What the order card and the refund entry point read: the card-paid order (i = 132, a sale row
    // in the fixture) carries its derived payment status, refunded amount and live money figures.
    const paid = r.orders.find((o) => o.id === uuid(133))
    expect(paid).toMatchObject({
      status: 'completed',
      payment_status_derived: 'paid',
      refunded_amount: 0,
    })
    const unpaid = r.orders.find((o) => o.id === uuid(1))
    expect(unpaid).toMatchObject({ status: 'pending', payment_status_derived: null, refunded_amount: 0 })
    // Every order's financials are present (a batch read fails soft to ABSENT, never to zero).
    expect(r.orders.every((o) => o.financials && typeof o.financials.live_cents === 'number')).toBe(true)
  })

  it('an order the stale-order sweep cancels during this request is NOT listed, and nothing else goes missing', async () => {
    // The two NEWEST orders, pending: they sit on page 0, which is what a sweep run concurrently
    // with the list read would race. (The sweep cancels and THEN writes, two trips, as it does live.)
    const victims = [uuid(4001, '0000abcd'), uuid(4002, '0000abcd')]
    for (const [k, id] of victims.entries()) {
      mockDb.rows('orders').push({ id, restaurant_id: RESTAURANT, status: 'pending', payment_status: 'pending', total: 9, tab_id: null, placed_at: `2026-09-30T23:5${k}:00.000Z` })
    }
    mockSweepCancels = victims
    try {
      const r = await timedList('')
      const ids = new Set(r.orders.map((o) => o.id))
      expect(ids.has(victims[0])).toBe(false)
      expect(ids.has(victims[1])).toBe(false)
      expect(r.orders).toHaveLength(4675)
      expect(ids.size).toBe(4675)
      expect(mockSweep).toHaveBeenCalledTimes(1)
      expect(mockSweep.mock.calls[0][1]).toEqual({ restaurantId: RESTAURANT, verifyWithFinatic: false })
    } finally {
      const rows = mockDb.rows('orders')
      for (let i = rows.length - 1; i >= 0; i--) if (victims.includes(String(rows[i].id))) rows.splice(i, 1)
    }
  })
})

describe('bounded views for terminals that ask for them (?scope=)', () => {
  jest.setTimeout(60_000)

  it('scope=active: only the orders the New / Preparing / Ready tabs show -- small and shallow', async () => {
    const r = await timedList('?scope=active')
    console.info(`[latency] scope=active: ${r.orders.length} orders, ${r.calls} DB calls, depth ~${r.depth}`)
    expect(r.status).toBe(200)
    expect(r.orders).toHaveLength(132)
    expect(r.orders.every((o) => ['pending', 'confirmed', 'preparing', 'ready'].includes(o.status))).toBe(true)
    expect(r.orders.every((o) => o.restaurant_id === RESTAURANT)).toBe(true)
    expect(r.depth).toBeLessThanOrEqual(8)
    expect(mockSweep).toHaveBeenCalledTimes(1)
  })

  it('scope=completed: one bounded page, newest first, with a cursor to the next', async () => {
    const first = await timedList('?scope=completed&limit=50')
    console.info(`[latency] scope=completed page: ${first.orders.length} orders, ${first.calls} DB calls, depth ~${first.depth}`)
    expect(first.status).toBe(200)
    expect(first.orders).toHaveLength(50)
    expect(first.orders.every((o) => o.status === 'completed' && o.restaurant_id === RESTAURANT)).toBe(true)
    expect(first.body.nextCursor).toBe(`${first.orders[49].placed_at}~${first.orders[49].id}`)
    expect(first.depth).toBeLessThanOrEqual(8)
    // History pages do not run the stale-order sweep: it only ever cancels non-completed orders.
    expect(mockSweep).not.toHaveBeenCalled()

    const second = await timedList(`?scope=completed&limit=50&cursor=${encodeURIComponent(first.body.nextCursor)}`)
    expect(second.orders).toHaveLength(50)
    const firstIds = new Set(first.orders.map((o) => o.id))
    expect(second.orders.some((o) => firstIds.has(o.id))).toBe(false)
    expect(String(second.orders[0].placed_at) < String(first.orders[49].placed_at)).toBe(true)
  })

  it('scope=completed: the last page has no cursor', async () => {
    const all = await timedList('?scope=completed&limit=200')
    let cursor = all.body.nextCursor
    let pages = 1
    let seen = all.orders.length
    while (cursor && pages < 40) {
      const page = await timedList(`?scope=completed&limit=200&cursor=${encodeURIComponent(cursor)}`)
      seen += page.orders.length
      cursor = page.body.nextCursor
      pages++
    }
    expect(seen).toBe(4543)
    expect(cursor).toBeNull()
  })

  it('scope=completed: orders sharing one placed_at across a page boundary are neither skipped nor repeated', async () => {
    // Ten completed orders stamped with the SAME instant, newer than everything else.
    const tie = '2026-09-30T12:00:00.000Z'
    const tied = Array.from({ length: 10 }, (_, i) => uuid(i + 1, '0000cccc'))
    for (const id of tied) mockDb.rows('orders').push({ id, restaurant_id: RESTAURANT, status: 'completed', payment_status: 'paid', total: 1, tab_id: null, placed_at: tie })
    try {
      const seen: string[] = []
      let cursor: string | null = null
      for (let i = 0; i < 4; i++) {
        const q = `?scope=completed&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        const page = await timedList(q)
        expect(page.status).toBe(200)
        seen.push(...page.orders.map((o) => String(o.id)))
        cursor = page.body.nextCursor
      }
      // 16 rows read in four pages of four: all ten tied orders (id-descending), then six older ones.
      expect(seen.slice(0, 10)).toEqual([...tied].sort().reverse())
      expect(new Set(seen).size).toBe(16)
    } finally {
      const rows = mockDb.rows('orders')
      for (let i = rows.length - 1; i >= 0; i--) if (tied.includes(String(rows[i].id))) rows.splice(i, 1)
    }
  })

  it('scope=completed: a NULL placed_at is never a cursor, and never breaks the walk', async () => {
    const id = uuid(1, '0000bbbb')
    mockDb.rows('orders').push({ id, restaurant_id: RESTAURANT, status: 'completed', payment_status: 'paid', total: 1, tab_id: null, placed_at: null })
    try {
      const r = await timedList('?scope=completed&limit=200')
      expect(r.orders.some((o) => o.id === id)).toBe(false)
      expect(String(r.body.nextCursor)).not.toMatch(/^null~/)
    } finally {
      const rows = mockDb.rows('orders')
      rows.splice(rows.findIndex((o) => o.id === id), 1)
    }
  })

  it("isolation: another restaurant's orders are never on any scope", async () => {
    for (const q of ['', '?scope=active', '?scope=completed&limit=200']) {
      const r = await timedList(q)
      expect(r.orders.length).toBeGreaterThan(0)
      expect(r.orders.every((o) => o.restaurant_id === RESTAURANT)).toBe(true)
    }
  })

  it.each([
    ['unknown scope', '?scope=everything'],
    ['limit 0', '?scope=completed&limit=0'],
    ['limit over the cap', '?scope=completed&limit=201'],
    ['not a number', '?scope=completed&limit=abc'],
    ['bad cursor', '?scope=completed&cursor=yesterday'],
    ['cursor with a filter smuggled in', `?scope=completed&cursor=${encodeURIComponent('2026-09-30T12:00:00Z~x,id.neq.0')}`],
    ['cursor with a non-uuid id', '?scope=completed&cursor=2026-09-30T12:00:00Z~abc'],
    ['negative limit', '?scope=completed&limit=-5'],
    ['fractional limit', '?scope=completed&limit=2.5'],
  ])('refuses %s with 400 and reads nothing', async (_l, q) => {
    const r = await timedList(q)
    expect(r.status).toBe(400)
    expect(r.calls).toBeLessThanOrEqual(1) // the terminal-record check only
  })
})
