/**
 * POST /api/terminal/orders/[orderId]/prepare-payment -- how many round trips, which reads, and
 * that every refusal still wins in the same order (perf/latency-sprint 2026-10-01, Phase 3).
 *
 * Runs the REAL route, the REAL merchant-order helper and the REAL financial projection against the
 * in-memory PostgREST store. Every query costs DELAY_MS and is recorded with its table and kind
 * (read or write), so the suite can count ORDER READS and the sequential depth. Only auth, the
 * credentials lookup and the payment intent are replaced -- each as one (or two) delayed trips,
 * which is what they cost live.
 *
 * Production (2026-09-30): p50 1.8 s; the lead order was read twice, once by
 * ensureTerminalMerchantOrderNo and again by the route.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OTHER = 'ed8bda2b-beb0-4da7-9531-5b597344e6d5'
const STAFF = '5b0b0b0b-0000-4000-8000-000000000001'
const DELAY_MS = 8

let mockDb: InMemoryDb
type Trip = { table: string; kind: 'read' | 'write' | 'other'; start: number; end: number }
let mockTrips: Trip[] = []
let mockValidateFails = false
let mockCreds: 'ok' | 'missing' | 'transient' = 'ok'
/** When set, a READ of this table answers with a PostgREST error instead of rows. */
let mockFailReadOf: string | null = null
const mockIntentCalls: Array<Record<string, unknown>> = []

async function mockTrip<T>(table: string, kind: Trip['kind'], then: () => T): Promise<T> {
  const start = performance.now()
  await new Promise((r) => setTimeout(r, DELAY_MS))
  mockTrips.push({ table, kind, start, end: performance.now() })
  return then()
}

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () =>
    mockTrip('terminals', 'read', () => {
      if (mockValidateFails) throw new Response(JSON.stringify({ error: 'revoked' }), { status: 401 })
    }),
}))
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => {
  // The REAL error class: the route recognises it through finatic-credentials-error, not this module.
  const { MissingFinaticCredentialsError } = jest.requireActual('@/lib/payments/finatic-credentials-error')
  return {
    getRestaurantFinaticCredentials: async () =>
      mockTrip('credentials', 'read', () => {
        if (mockCreds === 'missing') throw new MissingFinaticCredentialsError('b161c758-582d-4dfa-839a-9fa35c492a49')
        if (mockCreds === 'transient') throw new Error('upstash timeout')
        return { merchantNo: 'M', storeNo: 'S' }
      }),
  }
})
jest.mock('@/lib/payments/payment-intents', () => ({
  // Live: a lookup by merchant order number, then an insert or update. Two dependent trips.
  ensureOrdersIntent: async (_s: unknown, params: Record<string, unknown>) => {
    await mockTrip('terminal_payment_intents', 'read', () => undefined)
    await mockTrip('terminal_payment_intents', 'write', () => undefined)
    mockIntentCalls.push(params)
    return { id: 'intent-1' }
  },
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const real = mockDb.client()
    return {
      ...real,
      from(table: string) {
        return mockRecorded(real.from(table), table, { kind: 'read' })
      },
    }
  },
}))

function mockRecorded(target: any, table: string, state: { kind: Trip['kind'] }): any {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') {
        return (ok?: (v: any) => unknown, err?: (e: unknown) => unknown) =>
          mockTrip(table, state.kind, () =>
            state.kind === 'read' && mockFailReadOf === table
              ? Promise.resolve({ data: null, error: { message: `${table} read refused (test)` } }).then(ok, err)
              : t.then(ok, err),
          )
      }
      const value = t[prop]
      if (typeof value !== 'function') return value
      // The fake's single()/maybeSingle() are async methods that EXECUTE the query -- a round trip
      // of their own. Unwrapped, single-row reads escape the delay, the record and the injection.
      if (prop === 'single' || prop === 'maybeSingle') {
        return () =>
          mockTrip(table, state.kind, () =>
            state.kind === 'read' && mockFailReadOf === table
              ? { data: null, error: { message: `${table} read refused (test)` } }
              : value.apply(t),
          )
      }
      return (...args: unknown[]) => {
        if (prop === 'update' || prop === 'insert' || prop === 'upsert' || prop === 'delete') state.kind = 'write'
        const out = value.apply(t, args)
        return out === t ? mockRecorded(t, table, state) : out
      }
    },
  })
}

function sequentialDepth(trips: Trip[]): number {
  let depth = 0
  let lastEnd = -Infinity
  for (const t of [...trips].sort((a, b) => a.end - b.end)) {
    if (t.start >= lastEnd) {
      depth++
      lastEnd = t.end
    }
  }
  return depth
}

const LEAD = '0000aaaa-0000-4000-8000-000000000001'
const SIB = '0000aaaa-0000-4000-8000-000000000002'
const TAB = '0000cccc-0000-4000-8000-000000000001'

function order(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    restaurant_id: RESTAURANT,
    tab_id: TAB,
    total: 45,
    items: [{ name: 'Burger', price: 45, quantity: 1 }],
    status: 'pending',
    payment_status: 'pending',
    tab_settlement_for_tab_id: null,
    settled_charge_cents: null,
    pending_settlement_id: null,
    pending_charge_cents: null,
    charge_basis: null,
    order_number: 7,
    paycloud_merchant_order_no: null,
    ...over,
  }
}

function seed(orders: Record<string, unknown>[]) {
  mockDb = new InMemoryDb({
    orders,
    order_lines: [],
    order_line_allocations: [],
    order_line_allocation_settlements: [],
    payment_events: [],
    restaurant_users: [{ restaurant_id: RESTAURANT, user_id: STAFF }],
    audit_logs: [],
  })
}

async function prepare(body: Record<string, unknown> = {}, orderId = LEAD) {
  const { POST } = await import('@/app/api/terminal/orders/[orderId]/prepare-payment/route')
  mockTrips = []
  const res = await POST(
    new NextRequest(`http://localhost/api/terminal/orders/${orderId}/prepare-payment`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orderId }) },
  )
  const trips = mockTrips
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
    depth: sequentialDepth(trips),
    orderReads: trips.filter((t) => t.table === 'orders' && t.kind === 'read').length,
    trips,
  }
}

const row = (id: string) => mockDb.rows('orders').find((o) => o.id === id)!

beforeEach(() => {
  mockValidateFails = false
  mockCreds = 'ok'
  mockFailReadOf = null
  mockIntentCalls.length = 0
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('round trips', () => {
  it('ORDERS ARE READ ONCE: a retry on an already-referenced order reads its orders a single time', async () => {
    seed([order(LEAD, { paycloud_merchant_order_no: 'FT17000000000001234' })])
    const r = await prepare()
    console.info(`[latency] prepare (retry, 1 order): order reads ${r.orderReads}, depth ${r.depth}, trips ${r.trips.length}`)
    expect(r.status).toBe(200)
    expect(r.body.merchantOrderNo).toBe('FT17000000000001234')
    expect(r.body.created).toBe(false)
    expect(r.orderReads).toBe(1)
  })

  it('first prepare of a two-order tab: one read of the set, then the mint, then the writes', async () => {
    seed([order(LEAD), order(SIB)])
    const r = await prepare({ order_ids: [SIB] })
    console.info(`[latency] prepare (first, 2 orders): order reads ${r.orderReads}, depth ${r.depth}, trips ${r.trips.length}`)
    expect(r.status).toBe(200)
    expect(r.body.created).toBe(true)
    expect(r.body.chargeCents).toBe(9000)
    // The mint's own compare-and-swap UPDATE...select is a write; the only orders READ is the set.
    expect(r.orderReads).toBe(1)
    expect(String(row(LEAD).paycloud_merchant_order_no)).toBe(r.body.merchantOrderNo)
    expect(row(LEAD).pending_charge_cents).toBe(4500)
    expect(row(SIB).pending_charge_cents).toBe(4500)
  })

  it('LATENCY: credentials and the terminal check, and the tip check and the order read, overlap', async () => {
    seed([order(LEAD, { paycloud_merchant_order_no: 'FT17000000000001234' })])
    const r = await prepare({ tip_cents: 500, tip_staff_user_id: STAFF })
    console.info(`[latency] prepare (retry, tipped): order reads ${r.orderReads}, depth ${r.depth}, trips ${r.trips.length}`)
    expect(r.status).toBe(200)
    expect(r.body.chargeCents).toBe(5000)
    // MEASURED with this harness: 682a2b2e depth 9, 2 order reads -> now depth 6, 1 order read.
    expect(r.depth).toBeLessThanOrEqual(6)
  })
})

describe('every refusal still happens, and in the same order', () => {
  it('a revoked terminal is refused before anything is written -- even when the venue has no card setup', async () => {
    seed([order(LEAD)])
    mockValidateFails = true
    mockCreds = 'missing'
    const r = await prepare()
    expect(r.status).toBe(401)
    expect(mockDb.rows('audit_logs')).toHaveLength(0)
    expect(row(LEAD).paycloud_merchant_order_no).toBeNull()
    expect(r.trips.some((t) => t.kind === 'write')).toBe(false)
  })

  it('no card setup: 400, audited, nothing minted', async () => {
    seed([order(LEAD)])
    mockCreds = 'missing'
    const r = await prepare()
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ allocated: false, merchantOrderNo: null })
    expect(mockDb.rows('audit_logs')).toHaveLength(1)
    expect(row(LEAD).paycloud_merchant_order_no).toBeNull()
  })

  it('credentials unreadable: 502, nothing minted, nothing audited', async () => {
    seed([order(LEAD)])
    mockCreds = 'transient'
    const r = await prepare()
    expect(r.status).toBe(502)
    expect(mockDb.rows('audit_logs')).toHaveLength(0)
    expect(row(LEAD).paycloud_merchant_order_no).toBeNull()
  })

  it('tip for someone who does not work here: 400 before anything is minted', async () => {
    seed([order(LEAD)])
    const r = await prepare({ tip_cents: 500, tip_staff_user_id: '5b0b0b0b-0000-4000-8000-0000000000ff' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('TIP_STAFF_NOT_A_MEMBER')
    expect(row(LEAD).paycloud_merchant_order_no).toBeNull()
    expect(r.trips.some((t) => t.kind === 'write')).toBe(false)
  })

  it('tip with no recipient named: 400 before any read', async () => {
    seed([order(LEAD)])
    const r = await prepare({ tip_cents: 500 })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('TIP_NEEDS_STAFF')
    expect(r.trips.some((t) => t.table === 'orders')).toBe(false)
  })

  it.each([
    ['paid', { payment_status: 'paid' }, 400, 'ALREADY_PAID'],
    ['cancelled', { payment_status: 'cancelled' }, 400, 'ORDER_CANCELLED'],
  ])('a %s lead: refused with the helper\'s own status and code, nothing minted or written', async (_l, over, status, code) => {
    seed([order(LEAD, over)])
    const r = await prepare()
    expect(r.status).toBe(status)
    expect(r.body.code).toBe(code)
    expect(r.trips.some((t) => t.kind === 'write')).toBe(false)
  })

  it("another venue's order: 404 Order not found, nothing written", async () => {
    seed([order(LEAD, { restaurant_id: OTHER })])
    const r = await prepare()
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('Order not found')
    expect(r.trips.some((t) => t.kind === 'write')).toBe(false)
  })

  it("a sibling from another venue: 503 ORDER_TOTAL_UNREADABLE (after the lead's reference, as before)", async () => {
    seed([order(LEAD), order(SIB, { restaurant_id: OTHER })])
    const r = await prepare({ order_ids: [SIB] })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('ORDER_TOTAL_UNREADABLE')
    expect(row(SIB).pending_charge_cents).toBeNull()
  })

  it('a paid sibling: 409 SETTLEMENT_SET_NOT_CLAIMABLE, no expectation written', async () => {
    seed([order(LEAD), order(SIB, { payment_status: 'paid' })])
    const r = await prepare({ order_ids: [SIB] })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('SETTLEMENT_SET_NOT_CLAIMABLE')
    expect(row(LEAD).pending_charge_cents).toBeNull()
  })

  it('the orders read fails: 500 "Failed to load order", nothing minted or written', async () => {
    seed([order(LEAD)])
    mockFailReadOf = 'orders'
    const r = await prepare()
    expect(r.status).toBe(500)
    expect(String(r.body.error)).toMatch(/^Failed to load order: orders read refused \(test\)$/)
    expect(r.trips.some((t) => t.kind === 'write')).toBe(false)
    expect(row(LEAD).paycloud_merchant_order_no).toBeNull()
  })
})

describe('idempotency', () => {
  it('a second prepare reuses the reference and the settlement id', async () => {
    seed([order(LEAD), order(SIB)])
    const first = await prepare({ order_ids: [SIB] })
    const settlement = row(LEAD).pending_settlement_id
    const second = await prepare({ order_ids: [SIB] })
    expect(second.status).toBe(200)
    expect(second.body.merchantOrderNo).toBe(first.body.merchantOrderNo)
    expect(second.body.created).toBe(false)
    expect(row(LEAD).pending_settlement_id).toBe(settlement)
    expect(row(SIB).pending_settlement_id).toBe(settlement)
  })
})
