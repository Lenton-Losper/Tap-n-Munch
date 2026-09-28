/**
 * C2: GET /api/terminal/tabs/[tabId]/lines carries the financial projection, and its tab total is
 * the tab's LIVE value -- not the stale tabs.total cache, and not Σ orders.total.
 *
 * The terminal's table view renders the bill from this route. For Riviera #160 it showed N$1,945
 * after three reductions had voided N$1,480 and moved the surviving quantities onto replacement
 * orders on the same tab.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture, RIVIERA_ITEMS } from './helpers/amend-fixture'

const RESTAURANT = 'rest-1'
const TAB = '0000cccc-0000-4000-8000-000000000030'

let mockDb: InMemoryDb

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({ terminalId: 'term-1', restaurantId: 'rest-1', permissions: ['orders:read'] }),
  validateTerminalRecord: async () => ({ id: 'term-1', status: 'active' }),
}))
jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: true }),
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => mockDb.client(),
}))

function seed(f: AmendFixture, tabTotal = 9999) {
  mockDb = new InMemoryDb({
    tabs: [{ id: TAB, restaurant_id: RESTAURANT, table_number: 1, status: 'open', total: tabTotal, created_at: '2026-09-28T12:00:00Z' }],
    orders: f.orders.map((o) => ({ ...o, restaurant_id: RESTAURANT, placed_at: '2026-09-28T12:00:00Z' })),
    order_lines: f.lines.map((l, i) => ({
      ...l,
      restaurant_id: RESTAURANT,
      tab_id: TAB,
      name_snapshot: 'x',
      quantity: 1,
      created_at: `2026-09-28T12:00:${String(i).padStart(2, '0')}Z`,
    })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
  })
}

async function lines() {
  const { GET } = await import('@/app/api/terminal/tabs/[tabId]/lines/route')
  const res = await GET(new Request(`https://example.test/api/terminal/tabs/${TAB}/lines`), {
    params: Promise.resolve({ tabId: TAB }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

describe('C2: the lines route carries the projection', () => {
  it('RIVIERA: tab.total is the live N$1,205 and every order has its own figures', async () => {
    const f = new AmendFixture(TAB)
    const o = f.place(RIVIERA_ITEMS, { id: '0000aaaa-0000-4000-8000-000000000160' })
    const r1 = f.amend(o.id, 'Wish You Were Here', 1)!
    const r2 = f.amend(o.id, 'Double Cheese Burger', 1)!
    const r3 = f.amend(o.id, 'Seared Salmon', 1)!
    seed(f)
    const { status, body } = await lines()
    expect(status).toBe(200)
    expect(body.tab.total).toBe(1205)
    expect(body.financials.tab).toEqual({
      original_cents: 268500,
      voided_cents: 148000,
      live_cents: 120500,
      paid_cents: 0,
      outstanding_cents: 120500,
      overpaid_cents: 0,
    })
    expect(body.financials.orders[o.id]).toMatchObject({ original_cents: 194500, voided_cents: 148000, live_cents: 46500 })
    expect(body.financials.orders[r1.id]).toMatchObject({ live_cents: 19000 })
    expect(body.financials.orders[r2.id]).toMatchObject({ live_cents: 9000 })
    expect(body.financials.orders[r3.id]).toMatchObject({ live_cents: 46000 })
  })

  it('an order with NO lines is still in the financials (it owes its stored total)', async () => {
    const f = new AmendFixture(TAB)
    const withLines = f.place([{ name: 'A', quantity: 1, total: 50 }])
    seed(f)
    mockDb.rows('orders').push({
      id: '0000aaaa-0000-4000-8000-00000000fff1',
      restaurant_id: RESTAURANT,
      tab_id: TAB,
      total: 30,
      items: [{ name: 'Legacy', quantity: 1, total: 30 }],
      status: 'pending',
      payment_status: 'pending',
    })
    const { body } = await lines()
    expect(body.financials.orders[withLines.id].live_cents).toBe(5000)
    expect(body.financials.orders['0000aaaa-0000-4000-8000-00000000fff1'].outstanding_cents).toBe(3000)
    expect(body.financials.tab.outstanding_cents).toBe(8000)
    expect(body.tab.total).toBe(80)
  })

  it('a paid order voided afterwards reports the overpayment, never hides it', async () => {
    const f = new AmendFixture(TAB)
    const o = f.place(
      [
        { name: 'A', quantity: 1, total: 50 },
        { name: 'B', quantity: 1, total: 20 },
      ],
      { payment_status: 'paid', status: 'completed', settled_charge_cents: 7000 },
    )
    f.amend(o.id, 'B', 0)
    seed(f)
    const { body } = await lines()
    expect(body.financials.tab).toMatchObject({ live_cents: 5000, paid_cents: 7000, outstanding_cents: 0, overpaid_cents: 2000 })
  })
})
