/**
 * SETTLEMENT_SET_NOT_CLAIMABLE names WHY each order is refused (Sprint 2026-09-29, F-TERMPAY).
 *
 * The 409 already listed the refused orders with their raw payment_status/status pair. The terminal
 * has to turn that into a sentence a waiter can act on ("already paid" vs "cancelled" vs "held for
 * review"), and re-deriving the classification on the device would be a second copy of the rule.
 * So the route states it: `not_claimable: [{ order_id, order_number, reason }]`, additive -- the
 * existing `orders` array is unchanged for a fielded build.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'

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

beforeEach(() => {
  mockIntentCalls.length = 0
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

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

type NotClaimable = { order_id: string; order_number: number | null; reason: string }

function seed(siblings: Array<Record<string, unknown>>) {
  const f = new AmendFixture('0000cccc-0000-4000-8000-000000000041')
  const lead = f.place([{ name: 'Burger', quantity: 1, total: 220 }], { order_number: 10 })
  const others = siblings.map((o, i) =>
    f.place([{ name: `Dish ${i}`, quantity: 1, total: 100 }], { order_number: 11 + i, ...o }),
  )
  mockDb = new InMemoryDb({
    orders: f.orders.map((o) => ({ ...o, restaurant_id: RESTAURANT, pending_settlement_id: null })),
    order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
  })
  return { lead: lead.id, others: others.map((o) => o.id) }
}

describe('SETTLEMENT_SET_NOT_CLAIMABLE carries a typed reason per refused order', () => {
  it.each([
    ['paid', { payment_status: 'paid', status: 'completed' }],
    ['cancelled', { payment_status: 'cancelled', status: 'cancelled' }],
    ['cancelled', { payment_status: 'pending', status: 'cancelled' }],
    ['held', { payment_status: 'amount_mismatch_hold' }],
    ['held', { payment_status: 'verification_unavailable_hold' }],
  ])('reason %s for %j', async (reason, overrides) => {
    const { lead, others } = seed([overrides])
    const { status, body } = await prepare(lead, [lead, ...others])
    expect(status).toBe(409)
    expect(body.code).toBe('SETTLEMENT_SET_NOT_CLAIMABLE')
    expect(body.not_claimable).toEqual([{ order_id: others[0], order_number: 11, reason }])
    // The existing field is unchanged for older terminals.
    expect((body.orders as Array<{ order_id: string }>).map((o) => o.order_id)).toEqual([others[0]])
    expect(mockIntentCalls).toHaveLength(0)
  })

  it('a mixed set names only the refused orders, each with its own reason', async () => {
    const { lead, others } = seed([
      {},
      { payment_status: 'paid', status: 'completed' },
      { payment_status: 'cancelled', status: 'cancelled' },
      { payment_status: 'amount_mismatch_hold' },
    ])
    const { status, body } = await prepare(lead, [lead, ...others])
    expect(status).toBe(409)
    const nc = body.not_claimable as NotClaimable[]
    expect(nc.map((o) => [o.order_id, o.order_number, o.reason])).toEqual([
      [others[1], 12, 'paid'],
      [others[2], 13, 'cancelled'],
      [others[3], 14, 'held'],
    ])
    expect(nc.map((o) => o.order_id)).not.toContain(others[0])
    expect(nc.map((o) => o.order_id)).not.toContain(lead)
    expect(mockIntentCalls).toHaveLength(0)
  })

  it('control: an all-claimable set is charged and carries no not_claimable', async () => {
    const { lead, others } = seed([{}])
    const { status, body } = await prepare(lead, [lead, ...others])
    expect(status).toBe(200)
    expect(body.chargeCents).toBe(32000)
    expect(body.not_claimable).toBeUndefined()
  })
})
