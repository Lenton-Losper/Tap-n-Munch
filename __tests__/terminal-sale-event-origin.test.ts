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
