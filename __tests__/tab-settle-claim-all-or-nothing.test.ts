/**
 * N2 (Sprint 2026-09-28): the tab settle claim is ALL OR NOTHING.
 *
 * The claim is one UPDATE that matches row by row. When another payment took one of the selected
 * orders between the route's validation and its claim, the rest were claimed -- and the route
 * answered 409 SETTLE_CLAIM_CONFLICT and stopped, leaving them paid with no payments row, no ledger
 * row, no receipt, no audit and no tab total recompute. On the card path the reader had already
 * charged the customer.
 *
 * Runs the REAL route against the in-memory PostgREST store. The race is modelled by letting a
 * second payment land on one order at the instant the route issues its claim.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB = '0000cccc-0000-4000-8000-000000000020'

let mockDb: InMemoryDb
/** Order ids another payment takes at the instant the route claims. */
let mockRaceTakes: string[] = []
const mockReceipts: string[][] = []

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
  safeIssueReceiptsForOrders: async (ids: string[]) => {
    mockReceipts.push(ids)
  },
}))
jest.mock('@/lib/tabs/settle-tab-state', () => ({
  clearReadyToPayAndReopenTab: async () => undefined,
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const client = mockDb.client()
    return {
      ...client,
      from(table: string) {
        const b = client.from(table) as unknown as Record<string, unknown> & {
          in: (c: string, v: unknown[]) => unknown
          update: (p: Record<string, unknown>) => unknown
        }
        // The cash claim's `.or()` is not modelled; every fixture order is `pending`.
        b.or = (expr: string) => {
          const m = /^payment_status\.in\.\(([^)]*)\),/.exec(expr)
          if (!m) throw new Error(`unmodelled .or(${expr})`)
          return b.in('payment_status', m[1].split(','))
        }
        if (table === 'orders') {
          const update = b.update.bind(b)
          b.update = (payload: Record<string, unknown>) => {
            // THE RACE: the route's claim is the update that writes payment_status 'paid' with
            // its own generated reference. Another payment lands first on the named orders.
            if (payload.payment_status === 'paid' && mockRaceTakes.length > 0) {
              for (const id of mockRaceTakes) {
                Object.assign(mockDb.rows('orders').find((o) => String(o.id) === id)!, {
                  payment_status: 'paid',
                  payment_method: 'cash',
                  payment_reference: 'PAY-OTHER-TERMINAL',
                  status: 'completed',
                })
              }
              mockRaceTakes = []
            }
            return update(payload)
          }
        }
        return b
      },
    }
  },
}))

function seed(f: AmendFixture) {
  mockDb = new InMemoryDb({
    tabs: [{ id: TAB, restaurant_id: RESTAURANT, table_id: 'table-1', total: 720, status: 'open', settled_at: null }],
    orders: f.orders.map((o) => ({
      ...o,
      restaurant_id: RESTAURANT,
      terminal_pushed_at: null,
      payment_method: null,
      payment_reference: null,
      payment_voucher_no: null,
      paid_at: null,
      completed_at: null,
    })),
    order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
    order_requests: [],
    payments: [],
    payment_events: [],
    audit_logs: [],
  })
}

async function settle(orderIds: string[], amount: number, method: string) {
  const { POST } = await import('@/app/api/terminal/tabs/[tabId]/settle/route')
  const res = await POST(
    new NextRequest(`http://localhost/api/terminal/tabs/${TAB}/settle`, {
      method: 'POST',
      body: JSON.stringify({ order_ids: orderIds, amount, method, business_order_no: 'FT-BON-1', voucher_no: 'V-1' }),
    }),
    { params: Promise.resolve({ tabId: TAB }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const order = (id: string) => mockDb.rows('orders').find((o) => String(o.id) === id)!

function twoOrders() {
  const f = new AmendFixture(TAB)
  const x = f.place([{ name: 'Burger', quantity: 1, total: 220 }])
  const y = f.place([{ name: 'Steak', quantity: 1, total: 500 }])
  seed(f)
  return { x: x.id, y: y.id }
}

beforeEach(() => {
  mockRaceTakes = []
  mockReceipts.length = 0
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('N2: a partial claim leaves NOTHING paid by this request', () => {
  it.each(['card', 'cash'])('%s: the claimed order is put back exactly as it was read', async (method) => {
    const { x, y } = twoOrders()
    mockRaceTakes = [y]
    const { status, body } = await settle([x, y], 720, method)

    expect(status).toBe(409)
    expect(body.code).toBe('SETTLE_CLAIM_CONFLICT')
    expect(body.reverted_order_ids).toEqual([x])
    expect(body.revert_failed_order_ids).toEqual([])

    // X: exactly as read.
    const rx = order(x)
    expect(rx.payment_status).toBe('pending')
    expect(rx.status).toBe('pending')
    expect(rx.payment_method).toBeNull()
    expect(rx.payment_reference).toBeNull()
    expect(rx.paid_at).toBeNull()
    expect(rx.settled_charge_cents).toBeNull()
    // Y: the other payment's, untouched.
    expect(order(y)).toMatchObject({ payment_status: 'paid', payment_reference: 'PAY-OTHER-TERMINAL' })

    // Nothing recorded as settled by this request.
    expect(mockDb.rows('payments')).toHaveLength(0)
    expect(mockDb.rows('payment_events')).toHaveLength(0)
    expect(mockReceipts).toHaveLength(0)
  })

  it('card: the conflict is written down, including that the card was charged', async () => {
    const { x, y } = twoOrders()
    mockRaceTakes = [y]
    const { body } = await settle([x, y], 720, 'card')
    expect(body.card_charged).toBe(true)

    const rows = mockDb.rows('audit_logs').filter((r) => r.action === 'payment.settle_claim_conflict')
    expect(rows).toHaveLength(1)
    expect(rows[0].entity_id).toBe(TAB)
    expect(rows[0].metadata).toMatchObject({
      card_charged: true,
      method: 'card',
      amount: 720,
      business_order_no: 'FT-BON-1',
      voucher_no: 'V-1',
      claimed_then_reverted_order_ids: [x],
      lost_to_another_payment_order_ids: [y],
      revert_failed_order_ids: [],
    })
  })

  it('card: every order lost to the race (ALREADY_PAID) is written down too', async () => {
    const { x, y } = twoOrders()
    mockRaceTakes = [x, y]
    const { status, body } = await settle([x, y], 720, 'card')
    expect(status).toBe(409)
    expect(body.code).toBe('ALREADY_PAID')
    const rows = mockDb.rows('audit_logs').filter((r) => r.action === 'payment.settle_claim_conflict')
    expect(rows).toHaveLength(1)
    expect((rows[0].metadata as Record<string, unknown>).card_charged).toBe(true)
  })

  it('control: an uncontested settle still claims and records everything', async () => {
    const { x, y } = twoOrders()
    const { status } = await settle([x, y], 720, 'card')
    expect(status).toBe(200)
    expect(order(x).payment_status).toBe('paid')
    expect(order(y).payment_status).toBe('paid')
    expect(mockDb.rows('payments')).toHaveLength(1)
    expect(mockDb.rows('audit_logs').filter((r) => r.action === 'payment.settle_claim_conflict')).toHaveLength(0)
  })
})
