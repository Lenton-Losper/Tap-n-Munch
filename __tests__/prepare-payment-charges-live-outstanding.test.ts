/**
 * PREPARE-PAYMENT CHARGES WHAT IS STILL OWED ON AN AMENDED TAB -- and nothing else changes.
 *
 * The route writes pending_charge_cents per order and the intent's amount. Every downstream gate
 * (settle_order_payment, verify-payment, the webhook, reconcile, the device callback) compares the
 * gateway's figure against those recorded values, so this is the ONE place the card charge for an
 * amended tab is decided. Before the switch it summed orders.total: Riviera #160's tab would have
 * been asked for N$1,945 PLUS the three replacements (N$2,685) against a real bill of N$1,205.
 *
 * Runs the REAL route against the in-memory PostgREST store; only auth, credentials and the
 * merchant-order mint are replaced.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture, RIVIERA_ITEMS } from './helpers/amend-fixture'
import { chargeableCentsFor } from '@/lib/payments/settled-cents'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

let mockDb: InMemoryDb
const mockIntentCalls: Array<Record<string, unknown>> = []

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'M', storeNo: 'S' }),
}))
jest.mock('@/lib/payments/terminal-merchant-order', () => ({
  ensureTerminalMerchantOrderNo: async () => ({ merchantOrderNo: 'FT1700000000000001', created: true }),
}))
jest.mock('@/lib/payments/payment-intents', () => ({
  ensureOrdersIntent: async (_s: unknown, params: Record<string, unknown>) => {
    mockIntentCalls.push(params)
    return { id: 'intent-1' }
  },
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => mockDb.client(),
}))

function seed(f: AmendFixture) {
  mockDb = new InMemoryDb({
    orders: f.orders.map((o) => ({ ...o, restaurant_id: RESTAURANT, pending_settlement_id: null })),
    order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
  })
}

async function prepare(orderId: string, orderIds: string[]) {
  const { POST } = await import('@/app/api/terminal/orders/[orderId]/prepare-payment/route')
  const res = await POST(
    new NextRequest(`http://localhost/api/terminal/orders/${orderId}/prepare-payment`, {
      method: 'POST',
      body: JSON.stringify({ order_ids: orderIds }),
    }),
    { params: Promise.resolve({ orderId }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const pendingOf = (id: string) =>
  mockDb.rows('orders').find((o) => String(o.id) === id)?.pending_charge_cents ?? null

beforeEach(() => {
  mockIntentCalls.length = 0
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('prepare-payment: the card charge for an amended tab is the live outstanding figure', () => {
  function rivieraTab() {
    const f = new AmendFixture('0000cccc-0000-4000-8000-000000000001')
    const original = f.place(RIVIERA_ITEMS, { id: '0000aaaa-0000-4000-8000-000000000160' })
    const r1 = f.amend(original.id, 'Wish You Were Here', 1)!
    const r2 = f.amend(original.id, 'Double Cheese Burger', 1)!
    const r3 = f.amend(original.id, 'Seared Salmon', 1)!
    return { f, ids: [original.id, r1.id, r2.id, r3.id] }
  }

  it('RIVIERA: charges N$1,205 (not N$2,685, not N$1,945) and records it per order', async () => {
    const { f, ids } = rivieraTab()
    seed(f)
    const { status, body } = await prepare(ids[0], ids)
    expect(status).toBe(200)
    expect(body.chargeCents).toBe(120500)
    expect(pendingOf(ids[0])).toBe(46500)
    expect(pendingOf(ids[1])).toBe(19000)
    expect(pendingOf(ids[2])).toBe(9000)
    expect(pendingOf(ids[3])).toBe(46000)
    // The intent carries the SAME figure over the SAME set -- invariant 4 and 5 hold downstream.
    expect(mockIntentCalls).toHaveLength(1)
    expect(mockIntentCalls[0].amountCents).toBe(120500)
    expect([...(mockIntentCalls[0].orderIds as string[])].sort()).toEqual([...ids].sort())
    // Σ pending_charge_cents == the intent amount == what the device is told to charge.
    const sumPending = ids.reduce((s, id) => s + Number(pendingOf(id)), 0)
    expect(sumPending).toBe(body.chargeCents)
  })

  it('an UNAMENDED tab is charged exactly what the pre-projection formula charged', async () => {
    const f = new AmendFixture('0000cccc-0000-4000-8000-000000000002')
    const a = f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    const b = f.place([{ name: 'Steak', quantity: 2, total: 500 }])
    seed(f)
    const legacy = [a, b].reduce((s, o) => s + chargeableCentsFor(o.total, 0), 0)
    const { status, body } = await prepare(a.id, [a.id, b.id])
    expect(status).toBe(200)
    expect(body.chargeCents).toBe(legacy)
    expect(body.chargeCents).toBe(72000)
    expect(pendingOf(a.id)).toBe(22000)
    expect(pendingOf(b.id)).toBe(50000)
    expect(body.excludedOrderIds).toEqual([])
  })

  it('a fully voided order on the tab is left OUT of the charge, the intent and the expectations', async () => {
    const f = new AmendFixture('0000cccc-0000-4000-8000-000000000003')
    const a = f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    const b = f.place([{ name: 'Starter', quantity: 1, total: 60 }])
    f.amend(b.id, 'Starter', 0)
    seed(f)
    const { status, body } = await prepare(a.id, [a.id, b.id])
    expect(status).toBe(200)
    expect(body.chargeCents).toBe(22000)
    expect(body.excludedOrderIds).toEqual([b.id])
    // Never written as 0: orders_pending_charge_sane requires NULL or > 0.
    expect(pendingOf(b.id)).toBeNull()
    expect(mockIntentCalls[0].orderIds).toEqual([a.id])
  })

  it('refuses when the ORDER IN THE URL owes nothing, before writing any expectation', async () => {
    const f = new AmendFixture('0000cccc-0000-4000-8000-000000000004')
    const a = f.place([{ name: 'Starter', quantity: 1, total: 60 }])
    const b = f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    f.amend(a.id, 'Starter', 0)
    seed(f)
    const { status, body } = await prepare(a.id, [a.id, b.id])
    expect(status).toBe(409)
    expect(body.code).toBe('ORDER_NOTHING_OWED')
    expect(pendingOf(a.id)).toBeNull()
    expect(pendingOf(b.id)).toBeNull()
    expect(mockIntentCalls).toHaveLength(0)
  })

  it('a single fully voided order is NOTHING_LEFT_TO_CHARGE, never a zero-value charge', async () => {
    const f = new AmendFixture('0000cccc-0000-4000-8000-000000000005')
    const a = f.place([{ name: 'Starter', quantity: 1, total: 60 }])
    f.amend(a.id, 'Starter', 0)
    seed(f)
    const { status, body } = await prepare(a.id, [a.id])
    expect(status).toBe(409)
    expect(body.code).toBe('NOTHING_LEFT_TO_CHARGE')
  })

  it('FAILS CLOSED when the lines cannot be read', async () => {
    const f = new AmendFixture('0000cccc-0000-4000-8000-000000000006')
    const a = f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    seed(f)
    const client = mockDb.client()
    const broken = {
      ...client,
      from(table: string) {
        if (table !== 'order_lines') return client.from(table)
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          in: () => b,
          order: () => b,
          range: async () => ({ data: null, error: { message: 'lines down' } }),
        })
        return b
      },
    }
    const server = jest.requireMock('@/lib/supabase/server') as { createServerSupabaseClient: () => unknown }
    const spy = jest.spyOn(server, 'createServerSupabaseClient').mockReturnValue(broken)
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const { status, body } = await prepare(a.id, [a.id])
    spy.mockRestore()
    expect(status).toBe(503)
    expect(body.code).toBe('SETTLED_TOTAL_UNREADABLE')
    expect(pendingOf(a.id)).toBeNull()
  })
})
