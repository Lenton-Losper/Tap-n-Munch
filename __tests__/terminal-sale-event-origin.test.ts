/**
 * Sprint 2026-09-29 brief, TASK 7 — the device sale-event row says it is the device's report.
 *
 * POST /api/terminal/payment-events/sale records the device's `amount` and `order_ids` even when the
 * amount disagrees with the intent (refusing a real charge is worse). The row now carries
 * origin='terminal_device' and how the amount compared, so no reader -- the orphan cron above all --
 * can take it for the gateway's figure. Runs the REAL route against the in-memory store.
 */
import { OTHER_VENUE, VENUE, audits, intent, makeDb, order } from './helpers/reconcile-harness'

const A = 'aaaaaaaa-0000-4000-8000-00000000002a'
const REF = 'FT-SALE-1'

let mockHarness: ReturnType<typeof makeDb>
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => mockHarness.client,
}))
jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({ restaurantId: VENUE, terminalId: 'term-1' }),
  validateTerminalRecord: async () => undefined,
}))
jest.mock('@/lib/receipts/issueReceipt', () => ({
  issueReceiptForOrder: async () => undefined,
}))

type Row = Record<string, unknown>

async function report(amount: number) {
  const { POST } = await import('@/app/api/terminal/payment-events/sale/route')
  const res = await POST(
    new Request('https://staging.test/api/terminal/payment-events/sale', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ order_ids: [A], business_order_no: REF, transaction_id: 'TXN-S', amount }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Row }
}

it('a matching report is recorded as the device\'s, matched against the intent', async () => {
  mockHarness = makeDb({
    orders: [order(A)],
    terminal_payment_intents: [intent({ merchant_order_no: REF, amount_cents: 10000, order_ids: [A] })],
  })
  const r = await report(100)
  expect(r.status).toBe(200)
  const row = mockHarness.db.rows('payment_events')[0]
  expect(row).toMatchObject({ origin: 'terminal_device', device_amount_check: 'matched_intent', amount: 100 })
})

it('a manipulated amount is recorded -- as the device\'s mismatched report, never as authoritative', async () => {
  mockHarness = makeDb({
    orders: [order(A)],
    terminal_payment_intents: [intent({ merchant_order_no: REF, amount_cents: 10000, order_ids: [A] })],
  })
  const r = await report(1)
  expect(r.status).toBe(200)
  const row = mockHarness.db.rows('payment_events')[0]
  expect(row).toMatchObject({ origin: 'terminal_device', device_amount_check: 'mismatch_intent', amount: 1 })
  expect(audits(mockHarness.db, 'payment.sale_amount_mismatch')).toHaveLength(1)
})

it('another venue\'s intent with the same reference is never the comparison basis', async () => {
  mockHarness = makeDb({
    orders: [order(A)],
    terminal_payment_intents: [
      intent({ merchant_order_no: REF, amount_cents: 100, order_ids: [A], restaurant_id: OTHER_VENUE }),
    ],
  })
  const r = await report(100)
  expect(r.status).toBe(200)
  // Compared against the order total (N$100), not the foreign intent's N$1.
  expect(mockHarness.db.rows('payment_events')[0].device_amount_check).toBe('matched_order_totals')
})

describe('GET: the refund cap is a server figure, never the device report', () => {
  async function refundable() {
    const { GET } = await import('@/app/api/terminal/payment-events/sale/route')
    const res = await GET(
      new Request(`https://staging.test/api/terminal/payment-events/sale?order_id=${A}`, {
        headers: { authorization: 'Bearer t' },
      }),
    )
    return { status: res.status, body: (await res.json()) as Row }
  }
  const saleRow = (over: Row): Row => ({
    id: 'pe-sale',
    restaurant_id: VENUE,
    event_type: 'sale',
    business_order_no: REF,
    origin_business_order_no: REF,
    idempotency_key: REF,
    order_ids: [A],
    currency: 'NAD',
    created_at: '2026-09-29T10:00:00.000Z',
    ...over,
  })

  it('a server-verified sale caps at its own amount, less refunds already made', async () => {
    mockHarness = makeDb({
      orders: [order(A)],
      payment_events: [
        saleRow({ amount: 100, origin: null, raw_gateway_response: { recorded_by: 'server' } }),
        { id: 'pe-r', restaurant_id: VENUE, event_type: 'refund_succeeded', origin_business_order_no: REF, amount: 30, order_ids: [A] },
      ],
    })
    const r = await refundable()
    expect(r.body).toMatchObject({ amount: 100, refunded_so_far: 30, remaining: 70, refundable_basis: 'verified_sale' })
  })

  it('a device row that over-reported is capped at the INTENT amount, not its own', async () => {
    mockHarness = makeDb({
      orders: [order(A)],
      payment_events: [saleRow({ amount: 500, origin: 'terminal_device', device_amount_check: 'mismatch_intent' })],
      terminal_payment_intents: [intent({ merchant_order_no: REF, amount_cents: 10000, order_ids: [A] })],
    })
    const r = await refundable()
    expect(r.body).toMatchObject({ amount: 100, remaining: 100, refundable_basis: 'intent' })
  })

  it('a device mismatch row with no intent has no verified figure and is refused', async () => {
    mockHarness = makeDb({
      orders: [order(A)],
      payment_events: [saleRow({ amount: 500, origin: 'terminal_device', device_amount_check: 'mismatch_order_totals' })],
    })
    const r = await refundable()
    expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: 'SALE_AMOUNT_UNVERIFIED' })
  })
})
