/**
 * THE SINGLE-ORDER TERMINAL CALLBACK: A CASH / PAYTODAY SUCCESS GETS ITS LEDGER ROW.
 * (Sprint 2026-09-29 brief, F-MANUAL task 1 -- the device callback path.)
 *
 * POST /api/terminal/orders/[orderId]/payment accepts cash and PayToday as well as card and marks
 * the order paid through markOrderPaidConfirmed. A card success is recorded in payment_events by
 * the device's sale call and the gateway paths; a cash success had no ledger row anywhere. It now
 * gets one immutable non_gateway_payment_events row -- and a card success still gets none here.
 *
 * Runs the REAL route and markOrderPaidConfirmed against the in-memory PostgREST store.
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER = '0000aaaa-0000-4000-8000-000000000501'

let mockDb: InMemoryDb

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
  createServerSupabaseClient: () => mockDb.client(),
}))

function seed() {
  mockDb = new InMemoryDb(
    {
      orders: [
        {
          id: ORDER,
          restaurant_id: RESTAURANT,
          tab_id: null,
          status: 'preparing',
          total: 85.5,
          payment_status: 'pending',
          paycloud_merchant_order_no: null,
          pending_charge_cents: null,
          pending_tip_cents: 0,
          payment_reference: null,
        },
      ],
      non_gateway_payment_events: [],
      payment_events: [],
      audit_logs: [],
    },
    { non_gateway_payment_events: { unique: [['restaurant_id', 'idempotency_key']] } },
  )
}

async function report(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/terminal/orders/[orderId]/payment/route')
  const res = await POST(
    new NextRequest(`http://localhost/api/terminal/orders/${ORDER}/payment`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orderId: ORDER }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  seed()
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

it('cash success: one ledger row with the server-verified amount, no gateway row', async () => {
  const { status, body } = await report({ status: 'success', paymentMethod: 'cash', amount: 85.5, reference: 'PAY-CASH-1' })
  expect(status).toBe(200)
  expect(body.ledger_event).toBe('recorded')
  const rows = mockDb.rows('non_gateway_payment_events')
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    restaurant_id: RESTAURANT,
    origin: 'terminal_order_payment',
    method: 'cash',
    amount_cents: 8550,
    tip_cents: 0,
    order_ids: [ORDER],
    payment_reference: 'PAY-CASH-1',
    actor_attribution: 'terminal_only',
  })
  expect(mockDb.rows('payment_events')).toHaveLength(0)
})

it('a replayed cash callback is ALREADY_PAID and writes no second row', async () => {
  await report({ status: 'success', paymentMethod: 'cash', amount: 85.5, reference: 'PAY-CASH-1' })
  const again = await report({ status: 'success', paymentMethod: 'cash', amount: 85.5, reference: 'PAY-CASH-1' })
  expect(again.status).toBe(409)
  expect(mockDb.rows('non_gateway_payment_events')).toHaveLength(1)
})

it('card success: no row in the non-gateway ledger', async () => {
  const { status, body } = await report({ status: 'success', paymentMethod: 'card', amount: 85.5, reference: 'FT-1' })
  expect(status).toBe(200)
  expect(body.ledger_event).toBeUndefined()
  expect(mockDb.rows('non_gateway_payment_events')).toHaveLength(0)
})
