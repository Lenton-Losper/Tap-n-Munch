/**
 * PREPARE-PAYMENT NEVER RECORDS A FIGURE COMPUTED FROM AN ORDER THAT HAS SINCE MOVED
 * (Sprint 2026-09-29 brief, task 5).
 *
 * The route reads the orders (and their `charge_basis`, a computed field from 20260929120000), then
 * the lines and settlements, then writes pending_charge_cents per order. A guest edit or staff void
 * between the read and the write used to leave the reader launched for the stale figure. The route
 * now hands the basis it read back as `pending_charge_read_basis`; the database's stamp trigger
 * refuses with FTCHG when the row no longer matches (proven in two real sessions by
 * supabase/tests/charge-edit-race.test.sh, rounds 2 and 4).
 *
 * This file pins the ROUTE's half: it sends the basis, and on FTCHG it releases what it had already
 * written and refuses before the device is told to charge anything.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const A = '0000aaaa-0000-4000-8000-000000000001'
const B = '0000aaaa-0000-4000-8000-000000000002'

let mockDb: InMemoryDb
let mockClient: () => unknown
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
  ensureTerminalMerchantOrderNo: async () => ({ merchantOrderNo: 'FT1700000000000009', created: true }),
}))
jest.mock('@/lib/payments/payment-intents', () => ({
  ensureOrdersIntent: async (_s: unknown, params: Record<string, unknown>) => {
    mockIntentCalls.push(params)
    return { id: 'intent-1' }
  },
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => mockClient(),
}))

type Payload = Record<string, unknown>
const orderPatches: Array<{ id: unknown; payload: Payload }> = []

/**
 * The real in-memory store, with the database's stamp trigger modelled for ONE order: an update
 * that hands over a read basis for `movedId` is refused FTCHG, exactly as Postgres raises it when
 * the row changed between the route's read and its write.
 */
function clientWithMovedOrder(movedId: string | null) {
  const client = mockDb.client()
  return {
    ...client,
    from(table: string) {
      const qb = client.from(table) as unknown as Record<string, unknown>
      if (table !== 'orders') return qb
      const realThen = (qb.then as (...a: unknown[]) => unknown).bind(qb)
      qb.then = (onF: unknown, onR: unknown) => {
        const pending = qb.pending as { kind: string; payload: Payload } | null
        const filters = qb.filters as Array<{ column: string; value: unknown }>
        const id = filters.find((f) => f.column === 'id')?.value
        if (pending?.kind === 'update') orderPatches.push({ id, payload: pending.payload })
        if (pending?.kind === 'update' && pending.payload.pending_charge_read_basis && id === movedId) {
          return Promise.resolve({ data: null, error: { code: 'FTCHG', message: 'order moved' } }).then(
            onF as never,
            onR as never,
          )
        }
        return realThen(onF, onR)
      }
      return qb
    },
  }
}

function seed() {
  const order = (id: string, n: number, total: number) => ({
    id,
    restaurant_id: RESTAURANT,
    tab_id: null,
    order_number: n,
    status: 'accepted',
    payment_status: 'pending',
    total,
    items: [{ name: `Item ${n}`, quantity: 1, total }],
    tab_settlement_for_tab_id: null,
    settled_charge_cents: null,
    pending_settlement_id: null,
    pending_charge_cents: null,
    // What PostgREST returns for the computed field.
    charge_basis: `basis-${n}`,
  })
  mockDb = new InMemoryDb({
    orders: [order(A, 1, 220), order(B, 2, 500)],
    order_lines: [],
    order_line_allocations: [],
    order_line_allocation_settlements: [],
  })
}

async function prepare() {
  const { POST } = await import('@/app/api/terminal/orders/[orderId]/prepare-payment/route')
  const res = await POST(
    new NextRequest(`http://localhost/api/terminal/orders/${A}/prepare-payment`, {
      method: 'POST',
      body: JSON.stringify({ order_ids: [A, B] }),
    }),
    { params: Promise.resolve({ orderId: A }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const row = (id: string) => mockDb.rows('orders').find((o) => String(o.id) === id)!

beforeEach(() => {
  mockIntentCalls.length = 0
  orderPatches.length = 0
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('prepare-payment hands the database the basis its figure was computed from', () => {
  it('sends each order its OWN read basis with its expectation', async () => {
    seed()
    mockClient = () => clientWithMovedOrder(null)
    const { status, body } = await prepare()
    expect(status).toBe(200)
    expect(body.chargeCents).toBe(72000)
    const sent = orderPatches.filter((p) => 'pending_charge_cents' in p.payload && p.payload.pending_charge_cents != null)
    expect(sent.map((p) => [p.id, p.payload.pending_charge_read_basis])).toEqual([
      [A, 'basis-1'],
      [B, 'basis-2'],
    ])
  })

  it('an order that moved after the read: refused 409, nothing left recorded, no intent, nothing to charge', async () => {
    seed()
    mockClient = () => clientWithMovedOrder(B)
    const { status, body } = await prepare()
    expect(status).toBe(409)
    expect(body.code).toBe('ORDER_CHANGED_DURING_PREPARE')
    expect(body.chargeCents).toBeUndefined()
    // A was written before B was refused; it must not be left carrying half a settlement.
    expect(row(A).pending_charge_cents).toBeNull()
    expect(row(A).pending_settlement_id).toBeNull()
    expect(row(B).pending_charge_cents).toBeNull()
    expect(mockIntentCalls).toHaveLength(0)
  })
})
