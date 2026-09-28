/**
 * N3 (Sprint 2026-09-28): a charge covering an order that ANOTHER payment already paid is never
 * absorbed in silence.
 *
 *   terminal A prepares X+Y and launches the reader; terminal B takes cash for Y; A's card is
 *   charged X+Y. The webhook settled X and skipped Y -- Y paid twice, no refused_already_paid row.
 *
 * Three layers, three tests:
 *   1. the rule itself (paidByAnotherPayment), on the SAME cases the SQL mirror is asserted on in
 *      supabase/tests/settlement-rpc.test.sql `_t_paid_elsewhere`;
 *   2. prepare-payment refuses before the charge when any order in the set is not claimable;
 *   3. the settlement helper surfaces the RPC's hold as a non-retryable `paid_elsewhere`, and the
 *      webhook's all-already-paid ACK leaves evidence.
 */
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { AmendFixture } from './helpers/amend-fixture'
import {
  paidByAnotherPayment,
  recordOrdersPaidByAnotherPayment,
} from '@/lib/payments/paid-by-another-payment'

const RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

let mockDb: InMemoryDb
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
  ensureTerminalMerchantOrderNo: async () => ({ merchantOrderNo: 'FT1700000000000001', created: true }),
}))
jest.mock('@/lib/payments/payment-intents', () => ({
  ensureOrdersIntent: async (_s: unknown, params: Record<string, unknown>) => {
    mockIntentCalls.push(params)
    return { id: 'intent-1' }
  },
}))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: async () => undefined,
}))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => mockDb.client(),
}))

beforeEach(() => {
  mockIntentCalls.length = 0
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('the rule: paid by THIS charge, or by another payment', () => {
  const card = { reference: 'MO-1', method: 'card' as const }

  it('cash taken on another terminal is another payment', () => {
    const rows = [
      { id: 'x', payment_status: 'pending', paycloud_merchant_order_no: 'MO-1' },
      { id: 'y', payment_status: 'paid', payment_method: 'cash', payment_reference: 'PAY-CASH-B' },
    ]
    expect(paidByAnotherPayment(rows, card).map((r) => r.id)).toEqual(['y'])
  })

  it('cash with no reference recorded is still another payment (the method alone decides)', () => {
    const rows = [{ id: 'y', payment_status: 'paid', payment_method: 'cash', payment_reference: null }]
    expect(paidByAnotherPayment(rows, card).map((r) => r.id)).toEqual(['y'])
  })

  it('a lead paid in CASH still carries the minted merchant number -- and is still another payment', () => {
    const rows = [
      { id: 'x', payment_status: 'paid', payment_method: 'cash', payment_reference: 'PAY-CASH-B', paycloud_merchant_order_no: 'MO-1' },
    ]
    expect(paidByAnotherPayment(rows, card).map((r) => r.id)).toEqual(['x'])
  })

  it('another card charge (different merchant number) is another payment', () => {
    const rows = [
      { id: 'y', payment_status: 'paid', payment_method: 'card', payment_reference: 'MO-2', paycloud_merchant_order_no: 'MO-2' },
    ]
    expect(paidByAnotherPayment(rows, card).map((r) => r.id)).toEqual(['y'])
  })

  it('NEGATIVE CONTROL: a replay of this charge is not another payment', () => {
    const rows = [
      { id: 'x', payment_status: 'paid', payment_method: 'card', payment_reference: 'MO-1', paycloud_merchant_order_no: 'MO-1' },
      { id: 'y', payment_status: 'paid', payment_method: 'card', payment_reference: 'MO-1' },
    ]
    expect(paidByAnotherPayment(rows, card)).toEqual([])
  })

  it("NEGATIVE CONTROL: the device's own tab-settle card claim is not another payment", () => {
    const rows = [
      { id: 'x', payment_status: 'paid', payment_method: 'card', payment_reference: 'PAY-TAB-1', paycloud_merchant_order_no: 'MO-1' },
      { id: 'y', payment_status: 'paid', payment_method: 'card', payment_reference: 'PAY-TAB-1' },
    ]
    expect(paidByAnotherPayment(rows, card)).toEqual([])
  })

  it('NEGATIVE CONTROL: a legacy paid row with nothing recorded is not reported', () => {
    expect(paidByAnotherPayment([{ id: 'x', payment_status: 'paid' }], card)).toEqual([])
  })
})

describe('prepare-payment refuses before the charge when ANY order is not claimable', () => {
  async function prepare(orderId: string, orderIds: string[]) {
    const { POST } = await import('@/app/api/terminal/orders/[orderId]/prepare-payment/route')
    const res = await POST(
      new NextRequest(`http://localhost/api/terminal/orders/${orderId}/prepare-payment`, {
        method: 'POST',
        body: JSON.stringify({ order_ids: orderIds }),
      }),
      { params: Promise.resolve({ orderId }) },
    )
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  function tab(siblingOverrides: Record<string, unknown>) {
    const f = new AmendFixture('0000cccc-0000-4000-8000-000000000031')
    const x = f.place([{ name: 'Burger', quantity: 1, total: 220 }])
    const y = f.place([{ name: 'Steak', quantity: 1, total: 500 }], siblingOverrides)
    mockDb = new InMemoryDb({
      orders: f.orders.map((o) => ({ ...o, restaurant_id: RESTAURANT, pending_settlement_id: null })),
      order_lines: f.lines.map((l) => ({ ...l, restaurant_id: RESTAURANT })),
      order_line_allocations: [],
      order_line_allocation_settlements: [],
    })
    return { x: x.id, y: y.id }
  }
  const pendingOf = (id: string) =>
    mockDb.rows('orders').find((o) => String(o.id) === id)?.pending_charge_cents ?? null

  it.each([
    ['paid', { payment_status: 'paid', status: 'completed' }],
    ['cancelled', { payment_status: 'cancelled', status: 'cancelled' }],
    ['held (amount_mismatch_hold)', { payment_status: 'amount_mismatch_hold' }],
    ['held (verification_unavailable_hold)', { payment_status: 'verification_unavailable_hold' }],
  ])('a %s SIBLING refuses the whole charge, writing nothing', async (_label, overrides) => {
    const { x, y } = tab(overrides)
    const { status, body } = await prepare(x, [x, y])
    expect(status).toBe(409)
    expect(body.code).toBe('SETTLEMENT_SET_NOT_CLAIMABLE')
    expect((body.orders as Array<{ order_id: string }>).map((o) => o.order_id)).toEqual([y])
    expect(pendingOf(x)).toBeNull()
    expect(mockIntentCalls).toHaveLength(0)
  })

  it('control: two owing orders are charged together', async () => {
    const { x, y } = tab({})
    const { status, body } = await prepare(x, [x, y])
    expect(status).toBe(200)
    expect(body.chargeCents).toBe(72000)
  })
})

describe('the settlement and the webhook surface a charge over an order paid elsewhere', () => {
  it("settleWholeOrderPayment maps the RPC's hold to a non-retryable `paid_elsewhere`", async () => {
    mockDb = new InMemoryDb({
      orders: [
        {
          id: 'x', restaurant_id: RESTAURANT, tab_id: null, total: 220, payment_status: 'pending',
          payment_method: null, cancellation_reason: null, cancelled_at: null,
          pending_charge_cents: 22000, pending_tip_cents: 0, pending_settlement_id: null,
        },
      ],
    })
    const base = mockDb.client()
    const client = {
      ...base,
      rpc: async () => ({
        data: { ok: false, reason: 'order_paid_by_other_payment', held_order_ids: ['x'], claimed_order_ids: [] },
        error: null,
      }),
    }
    const { settleWholeOrderPayment } = await import('@/lib/payments/settle-whole-order-payment')
    const result = await settleWholeOrderPayment(client as never, {
      restaurantId: RESTAURANT,
      leadOrderIds: ['x'],
      merchantOrderNo: 'MO-1',
      gatewayAmount: 220,
      paymentMethod: 'card',
      source: 'test',
      mismatchSource: 'paycloud_webhook',
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('paid_elsewhere')
  })

  it('the webhook treats `paid_elsewhere` as permanent on both legs', () => {
    // The permanence decision is one expression shared by both legs (applyGatewayConfirmedOrders);
    // asserted on the source because the route needs a signed payload and a Finatic stub to reach.
    const src = readFileSync('app/api/webhooks/paycloud/route.ts', 'utf8')
    expect(src).toMatch(/settled\.reason === 'paid_elsewhere'/)
    expect((src.match(/recordOrdersPaidByAnotherPayment\(/g) ?? []).length).toBe(2)
  })

  it("the all-already-paid ACK records a refused_already_paid row per order another payment paid", async () => {
    mockDb = new InMemoryDb({
      orders: [
        { id: 'x', restaurant_id: RESTAURANT, payment_status: 'paid', payment_method: 'cash', payment_reference: 'PAY-CASH-B', paycloud_merchant_order_no: 'MO-1', total: 220, pending_charge_cents: 22000 },
        { id: 'y', restaurant_id: RESTAURANT, payment_status: 'paid', payment_method: 'cash', payment_reference: 'PAY-CASH-B', paycloud_merchant_order_no: null, total: 500, pending_charge_cents: 50000 },
      ],
      audit_logs: [],
    })
    const out = await recordOrdersPaidByAnotherPayment(mockDb.client() as never, {
      orderIds: ['x', 'y'],
      reference: 'MO-1',
      source: 'test',
      gatewayConfirmed: true,
    })
    expect(out.recorded.sort()).toEqual(['x', 'y'])
    const rows = mockDb.rows('audit_logs')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ action: 'payment.refused_already_paid', entity_type: 'order' })
    expect(rows.find((r) => r.entity_id === 'y')!.metadata).toMatchObject({
      distinctGatewayTransaction: true,
      existingReference: 'PAY-CASH-B',
      existingMethod: 'cash',
      attemptedReference: 'MO-1',
      orderChargeCents: 50000,
    })
  })

  it('NEGATIVE CONTROL: the ACK for a replay of this charge records nothing', async () => {
    mockDb = new InMemoryDb({
      orders: [
        { id: 'x', restaurant_id: RESTAURANT, payment_status: 'paid', payment_method: 'card', payment_reference: 'MO-1', paycloud_merchant_order_no: 'MO-1', total: 220 },
      ],
      audit_logs: [],
    })
    const out = await recordOrdersPaidByAnotherPayment(mockDb.client() as never, {
      orderIds: ['x'],
      reference: 'MO-1',
      source: 'test',
      gatewayConfirmed: true,
    })
    expect(out.recorded).toEqual([])
    expect(mockDb.rows('audit_logs')).toHaveLength(0)
  })
})
