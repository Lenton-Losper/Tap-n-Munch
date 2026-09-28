/**
 * A PAID ORDER IS NOT CANCELLED OVER ITS PAYMENT (Sprint 2026-09-29 brief, F-MANUAL task 2).
 *
 * The dashboard's status route cancelled from any kitchen status but completed/cancelled and wrote
 * payment_status 'cancelled' with it, so an order paid by hand while `preparing`, a QR order paid
 * before the kitchen started, or an order half paid through the item ledger became a "cancelled
 * payment" with the money still taken. The terminal's pre-gateway cancel did the same with
 * `guard: 'none'`.
 *
 * Runs the REAL routes and the REAL guard (lib/orders/paid-order-cancellation.ts, which reads the
 * real payment projection) against the in-memory PostgREST store. Only auth is replaced.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TAB = '0000cccc-0000-4000-8000-000000000041'
const STAFF = '55555555-5555-4555-8555-555555555555'

let mockDb: InMemoryDb
let mockPermissionDenied = false
/** When set, the allocation read fails -- the guard must fail closed. */
let mockAllocationsReadFails = false

jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (value: unknown) => value instanceof Response,
  requireStaffPermission: async (restaurantId: string) =>
    !mockPermissionDenied && restaurantId === 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
      ? { userId: '55555555-5555-4555-8555-555555555555', restaurantId }
      : new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }),
}))
jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    permissions: ['orders:update'],
  }),
  validateTerminalRecord: async () => undefined,
}))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: async () => undefined,
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const client = mockDb.client()
    return {
      ...client,
      from(table: string) {
        const b = client.from(table) as unknown as Record<string, unknown> & {
          then: (...a: unknown[]) => unknown
        }
        // cancelOrderWithTrail's guard 'none': `payment_status IS NULL OR payment_status <> 'paid'`.
        b.or = (expr: string) => {
          if (expr !== 'payment_status.is.null,payment_status.neq.paid') {
            throw new Error(`unmodelled .or(${expr})`)
          }
          return (b as unknown as { neq: (c: string, v: string) => unknown }).neq('payment_status', 'paid')
        }
        if (table === 'order_line_allocations' && mockAllocationsReadFails) {
          b.then = ((ok: (v: unknown) => unknown) =>
            Promise.resolve({ data: null, error: { message: 'read failed (test)' } }).then(ok)) as never
        }
        return b
      },
    }
  },
}))

type Row = Record<string, unknown>

function seed(overrides: Row = {}, extra: Record<string, Row[]> = {}) {
  const f = new AmendFixture(TAB)
  const o = f.place([{ name: 'Burger', quantity: 1, total: 220 }], {
    status: 'preparing',
    ...overrides,
  } as never)
  mockDb = new InMemoryDb({
    orders: f.orders.map((r) => ({
      payment_method: null,
      payment_reference: null,
      paycloud_merchant_order_no: null,
      paid_at: null,
      ...r,
      restaurant_id: RESTAURANT,
    })),
    order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
    order_line_events: [],
    order_line_allocations: [],
    order_line_allocation_settlements: [],
    non_gateway_payment_events: [],
    payment_events: [],
    payments: [],
    audit_logs: [],
    ...extra,
  })
  return o.id
}

async function dashboardCancel(orderId: string, body: Row = { status: 'cancelled' }) {
  const { PATCH } = await import('@/app/api/orders/[orderId]/status/route')
  const res = await PATCH(
    new Request(`http://localhost/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orderId }) },
  )
  return { status: res.status, body: (await res.json()) as Row }
}

async function terminalCancel(orderId: string) {
  const { PATCH } = await import('@/app/api/terminal/orders/[orderId]/status/route')
  const res = await PATCH(
    new NextRequest(`http://localhost/api/terminal/orders/${orderId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'cancelled' }),
    }),
    { params: Promise.resolve({ orderId }) },
  )
  return { status: res.status, body: (await res.json()) as Row }
}

const order = (id: string) => mockDb.rows('orders').find((o) => String(o.id) === id)!
const cancelAudits = () => mockDb.rows('audit_logs').filter((r) => r.action === 'order.cancelled')
/** A deep copy of the money tables, to prove a refusal wrote NOTHING to them. */
const moneySnapshot = () =>
  JSON.stringify(
    ['payment_events', 'non_gateway_payment_events', 'payments', 'order_line_allocations', 'order_line_allocation_settlements']
      .map((t) => mockDb.rows(t)),
  )

const manualLedgerRow = (orderId: string): Row => ({
  id: 'ledger-1',
  restaurant_id: RESTAURANT,
  origin: 'staff_mark_paid',
  method: 'cash',
  amount_cents: 22000,
  tip_cents: 0,
  order_ids: [orderId],
  payment_reference: 'PAY-MANUAL-1',
  idempotency_key: `staff_mark_paid:${orderId}`,
  recorded_by: STAFF,
  actor_attribution: 'staff_session',
})

const saleRow = (orderId: string, amount = 220): Row => ({
  id: 'sale-1',
  restaurant_id: RESTAURANT,
  event_type: 'sale',
  business_order_no: 'FT-SALE-1',
  origin_business_order_no: 'FT-SALE-1',
  amount,
  currency: 'NAD',
  order_ids: [orderId],
  created_at: '2026-09-29T10:00:00Z',
})

const refundRow = (amount: number, n = 1): Row => ({
  id: `refund-${n}`,
  restaurant_id: RESTAURANT,
  event_type: 'refund_succeeded',
  business_order_no: `FT-REF-${n}`,
  origin_business_order_no: 'FT-SALE-1',
  amount,
  currency: 'NAD',
  order_ids: [],
  created_at: '2026-09-29T11:00:00Z',
})

beforeEach(() => {
  mockPermissionDenied = false
  mockAllocationsReadFails = false
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('dashboard cancel: unpaid still works', () => {
  it('an unpaid order is cancelled, its payment_status cancelled, its lines voided', async () => {
    const id = seed()
    const { status, body } = await dashboardCancel(id)
    expect(status).toBe(200)
    expect(order(id).status).toBe('cancelled')
    expect(order(id).payment_status).toBe('cancelled')
    expect(body.lines_voided).toBe(1)
    expect(cancelAudits()).toHaveLength(1)
  })
})

describe('dashboard cancel: money on the order refuses it', () => {
  it('PAID by hand (cash, no gateway sale): 409 ORDER_PAID_REFUND_REQUIRED, nothing touched', async () => {
    const id = seed(
      { payment_status: 'paid', payment_method: 'cash', payment_reference: 'PAY-MANUAL-1', settled_charge_cents: 22000 },
      {},
    )
    mockDb.rows('non_gateway_payment_events').push(manualLedgerRow(id))
    const before = moneySnapshot()
    const { status, body } = await dashboardCancel(id)
    expect(status).toBe(409)
    expect(body.code).toBe('ORDER_PAID_REFUND_REQUIRED')
    expect(body.refund_path).toBe('none_in_flashtap')
    expect(order(id).status).toBe('preparing')
    expect(order(id).payment_status).toBe('paid')
    expect(order(id).payment_reference).toBe('PAY-MANUAL-1')
    expect(moneySnapshot()).toBe(before)
    expect(cancelAudits()).toHaveLength(0)
    expect(mockDb.rows('order_lines').every((l) => l.kitchen_state !== 'voided')).toBe(true)
  })

  it('PAID by card (gateway sale): 409 naming the terminal refund', async () => {
    const id = seed({ payment_status: 'paid', payment_method: 'card' }, { payment_events: [] })
    mockDb.rows('payment_events').push(saleRow(id))
    const before = moneySnapshot()
    const { status, body } = await dashboardCancel(id)
    expect(status).toBe(409)
    expect(body.code).toBe('ORDER_PAID_REFUND_REQUIRED')
    expect(body.refund_path).toBe('terminal_card_refund')
    expect(order(id).payment_status).toBe('paid')
    expect(moneySnapshot()).toBe(before)
  })

  it('the redundant payment_status body field cannot get round it', async () => {
    const id = seed({ payment_status: 'paid', payment_method: 'cash' })
    const { status } = await dashboardCancel(id, { status: 'cancelled', payment_status: 'cancelled' })
    expect(status).toBe(409)
    expect(order(id).payment_status).toBe('paid')
  })

  it('PARTIALLY paid through the item ledger: 409 ORDER_PARTIALLY_PAID_REFUND_REQUIRED', async () => {
    const id = seed()
    mockDb.rows('order_line_allocations').push({
      id: 'alloc-1', restaurant_id: RESTAURANT, order_id: id, amount_cents: 11000,
      settled_at: '2026-09-29T09:00:00Z', voided_at: null,
    })
    mockDb.rows('order_line_allocation_settlements').push({
      id: 'set-1', restaurant_id: RESTAURANT, order_line_allocation_id: 'alloc-1', amount_cents: 11000, method: 'cash',
    })
    const before = moneySnapshot()
    const { status, body } = await dashboardCancel(id)
    expect(status).toBe(409)
    expect(body.code).toBe('ORDER_PARTIALLY_PAID_REFUND_REQUIRED')
    expect(order(id).status).toBe('preparing')
    expect(order(id).payment_status).toBe('pending')
    expect(moneySnapshot()).toBe(before)
  })

  it('PARTIALLY paid, seen only through a non-gateway ledger row: refused', async () => {
    const id = seed()
    mockDb.rows('non_gateway_payment_events').push({ ...manualLedgerRow(id), origin: 'terminal_allocation_settle' })
    const { status, body } = await dashboardCancel(id)
    expect(status).toBe(409)
    expect(body.code).toBe('ORDER_PARTIALLY_PAID_REFUND_REQUIRED')
  })

  it('a held-for-review order with a real card sale on it: refused', async () => {
    const id = seed({ payment_status: 'amount_mismatch_hold' })
    mockDb.rows('payment_events').push(saleRow(id, 250))
    const { status, body } = await dashboardCancel(id)
    expect(status).toBe(409)
    expect(body.refund_path).toBe('terminal_card_refund')
    expect(order(id).payment_status).toBe('amount_mismatch_hold')
  })

  it('PARTIALLY REFUNDED card sale: still refused -- money is still held', async () => {
    const id = seed({ payment_status: 'paid', payment_method: 'card' })
    mockDb.rows('payment_events').push(saleRow(id), refundRow(100))
    const { status, body } = await dashboardCancel(id)
    expect(status).toBe(409)
    expect(body.code).toBe('ORDER_PAID_REFUND_REQUIRED')
    expect(order(id).payment_status).toBe('paid')
  })

  it('FAILS CLOSED: an unreadable payment state refuses (503) and changes nothing', async () => {
    const id = seed()
    mockAllocationsReadFails = true
    const { status, body } = await dashboardCancel(id)
    expect(status).toBe(503)
    expect(body.code).toBe('PAYMENT_STATE_UNREADABLE')
    expect(order(id).status).toBe('preparing')
  })

  it('REFUSES a user without the permission (403) before anything is read or written', async () => {
    const id = seed()
    mockPermissionDenied = true
    const { status } = await dashboardCancel(id)
    expect(status).toBe(403)
    expect(order(id).status).toBe('preparing')
    expect(order(id).payment_status).toBe('pending')
  })
})

describe('dashboard cancel: a FULLY refunded card sale', () => {
  it('may be cancelled; payment_status stays paid, the sale and refund rows are untouched', async () => {
    const id = seed({ payment_status: 'paid', payment_method: 'card', payment_reference: 'FT-SALE-1' })
    mockDb.rows('payment_events').push(saleRow(id), refundRow(120, 1), refundRow(100, 2))
    const before = moneySnapshot()
    const { status } = await dashboardCancel(id)
    expect(status).toBe(200)
    expect(order(id).status).toBe('cancelled')
    // THE RULING: no "cancelled payment". The history says paid, then refunded.
    expect(order(id).payment_status).toBe('paid')
    expect(order(id).payment_reference).toBe('FT-SALE-1')
    expect(moneySnapshot()).toBe(before)
    expect(cancelAudits()).toHaveLength(1)
    expect(cancelAudits()[0].metadata).toMatchObject({
      payment_status_preserved: true,
      previous_payment_status: 'paid',
    })
  })
})

describe('terminal cancel (pre-gateway branch) obeys the same rule', () => {
  it('REFUSES a cash-paid order', async () => {
    const id = seed({ payment_status: 'paid', payment_method: 'cash' })
    const { status, body } = await terminalCancel(id)
    expect(status).toBe(409)
    expect(body.code).toBe('ORDER_PAID_REFUND_REQUIRED')
    expect(order(id).payment_status).toBe('paid')
    expect(order(id).status).toBe('preparing')
  })

  it('still cancels an unpaid order', async () => {
    const id = seed()
    const { status } = await terminalCancel(id)
    expect(status).toBe(200)
    expect(order(id).status).toBe('cancelled')
    expect(order(id).payment_status).toBe('cancelled')
  })

  it('a fully refunded sale is cancelled with its payment_status kept', async () => {
    const id = seed({ payment_status: 'paid', payment_method: 'card', paycloud_merchant_order_no: 'FT-SALE-1' })
    mockDb.rows('payment_events').push(saleRow(id), refundRow(220))
    const { status } = await terminalCancel(id)
    expect(status).toBe(200)
    expect(order(id).status).toBe('cancelled')
    expect(order(id).payment_status).toBe('paid')
  })
})

describe('cancelOrderWithTrail guard none never matches a paid order (the race backstop)', () => {
  it('a paid order is not cancelled even when the caller skipped the check', async () => {
    const id = seed({ payment_status: 'paid', payment_method: 'cash' })
    const { cancelOrderWithTrail } = await import('@/lib/orders/cancel-order-with-trail')
    // The mocked server client: the in-memory store plus the same .or() model the routes use.
    const { createServerSupabaseClient } = await import('@/lib/supabase/server')
    const r2 = await cancelOrderWithTrail(createServerSupabaseClient() as never, {
      orderId: id,
      restaurantId: RESTAURANT,
      cancellationReason: 'test',
      basis: 'terminal_pre_gateway',
      guard: 'none',
      actorKind: 'terminal',
      actorUserId: null,
    })
    expect(r2.cancelled).toBe(false)
    expect(order(id).payment_status).toBe('paid')
    expect(order(id).status).toBe('preparing')
  })
})
