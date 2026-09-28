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
 *
 * SPRINT 2026-09-29 (F-MANUAL): Mark-as-Paid is now ONE transaction in Postgres,
 * `record_manual_order_payment` (20260929100000), which also writes the immutable
 * non_gateway_payment_events row. The in-memory store has no plpgsql, so `mockRecordManualPayment`
 * below is a MODEL of that function's contract (scope, conditional claim, settleable set, ledger
 * key, all-or-nothing). The function ITSELF -- immutability, the unique key, restaurant scoping,
 * grants -- is proven against real Postgres by supabase/tests/manual-ledger.test.sql. What this
 * suite proves is the route's side: the figure it sends is the server's, the actor is the signed-in
 * staff member, and unauthorised or cross-restaurant callers never reach the function at all.
 */
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB = '0000cccc-0000-4000-8000-000000000077'

const OTHER_RESTAURANT = '99999999-9999-4999-8999-999999999999'
const STAFF = '55555555-5555-4555-8555-555555555555'

let mockDb: InMemoryDb
/** When set, the Mark-as-Paid transaction fails as a whole -- nothing is written. */
let mockRpcFails = false
/** When set, the signed-in user lacks orders:update at every restaurant. */
let mockPermissionDenied = false
const mockReceipts: string[] = []

/**
 * Staff auth, modelled on the real contract: the staff member belongs to ONE restaurant and is
 * refused (403) for any order of another -- which is what makes a cross-restaurant order unreachable.
 */
jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (value: unknown) => value instanceof Response,
  requireStaffPermission: async (restaurantId: string) =>
    !mockPermissionDenied && restaurantId === 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
      ? { userId: '55555555-5555-4555-8555-555555555555', restaurantId }
      : new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
}))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: async (orderId: string) => {
    mockReceipts.push(orderId)
  },
}))
/** A model of record_manual_order_payment()'s contract. See the header. */
function mockRecordManualPayment(a: Record<string, unknown>) {
  const o = mockDb
    .rows('orders')
    .find((r) => String(r.id) === a.p_order_id && String(r.restaurant_id) === a.p_restaurant_id)
  if (!o) return { data: { ok: false, reason: 'order_not_found' }, error: null }
  if ((o.payment_status ?? null) !== (a.p_expected_payment_status ?? null)) {
    return { data: { ok: false, reason: 'payment_status_changed' }, error: null }
  }
  if (o.payment_status === 'paid') return { data: { ok: false, reason: 'already_paid' }, error: null }
  if (!['unpaid', 'pending', 'cash_pending', 'failed'].includes(String(o.payment_status))) {
    return { data: { ok: false, reason: 'not_settleable' }, error: null }
  }
  // The function RAISES on these; a raise is an error with nothing written.
  if (!a.p_staff_user_id || !(Number(a.p_amount_cents) > 0) || mockRpcFails) {
    return { data: null, error: { message: 'record_manual_order_payment raised (test)' } }
  }
  const key = `staff_mark_paid:${String(a.p_order_id)}`
  if (mockDb.rows('non_gateway_payment_events').some((r) => r.idempotency_key === key)) {
    return { data: null, error: { code: '23505', message: 'duplicate key value' } }
  }
  const paidAt = new Date().toISOString()
  Object.assign(o, {
    payment_status: 'paid',
    payment_method: a.p_method,
    payment_reference: a.p_payment_reference,
    paid_at: paidAt,
    settled_charge_cents: a.p_amount_cents,
  })
  mockDb.rows('payments').push({
    id: `pay-${mockDb.rows('payments').length + 1}`,
    restaurant_id: a.p_restaurant_id,
    tab_id: o.tab_id ?? null,
    order_ids: [a.p_order_id],
    amount: Number(a.p_amount_cents) / 100,
    method: a.p_method,
    status: 'completed',
    gateway_reference: null,
    payment_reference: a.p_payment_reference,
  })
  const ledgerId = `ledger-${mockDb.rows('non_gateway_payment_events').length + 1}`
  mockDb.rows('non_gateway_payment_events').push({
    id: ledgerId,
    restaurant_id: a.p_restaurant_id,
    origin: 'staff_mark_paid',
    method: a.p_method,
    amount_cents: a.p_amount_cents,
    tip_cents: 0,
    order_ids: [a.p_order_id],
    tab_id: o.tab_id ?? null,
    payment_reference: a.p_payment_reference,
    idempotency_key: key,
    recorded_by: a.p_staff_user_id,
    actor_attribution: 'staff_session',
    source: a.p_source,
  })
  mockDb.rows('audit_logs').push({
    restaurant_id: a.p_restaurant_id,
    action: 'payment.marked_paid_manually',
    entity_type: 'order',
    entity_id: a.p_order_id,
    metadata: {
      staff_user_id: a.p_staff_user_id,
      method: a.p_method,
      amount_cents: a.p_amount_cents,
      previous_payment_status: a.p_expected_payment_status,
      payment_reference: a.p_payment_reference,
      gateway_verified: false,
      payment_record_written: true,
      ledger_event_id: ledgerId,
    },
  })
  return { data: { ok: true, ledger_event_id: ledgerId }, error: null }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const client = mockDb.client()
    return {
      ...client,
      async rpc(name: string, args: Record<string, unknown>) {
        if (name === 'record_manual_order_payment') {
          mockDb.rpcCalls.push({ name, args })
          return mockRecordManualPayment(args)
        }
        return client.rpc(name, args)
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
    non_gateway_payment_events: [],
    payment_events: [],
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
const ledger = () => mockDb.rows('non_gateway_payment_events')
const rpcCalls = () => mockDb.rpcCalls.filter((c) => c.name === 'record_manual_order_payment')

beforeEach(() => {
  mockRpcFails = false
  mockPermissionDenied = false
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
      // Refused by the route itself, with the reason named -- not left to the transaction's own
      // backstop (Sprint 2026-09-29: the RPC refuses these too, so a 409 alone proves nothing).
      expect(rpcCalls()).toHaveLength(0)
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
      staff_user_id: STAFF,
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
    expect(ledger()).toHaveLength(1)
    expect(audits('payment.marked_paid_manually')).toHaveLength(1)
  })

  it('NOTHING WRITTEN, NOTHING PAID: when the transaction fails the order is untouched', async () => {
    const id = oneOrder()
    mockRpcFails = true
    const { status, body } = await patch(id, { payment_status: 'paid', payment_method: 'cash' })
    expect(status).toBe(503)
    expect(body.code).toBe('PAYMENT_TRAIL_NOT_RECORDED')
    const row = order(id)
    expect(row.payment_status).toBe('pending')
    expect(row.payment_reference).toBeNull()
    expect(row.settled_charge_cents).toBeNull()
    expect(mockDb.rows('payments')).toHaveLength(0)
    expect(ledger()).toHaveLength(0)
    expect(mockReceipts).toHaveLength(0)
  })
})

/**
 * THE LEDGER INVARIANT (Sprint 2026-09-29 brief): every successful payment has an immutable ledger
 * record. A manual payment's is a non_gateway_payment_events row -- never a payment_events row.
 */
describe('Mark-as-Paid writes exactly one non-gateway ledger row', () => {
  it('one row: the SERVER amount (not the client one), the method, the staff member, no gateway fields', async () => {
    const id = oneOrder()
    const { status, body } = await patch(id, {
      payment_status: 'paid',
      payment_method: 'paytoday',
      // A hostile or stale client figure. It must not reach the ledger.
      amount: 1,
      amount_cents: 100,
    })
    expect(status).toBe(200)
    expect(rpcCalls()).toHaveLength(1)
    expect(rpcCalls()[0].args).toMatchObject({
      p_restaurant_id: RESTAURANT,
      p_order_id: id,
      p_amount_cents: 22000,
      p_method: 'paytoday',
      p_staff_user_id: STAFF,
      p_expected_payment_status: 'pending',
    })
    expect(ledger()).toHaveLength(1)
    expect(ledger()[0]).toMatchObject({
      origin: 'staff_mark_paid',
      method: 'paytoday',
      amount_cents: 22000,
      recorded_by: STAFF,
      actor_attribution: 'staff_session',
      order_ids: [id],
      restaurant_id: RESTAURANT,
    })
    expect((body.payment as Record<string, unknown>).ledger_event_id).toBe(ledger()[0].id)
    // Not represented as a gateway payment anywhere.
    expect(mockDb.rows('payment_events')).toHaveLength(0)
    const row = order(id)
    expect(row.paycloud_merchant_order_no ?? null).toBeNull()
    expect(row.payment_voucher_no ?? null).toBeNull()
    expect(mockDb.rows('payments')[0].gateway_reference).toBeNull()
  })

  it('a double click (two requests that both read pending) records one payment', async () => {
    const id = oneOrder()
    const [a, b] = await Promise.all([
      patch(id, { payment_status: 'paid', payment_method: 'cash' }),
      patch(id, { payment_status: 'paid', payment_method: 'cash' }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(ledger()).toHaveLength(1)
    expect(audits('payment.marked_paid_manually')).toHaveLength(1)
  })

  it('REFUSES a user without the permission (403) and never reaches the ledger', async () => {
    const id = oneOrder()
    mockPermissionDenied = true
    const { status } = await patch(id, { payment_status: 'paid', payment_method: 'cash' })
    expect(status).toBe(403)
    expect(rpcCalls()).toHaveLength(0)
    expect(ledger()).toHaveLength(0)
    expect(order(id).payment_status).toBe('pending')
  })

  it("REFUSES another restaurant's order (403) and never reaches the ledger", async () => {
    const id = oneOrder()
    // oneOrder() stamps RESTAURANT on every row; move this one to the other venue.
    order(id).restaurant_id = OTHER_RESTAURANT
    const { status } = await patch(id, { payment_status: 'paid', payment_method: 'cash' })
    expect(status).toBe(403)
    expect(rpcCalls()).toHaveLength(0)
    expect(ledger()).toHaveLength(0)
    expect(order(id).payment_status).toBe('pending')
  })
})
