/**
 * GET /api/terminal/tables: unpaid_total and can_close come from the financial projection.
 *
 * Two defects this pins, both on the terminal's floor view:
 *
 *   1. unpaid_total summed unpaid orders' stored totals, so an amended tab read the voided lines
 *      AND every replacement order (Riviera #160: N$1,945 + N$740 against a real N$1,205).
 *   2. can_close was "no order in an owing status", so a pending order whose every line was voided
 *      kept the table open until somebody paid for cancelled food.
 *
 * The REAL route runs; the nested restaurant_tables read is served from the fixture, everything
 * else from the in-memory PostgREST store.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture, RIVIERA_ITEMS } from './helpers/amend-fixture'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB = '0000cccc-0000-4000-8000-000000000020'

let mockDb: InMemoryDb
let mockTableRows: Array<Record<string, unknown>>

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))
jest.mock('@/lib/payments/get-payment-projection', () => ({
  getPaymentProjections: async () => new Map(),
}))
jest.mock('@/lib/tables/table-owners', () => ({
  loadTableOwners: async () => new Map(),
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const client = mockDb.client()
    return {
      from(table: string) {
        if (table !== 'restaurant_tables') return client.from(table)
        const b: Record<string, unknown> = {}
        Object.assign(b, {
          select: () => b,
          eq: () => b,
          in: () => b,
          order: () => b,
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: mockTableRows, error: null }).then(resolve),
        })
        return b
      },
    }
  },
}))

function seed(f: AmendFixture) {
  mockDb = new InMemoryDb({
    order_lines: f.lines.map((l) => ({ ...l })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
    order_requests: [],
  })
  mockTableRows = [
    {
      id: 'table-1',
      table_number: 1,
      status: 'occupied',
      tabs: [
        {
          id: TAB,
          status: 'open',
          total: 9999,
          members: [],
          created_at: '2026-09-28T12:00:00Z',
          orders: f.orders.map((o) => ({ ...o, terminal_pushed_at: null })),
        },
      ],
    },
  ]
}

async function tables() {
  const { GET } = await import('@/app/api/terminal/tables/route')
  const res = await GET(new Request('https://example.test/api/terminal/tables'))
  const body = (await res.json()) as { tables: Array<Record<string, any>> }
  return { status: res.status, table: body.tables[0] }
}

describe('terminal tables: the floor view reads the projection', () => {
  it('RIVIERA: unpaid_total is N$1,205, never N$1,945 plus the replacements', async () => {
    const f = new AmendFixture(TAB)
    const o = f.place(RIVIERA_ITEMS, { id: '0000aaaa-0000-4000-8000-000000000160' })
    f.amend(o.id, 'Wish You Were Here', 1)
    f.amend(o.id, 'Double Cheese Burger', 1)
    f.amend(o.id, 'Seared Salmon', 1)
    seed(f)
    const { status, table } = await tables()
    expect(status).toBe(200)
    expect(table.tab.unpaid_total).toBe(1205)
    expect(table.tab.financials).toMatchObject({
      original_cents: 268500,
      voided_cents: 148000,
      live_cents: 120500,
      outstanding_cents: 120500,
    })
    const original = table.tab.orders.find((x: any) => x.id === o.id)
    expect(original.financials).toMatchObject({ original_cents: 194500, live_cents: 46500 })
    expect(table.can_close).toBe(false)
  })

  it('a pending order whose every line was voided owes nothing, and the table CAN close', async () => {
    const f = new AmendFixture(TAB)
    f.place([{ name: 'Burger', quantity: 1, total: 220 }], { payment_status: 'paid', status: 'completed' })
    const voided = f.place([{ name: 'Starter', quantity: 1, total: 60 }])
    f.amend(voided.id, 'Starter', 0)
    seed(f)
    const { table } = await tables()
    expect(table.tab.unpaid_total).toBe(0)
    expect(table.tab.unpaid_order_count).toBe(0)
    expect(table.can_close).toBe(true)
  })

  it('CONTROL: a genuinely unpaid order still blocks the close', async () => {
    const f = new AmendFixture(TAB)
    f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    seed(f)
    const { table } = await tables()
    expect(table.tab.unpaid_total).toBe(220)
    expect(table.can_close).toBe(false)
  })

  it('an unreadable lines table fails TOWARD OWING: the voided order counts, the table stays open', async () => {
    const f = new AmendFixture(TAB)
    const voided = f.place([{ name: 'Starter', quantity: 1, total: 60 }])
    f.amend(voided.id, 'Starter', 0)
    seed(f)
    const client = mockDb.client()
    const broken = {
      ...client,
      from(table: string) {
        if (table === 'order_lines') {
          const b: Record<string, unknown> = {}
          Object.assign(b, {
            select: () => b,
            in: () => b,
            order: () => b,
            range: async () => ({ data: null, error: { message: 'lines down' } }),
          })
          return b
        }
        return client.from(table)
      },
    }
    const realClient = mockDb.client.bind(mockDb)
    mockDb.client = () => broken as ReturnType<typeof realClient>
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const { table } = await tables()
    expect(table.tab.unpaid_total).toBe(60)
    expect(table.can_close).toBe(false)
  })
})
