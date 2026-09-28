/**
 * N1 (Sprint 2026-09-28): PATCH /api/orders/[orderId]/status is no longer a paid writer without a
 * trail, and no longer a payment_status free-for-all.
 *
 * It accepted any payment_status in the enum and wrote it. The dashboard's Mark-as-Paid set `paid`
 * with no method, reference, amount or audit row and then issued a receipt; the same body could
 * move a paid order back to `pending` (to be charged again) or a cancelled order to `paid`.
 *
 * Runs the REAL route against the in-memory PostgREST store; only staff auth and receipt issuance
 * are replaced.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB = '0000cccc-0000-4000-8000-000000000077'

let mockDb: InMemoryDb
/** When set, audit_logs inserts fail -- the "no trail" case. */
let mockAuditFails = false
const mockReceipts: string[] = []

jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (value: unknown) => value instanceof Response,
  requireStaffPermission: async () => ({ userId: 'staff-7', restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652' }),
}))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: async (orderId: string) => {
    mockReceipts.push(orderId)
  },
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const client = mockDb.client()
    return {
      ...client,
      from(table: string) {
        const b = client.from(table) as unknown as Record<string, unknown>
        if (table === 'audit_logs' && mockAuditFails) {
          b.insert = async () => ({ data: null, error: { message: 'audit write refused (test)' } })
        }
        if (table === 'payments') {
          b.delete = () => ({
            eq: async (_c: string, id: string) => {
              const rows = mockDb.rows('payments')
              const i = rows.findIndex((r) => String(r.id) === id)
              if (i >= 0) rows.splice(i, 1)
              return { error: null }
            },
          })
        }
        return b
      },
    }
  },
}))

function seed(f: AmendFixture) {
  mockDb = new InMemoryDb({
    orders: f.orders.map((o) => ({ ...o, restaurant_id: RESTAURANT, payment_method: null, payment_reference: null, paid_at: null })),
    order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
    order_line_allocations: [],
    order_line_allocation_settlements: [],
    payments: [],
    audit_logs: [],
  })
}

async function patch(orderId: string, body: Record<string, unknown>) {
  const { PATCH } = await import('@/app/api/orders/[orderId]/status/route')
  const res = await PATCH(
    new Request(`http://localhost/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orderId }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const order = (id: string) => mockDb.rows('orders').find((o) => String(o.id) === id)!
const audits = (action: string) => mockDb.rows('audit_logs').filter((r) => r.action === action)

beforeEach(() => {
  mockAuditFails = false
  mockReceipts.length = 0
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

function oneOrder(overrides: Record<string, unknown> = {}) {
  const f = new AmendFixture(TAB)
  const o = f.place([{ name: 'Burger', quantity: 1, total: 220 }], overrides)
  seed(f)
  return o.id
}

describe('N1: no illegal payment_status transition through the staff status route', () => {
  it('REFUSES paid -> pending (the order would be charged again)', async () => {
    const id = oneOrder({ payment_status: 'paid', status: 'completed' })
    const { status, body } = await patch(id, { payment_status: 'pending' })
    expect(status).toBe(400)
    expect(body.code).toBe('PAYMENT_STATUS_NOT_STAFF_SETTABLE')
    expect(order(id).payment_status).toBe('paid')
  })

  it('REFUSES cancelled -> paid', async () => {
    const id = oneOrder({ payment_status: 'cancelled', status: 'cancelled' })
    const { status, body } = await patch(id, { payment_status: 'paid', payment_method: 'cash' })
    expect(status).toBe(409)
    expect(body.code).toBe('ORDER_CANCELLED')
    expect(order(id).payment_status).toBe('cancelled')
    expect(mockReceipts).toHaveLength(0)
  })

  it('REFUSES a bare payment_status cancel without cancelling the order', async () => {
    const id = oneOrder()
    const { status, body } = await patch(id, { payment_status: 'cancelled' })
    expect(status).toBe(400)
    expect(body.code).toBe('PAYMENT_STATUS_NEEDS_CANCEL')
    expect(order(id).payment_status).toBe('pending')
  })

  it.each(['terminal_pending', 'amount_mismatch_hold', 'verification_unavailable_hold'])(
    'REFUSES a manual payment over %s (a card payment is or may be attached)',
    async (ps) => {
      const id = oneOrder({ payment_status: ps })
      const { status } = await patch(id, { payment_status: 'paid', payment_method: 'cash' })
      expect(status).toBe(409)
      expect(order(id).payment_status).toBe(ps)
      expect(audits('payment.marked_paid_manually')).toHaveLength(0)
    },
  )
})

describe('N1: Mark-as-Paid is a trailed manual payment', () => {
  it('REFUSES a mark-as-paid that does not say how it was paid', async () => {
    const id = oneOrder()
    const { status, body } = await patch(id, { payment_status: 'paid' })
    expect(status).toBe(400)
    expect(body.code).toBe('PAYMENT_METHOD_REQUIRED')
    expect(order(id).payment_status).toBe('pending')
    expect(mockReceipts).toHaveLength(0)
  })

  it('records method, reference, the SERVER amount, a payments row and an audit row naming the staff member', async () => {
    const id = oneOrder()
    const { status, body } = await patch(id, { payment_status: 'paid', payment_method: 'cash', amount: 1 })
    expect(status).toBe(200)
    const row = order(id)
    expect(row.payment_status).toBe('paid')
    expect(row.payment_method).toBe('cash')
    expect(String(row.payment_reference)).toMatch(/^PAY-/)
    expect(row.settled_charge_cents).toBe(22000)
    expect((body.payment as Record<string, unknown>).amount_cents).toBe(22000)

    const payments = mockDb.rows('payments')
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ amount: 220, method: 'cash', order_ids: [id], payment_reference: row.payment_reference })

    const trail = audits('payment.marked_paid_manually')
    expect(trail).toHaveLength(1)
    expect(trail[0].entity_id).toBe(id)
    expect(trail[0].metadata).toMatchObject({
      staff_user_id: 'staff-7',
      method: 'cash',
      amount_cents: 22000,
      previous_payment_status: 'pending',
      payment_reference: row.payment_reference,
      gateway_verified: false,
      payment_record_written: true,
    })
    expect(mockReceipts).toEqual([id])
  })

  it('records the LIVE outstanding figure on an amended order, not orders.total', async () => {
    const f = new AmendFixture(TAB)
    const o = f.place([
      { name: 'Burger', quantity: 1, total: 220 },
      { name: 'Starter', quantity: 1, total: 60 },
    ])
    f.amend(o.id, 'Starter', 0)
    seed(f)
    const { status } = await patch(o.id, { payment_status: 'paid', payment_method: 'card' })
    expect(status).toBe(200)
    expect(order(o.id).settled_charge_cents).toBe(22000)
    expect(mockDb.rows('payments')[0].amount).toBe(220)
  })

  it('a repeated Mark-as-Paid is ALREADY_PAID and writes no second trail', async () => {
    const id = oneOrder()
    await patch(id, { payment_status: 'paid', payment_method: 'cash' })
    const { status, body } = await patch(id, { payment_status: 'paid', payment_method: 'cash' })
    expect(status).toBe(409)
    expect(body.code).toBe('ALREADY_PAID')
    expect(mockDb.rows('payments')).toHaveLength(1)
    expect(audits('payment.marked_paid_manually')).toHaveLength(1)
  })

  it('NO TRAIL, NO PAYMENT: when the audit row cannot be written the order is put back', async () => {
    const id = oneOrder()
    mockAuditFails = true
    const { status, body } = await patch(id, { payment_status: 'paid', payment_method: 'cash' })
    expect(status).toBe(503)
    expect(body.code).toBe('PAYMENT_TRAIL_NOT_RECORDED')
    const row = order(id)
    expect(row.payment_status).toBe('pending')
    expect(row.payment_reference).toBeNull()
    expect(row.settled_charge_cents).toBeNull()
    expect(mockDb.rows('payments')).toHaveLength(0)
    expect(mockReceipts).toHaveLength(0)
  })
})
