/**
 * POST /api/terminal/orders/[orderId]/payment -- a card success, end to end: round trips and the
 * final state (perf/latency-sprint 2026-10-01, Phase 4).
 *
 * The REAL route, markOrderPaidConfirmed, receipt issuer, tab financials and tab-state writes run
 * against the in-memory store; only auth is replaced. Every query, single-row read and rpc costs
 * DELAY_MS and is recorded, so the suite measures the sequential depth a P5 waits for -- and pins
 * every row the success writes, so a faster route cannot be a different route.
 *
 * Production (2026-09-30): p50 2.9 s.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER = '0000aaaa-0000-4000-8000-000000000601'
const SIBLING = '0000aaaa-0000-4000-8000-000000000602'
const TAB = '0000cccc-0000-4000-8000-000000000601'
const DELAY_MS = 8

type Trip = { table: string; start: number; end: number }
let mockDb: InMemoryDb
let mockTrips: Trip[] = []
/** A query on this table THROWS (rather than returning an error) once its round trip completes. */
let mockThrowOn: string | null = null

async function mockTrip<T>(table: string, then: () => T): Promise<T> {
  const start = performance.now()
  await new Promise((r) => setTimeout(r, DELAY_MS))
  mockTrips.push({ table, start, end: performance.now() })
  return then()
}

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    permissions: ['orders:update'],
  }),
  // Live: one read of the terminal row.
  validateTerminalRecord: async () => mockTrip('restaurant_terminals', () => undefined),
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const real = mockDb.client()
    return {
      ...real,
      from: (table: string) => mockRecorded(real.from(table), table),
      rpc: (name: string, args: unknown) => mockTrip(`rpc:${name}`, () => real.rpc(name, args)),
    }
  },
}))

function mockRecorded(target: any, table: string): any {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') {
        return (ok?: (v: any) => unknown, err?: (e: unknown) => unknown) =>
          mockTrip(table, () => {
            // `await` drives a thenable through its reject callback: rejecting the RETURNED promise
            // instead leaves the awaiter hanging forever (caught 2026-10-01 as a 15 s timeout).
            if (mockThrowOn === table) {
              const e = new Error(`${table} THREW (test)`)
              if (err) return err(e)
              throw e
            }
            return t.then(ok, err)
          })
      }
      const value = t[prop]
      if (typeof value !== 'function') return value
      // single()/maybeSingle() EXECUTE the query in the fake: a round trip of their own.
      if (prop === 'single' || prop === 'maybeSingle') return () => mockTrip(table, () => value.apply(t))
      return (...args: unknown[]) => {
        const out = value.apply(t, args)
        return out === t ? mockRecorded(t, table) : out
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

function order(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    restaurant_id: RESTAURANT,
    tab_id: TAB,
    status: 'preparing',
    total: 85.5,
    subtotal: 85.5,
    tax: 0,
    items: [{ name: 'Burger', quantity: 1, price: 85.5, total: 85.5 }],
    payment_status: 'pending',
    paycloud_merchant_order_no: 'FT17000000000000601',
    pending_charge_cents: 8550,
    pending_tip_cents: 0,
    payment_reference: null,
    tab_settlement_for_tab_id: null,
    settled_charge_cents: null,
    channel: 'pos',
    ...over,
  }
}

function seed(tabbed: boolean) {
  mockDb = new InMemoryDb(
    {
      restaurants: [{ id: RESTAURANT, name: 'Riviera', address: 'Windhoek', currency: 'NAD' }],
      restaurant_billing_profiles: [],
      orders: tabbed
        ? [order(ORDER), order(SIBLING, { total: 40, items: [{ name: 'Fries', quantity: 1, price: 40, total: 40 }], pending_charge_cents: null })]
        : [order(ORDER, { tab_id: null })],
      tabs: tabbed
        ? [{ id: TAB, restaurant_id: RESTAURANT, status: 'ready_to_pay', total: 125.5, ready_to_pay_at: '2026-10-01T10:00:00Z', payment_preference: 'card', settled_at: null }]
        : [],
      order_lines: [],
      order_line_allocations: [],
      order_line_allocation_settlements: [],
      payment_events: [],
      payment_tips: [],
      non_gateway_payment_events: [],
      audit_logs: [],
      receipt_documents: [],
    },
    {
      receipt_documents: {
        defaults: { version: 1, status: 'issued', document_type: 'SALE_RECEIPT', issued_at: '2026-10-01T10:00:05Z' },
        unique: [['order_id', 'document_type', 'version']],
      },
    },
  )
}

async function pay() {
  const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
  mockTrips = []
  const res = await POST(
    new NextRequest(`http://localhost/api/terminal/orders/${ORDER}/payment`, {
      method: 'POST',
      body: JSON.stringify({ status: 'success', paymentMethod: 'card', amount: 85.5, reference: 'FT-REF-601' }),
    }),
    { params: Promise.resolve({ orderId: ORDER }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, any>, depth: sequentialDepth(mockTrips), trips: mockTrips.length }
}

const row = (table: string, id: string) => mockDb.rows(table).find((r) => r.id === id)!

beforeEach(() => {
  mockThrowOn = null
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('a card success on a tab', () => {
  it('LATENCY + STATE: the order is paid, audited, receipted; the tab total, flags and status are right', async () => {
    seed(true)
    const r = await pay()
    console.info(`[latency] payment (tab of 2): ${r.trips} trips, depth ${r.depth}`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ success: true, canClose: false })
    expect(row('orders', ORDER)).toMatchObject({ payment_status: 'paid', status: 'completed', payment_reference: 'FT-REF-601' })
    expect(mockDb.rows('audit_logs').filter((a) => a.action === 'payment.completed')).toHaveLength(1)
    expect(mockDb.rows('receipt_documents')).toHaveLength(1)
    // The sibling still owes N$40: the total says so, and the ready-to-pay record survives (#287).
    expect(row('tabs', TAB)).toMatchObject({ total: 40, status: 'open', ready_to_pay_at: '2026-10-01T10:00:00Z' })
    // MEASURED at 682a2b2e with this harness (scripts/perf/measure-at-base.mjs): depth 19 -> 10.
    expect(r.depth).toBeLessThanOrEqual(10)
    // 21 -> 20: the tab's orders are no longer read a second time for canClose.
    expect(r.trips).toBeLessThanOrEqual(20)
  })

  it('the last order on the tab: canClose true, flags cleared, tab reopened at a zero total', async () => {
    seed(true)
    row('orders', SIBLING).payment_status = 'paid'
    const r = await pay()
    console.info(`[latency] payment (last order on the tab, flags cleared): ${r.trips} trips, depth ${r.depth}`)
    expect(r.status).toBe(200)
    expect(r.body.canClose).toBe(true)
    expect(row('tabs', TAB)).toMatchObject({ total: 0, status: 'open', ready_to_pay_at: null, payment_preference: null })
    // The flag clear and the reopen go out together: serial, this path is one round trip deeper.
    expect(r.depth).toBeLessThanOrEqual(10)
  })

  it('a closed-out tab is NOT reopened (the resurrection guard), and its flags are still cleared', async () => {
    seed(true)
    row('orders', SIBLING).payment_status = 'paid'
    Object.assign(row('tabs', TAB), { status: 'settled', settled_at: '2026-10-01T10:05:00Z' })
    const r = await pay()
    expect(r.status).toBe(200)
    expect(row('tabs', TAB)).toMatchObject({ status: 'settled', ready_to_pay_at: null })
  })
})

describe('a step after the claim that THROWS', () => {
  it('still fails the request exactly as before, and the order stays paid', async () => {
    seed(false)
    mockThrowOn = 'audit_logs'
    const r = await pay()
    // The route's outer catch, unchanged. (The receipt is now issued alongside the audit, so it can
    // land even though the audit threw -- for an order whose claim had already committed.)
    expect(r.status).toBe(401)
    expect(row('orders', ORDER).payment_status).toBe('paid')
  })
})

describe('a walk-up card success (no tab)', () => {
  it('LATENCY: paid, audited, receipted', async () => {
    seed(false)
    const r = await pay()
    console.info(`[latency] payment (walk-up): ${r.trips} trips, depth ${r.depth}`)
    expect(r.status).toBe(200)
    expect(row('orders', ORDER).payment_status).toBe('paid')
    expect(mockDb.rows('receipt_documents')).toHaveLength(1)
    expect(r.depth).toBeLessThanOrEqual(8)
  })
})
