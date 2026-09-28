/**
 * THE TAB SETTLE ROUTE ON AN AMENDED TAB: what it expects, what it records, when the table closes.
 *
 * Before the switch the route summed orders.total, so for Riviera #160 it expected N$1,945 plus the
 * three replacements and REFUSED the terminal's correct line-based N$1,205 (AMOUNT_MISMATCH) --
 * cash could not be taken for the real bill. It also left a pending order whose every line was
 * voided counted as debt, so the table could never close without paying for cancelled food.
 *
 * Runs the REAL route against the in-memory PostgREST store.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture, RIVIERA_ITEMS } from './helpers/amend-fixture'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB = '0000cccc-0000-4000-8000-000000000010'

let mockDb: InMemoryDb

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: async () => undefined,
}))
jest.mock('@/lib/tabs/settle-tab-state', () => ({
  clearReadyToPayAndReopenTab: async () => undefined,
}))
/**
 * The cash claim's `.or()` expression is not modelled by the in-memory store. Every order in these
 * fixtures is `pending`, so its `payment_status.in.(...)` half is the whole of it; anything else is
 * refused loudly rather than matched silently.
 */
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const client = mockDb.client()
    return {
      ...client,
      from(table: string) {
        const b = client.from(table) as unknown as Record<string, unknown> & {
          in: (c: string, v: unknown[]) => unknown
        }
        b.or = (expr: string) => {
          const m = /^payment_status\.in\.\(([^)]*)\),/.exec(expr)
          if (!m) throw new Error(`unmodelled .or(${expr})`)
          return b.in('payment_status', m[1].split(','))
        }
        return b
      },
    }
  },
}))

function seed(f: AmendFixture) {
  mockDb = new InMemoryDb({
    tabs: [{ id: TAB, restaurant_id: RESTAURANT, table_id: 'table-1', total: 0, status: 'open', settled_at: null }],
    orders: f.orders.map((o) => ({ ...o, restaurant_id: RESTAURANT, terminal_pushed_at: null })),
    order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
    order_requests: [],
    payments: [],
    audit_logs: [],
  })
}

async function settle(orderIds: string[], amount: number, method = 'cash') {
  const { POST } = await import('@/app/api/terminal/tabs/[tabId]/settle/route')
  const res = await POST(
    new NextRequest(`http://localhost/api/terminal/tabs/${TAB}/settle`, {
      method: 'POST',
      body: JSON.stringify({ order_ids: orderIds, amount, method }),
    }),
    { params: Promise.resolve({ tabId: TAB }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const order = (id: string) => mockDb.rows('orders').find((o) => String(o.id) === id)!

function rivieraTab() {
  const f = new AmendFixture(TAB)
  const original = f.place(RIVIERA_ITEMS, { id: '0000aaaa-0000-4000-8000-000000000160' })
  const r1 = f.amend(original.id, 'Wish You Were Here', 1)!
  const r2 = f.amend(original.id, 'Double Cheese Burger', 1)!
  const r3 = f.amend(original.id, 'Seared Salmon', 1)!
  return { f, ids: [original.id, r1.id, r2.id, r3.id] }
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('tab settle: cash on an amended tab', () => {
  it("ACCEPTS the terminal's line-based figure (N$1,205) and records it", async () => {
    const { f, ids } = rivieraTab()
    seed(f)
    const { status, body } = await settle(ids, 1205)
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    const payment = mockDb.rows('payments')[0]
    expect(payment.amount).toBe(1205)
  })

  it('refuses a figure that matches neither basis', async () => {
    const { f, ids } = rivieraTab()
    seed(f)
    const { status, body } = await settle(ids, 1300)
    expect(status).toBe(400)
    expect(body.code).toBe('AMOUNT_MISMATCH')
    expect(body.expected).toBe(1205)
  })

  it('records what this settlement applied to EACH order (settled_charge_cents), not its total', async () => {
    const { f, ids } = rivieraTab()
    seed(f)
    await settle(ids, 1205)
    expect(order(ids[0]).settled_charge_cents).toBe(46500)
    expect(order(ids[1]).settled_charge_cents).toBe(19000)
    expect(order(ids[2]).settled_charge_cents).toBe(9000)
    expect(order(ids[3]).settled_charge_cents).toBe(46000)
    for (const id of ids) expect(order(id).payment_status).toBe('paid')
  })

  it('writes the stored tab total from the projection, and a settled tab can close', async () => {
    const { f, ids } = rivieraTab()
    seed(f)
    const { body } = await settle(ids, 1205)
    expect(body.new_tab_total).toBe(0)
    expect(body.can_close).toBe(true)
  })

  it('a PART settle leaves the live remainder -- not orders.total -- as the stored tab total', async () => {
    const { f, ids } = rivieraTab()
    seed(f)
    // Settle the three replacements only (190 + 90 + 460); the original's live N$465 remains.
    const { status, body } = await settle(ids.slice(1), 740)
    expect(status).toBe(200)
    expect(body.new_tab_total).toBe(465)
    expect(mockDb.rows('tabs')[0].total).toBe(465)
    expect(body.can_close).toBe(false)
  })

  it('a pending order whose every line was voided does not keep the table open', async () => {
    const f = new AmendFixture(TAB)
    const a = f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    const b = f.place([{ name: 'Starter', quantity: 1, total: 60 }])
    f.amend(b.id, 'Starter', 0)
    seed(f)
    const { status, body } = await settle([a.id], 220)
    expect(status).toBe(200)
    // b is still `pending` -- and owes nothing.
    expect(order(b.id).payment_status).toBe('pending')
    expect(body.new_tab_total).toBe(0)
    expect(body.can_close).toBe(true)
  })
})
