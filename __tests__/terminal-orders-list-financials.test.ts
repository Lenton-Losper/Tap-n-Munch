/**
 * GET /api/terminal/orders carries each order's C1 projection (Sprint 2026-09-29, F-TERMPAY task 8).
 *
 * The terminal's order card showed `orders.total`, the stored ORIGINAL, which a void never rewrites.
 * Each listed order now carries `financials` in the C2 per-order wire shape. Batched (a fixed number
 * of reads per batch, never one per order) and fail-soft (a read failure omits the block; the list
 * still answers).
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

let mockDb: InMemoryDb
let mockFailTable: string | null = null
const mockFromCalls: string[] = []

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))
// The POST half of the route's module graph, stubbed so the GET can load without a browser client.
jest.mock('@/lib/supabase/restaurants', () => ({ resolveOrderRestaurantScope: async () => null }))
jest.mock('@/lib/order-routing', () => ({ enrichOrderItemsWithRouteTo: async () => [] }))
jest.mock('@/lib/orders/check-stock-sufficiency', () => ({ checkStockSufficiency: async () => ({ ok: true }) }))
jest.mock('@/lib/orders/create-order', () => ({ createOrder: async () => null }))
jest.mock('@/lib/orders/auto-cancel-stale-pos-orders', () => ({
  autoCancelStalePosOrders: async () => undefined,
}))
jest.mock('@/lib/payments/get-payment-projection', () => ({
  getPaymentProjections: async () => new Map(),
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const real = mockDb.client()
    return {
      ...real,
      from(table: string) {
        mockFromCalls.push(table)
        if (table === mockFailTable) {
          // Every chain method returns the same builder; awaiting it (or a range) yields an error.
          const failing: Record<string, unknown> = {}
          const result = { data: null, error: { message: `${table} is down` } }
          for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) failing[m] = () => failing
          failing.range = async () => result
          failing.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok)
          return failing
        }
        return real.from(table)
      },
    }
  },
}))

beforeEach(() => {
  mockFailTable = null
  mockFromCalls.length = 0
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

type Listed = { id: string; total: number; financials?: Record<string, number> }

async function list(): Promise<{ status: number; orders: Listed[] }> {
  const { GET } = await import('@/app/api/terminal/orders/route')
  const res = await GET(new Request('http://localhost/api/terminal/orders'))
  const body = (await res.json()) as { orders?: Listed[] }
  return { status: res.status, orders: body.orders ?? [] }
}

function seed(build: (f: AmendFixture) => void) {
  const f = new AmendFixture('0000cccc-0000-4000-8000-000000000051')
  build(f)
  mockDb = new InMemoryDb({
    orders: f.orders.map((o, i) => ({
      ...o,
      restaurant_id: RESTAURANT,
      placed_at: `2026-09-28T18:0${i}:00.000Z`,
    })),
    order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
  })
  return f
}

describe('each listed order carries its live figures', () => {
  it('an AMENDED order: live and outstanding exclude the voided line; original is the stored total', async () => {
    let amended = ''
    let plain = ''
    seed((f) => {
      amended = f.place([
        { name: 'Burger', quantity: 1, total: 220 },
        { name: 'Steak', quantity: 1, total: 500 },
      ]).id
      f.amend(amended, 'Steak', 0)
      plain = f.place([{ name: 'Soup', quantity: 1, total: 80 }]).id
    })
    const { status, orders } = await list()
    expect(status).toBe(200)

    const a = orders.find((o) => o.id === amended)!
    expect(a.total).toBe(720) // the stored original is still sent, unchanged
    expect(a.financials).toEqual({
      original_cents: 72000,
      voided_cents: 50000,
      live_cents: 22000,
      paid_cents: 0,
      outstanding_cents: 22000,
      overpaid_cents: 0,
    })

    const p = orders.find((o) => o.id === plain)!
    expect(p.financials?.live_cents).toBe(8000)
    expect(p.financials?.original_cents).toBe(8000)
  })

  it('a PAID order with a voided line owes nothing; its live value is still the post-void figure', async () => {
    let paid = ''
    seed((f) => {
      paid = f.place(
        [
          { name: 'Burger', quantity: 1, total: 220 },
          { name: 'Steak', quantity: 1, total: 500 },
        ],
        { payment_status: 'paid', status: 'completed', settled_charge_cents: 22000 },
      ).id
      f.amend(paid, 'Steak', 0)
    })
    const { orders } = await list()
    const o = orders.find((r) => r.id === paid)!
    expect(o.financials?.live_cents).toBe(22000)
    expect(o.financials?.outstanding_cents).toBe(0)
    expect(o.financials?.original_cents).toBe(72000)
  })

  it('batched: the lines are read once for the whole list, not once per order', async () => {
    seed((f) => {
      for (let i = 0; i < 5; i += 1) f.place([{ name: `Dish ${i}`, quantity: 1, total: 10 }])
    })
    const { orders } = await list()
    expect(orders).toHaveLength(5)
    expect(orders.every((o) => o.financials)).toBe(true)
    expect(mockFromCalls.filter((t) => t === 'order_lines')).toHaveLength(1)
  })

  it('FAIL-SOFT: lines unreadable -> the list still answers, with NO financials (never zeros)', async () => {
    seed((f) => {
      f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    })
    mockFailTable = 'order_lines'
    const { status, orders } = await list()
    expect(status).toBe(200)
    expect(orders).toHaveLength(1)
    expect(orders[0].total).toBe(220)
    expect('financials' in orders[0]).toBe(false)
  })

  it('FAIL-SOFT: the item ledger unreadable -> no financials either', async () => {
    seed((f) => {
      f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    })
    mockFailTable = 'order_line_allocations'
    const { status, orders } = await list()
    expect(status).toBe(200)
    expect('financials' in orders[0]).toBe(false)
  })
})
