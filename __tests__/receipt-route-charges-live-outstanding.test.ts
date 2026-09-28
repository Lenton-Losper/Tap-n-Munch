/**
 * GUEST CHECKOUT (POST /api/payments/receipt) CHARGES WHAT IS STILL OWED, AND RECORDS IT.
 *
 * It summed orders.total, so a guest paying an amended tab was charged for the voided lines AND
 * the replacements. The charge must be the live outstanding figure, and it must be recorded per
 * order as pending_charge_cents -- the webhook compares the gateway's figure against that record
 * and falls back to the stale total without it, which would refuse a correct payment.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'

let mockDb: InMemoryDb
const mockCharges: Array<Record<string, unknown>> = []

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (id: string) => id,
}))
jest.mock('@/payments/paycloud', () => ({
  createPaymentRequest: async (args: Record<string, unknown>) => {
    mockCharges.push(args)
    return { paymentStatus: 'pending', requires3ds: false, checkoutUrl: null }
  },
}))
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ checkoutMerchantNo: 'M1', checkoutStoreNo: 'S1' }),
}))
jest.mock('@/lib/session-guard', () => ({
  requireSessionToken: async () => ({ error: null, tabId: 'tab-g' }),
  assertSessionMatchesResource: () => null,
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => mockDb.client(),
}))

function seed(f: AmendFixture) {
  mockDb = new InMemoryDb({
    orders: f.orders.map((o) => ({
      ...o,
      restaurant_id: 'rest-1',
      table_number: 5,
      is_closed: false,
      placed_at: '2026-09-28T12:00:00Z',
    })),
    order_lines: f.lines.map((l) => ({ ...l })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
  })
}

async function pay(orderIds: string[], amount: number) {
  const { POST } = await import('@/app/api/payments/receipt/route')
  const res = await POST(
    new Request('https://example.test/api/payments/receipt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ restaurantId: 'rest-1', tableNumber: 5, tabId: 'tab-g', orderIds, amount }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const order = (id: string) => mockDb.rows('orders').find((o) => String(o.id) === id)!

beforeEach(() => {
  mockCharges.length = 0
})

describe('guest checkout on an amended tab', () => {
  function amended() {
    const f = new AmendFixture('tab-g')
    const a = f.place([
      { name: 'Steak', quantity: 2, total: 400 },
      { name: 'Wine', quantity: 1, total: 100 },
    ])
    const r = f.amend(a.id, 'Steak', 1)!
    return { f, a, r }
  }

  it('charges the live outstanding figure (N$300), not Σ total (N$700)', async () => {
    const { f, a, r } = amended()
    seed(f)
    const { status } = await pay([a.id, r.id], 300)
    expect(status).toBe(201)
    expect(mockCharges[0].amount).toBe(300)
  })

  it('records the per-order expectation the webhook will verify against', async () => {
    const { f, a, r } = amended()
    seed(f)
    await pay([a.id, r.id], 300)
    expect(order(a.id).pending_charge_cents).toBe(10000)
    expect(order(r.id).pending_charge_cents).toBe(20000)
  })

  it('refuses the stale Σ total as the client amount', async () => {
    const { f, a, r } = amended()
    seed(f)
    const { status } = await pay([a.id, r.id], 700)
    expect(status).toBe(400)
    expect(mockCharges).toHaveLength(0)
  })

  it('leaves a fully voided order out of the checkout entirely', async () => {
    const f = new AmendFixture('tab-g')
    const a = f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    const b = f.place([{ name: 'Starter', quantity: 1, total: 60 }])
    f.amend(b.id, 'Starter', 0)
    seed(f)
    const { status } = await pay([a.id, b.id], 220)
    expect(status).toBe(201)
    expect(mockCharges[0].amount).toBe(220)
    expect(order(b.id).payment_status).toBe('pending')
    expect(order(b.id).pending_charge_cents ?? null).toBeNull()
    expect(order(b.id).payment_reference ?? null).toBeNull()
  })

  it('an unamended order is charged its total, exactly as before', async () => {
    const f = new AmendFixture('tab-g')
    const a = f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    seed(f)
    const { status } = await pay([a.id], 220)
    expect(status).toBe(201)
    expect(mockCharges[0].amount).toBe(220)
  })
})
