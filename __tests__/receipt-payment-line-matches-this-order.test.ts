/**
 * What does a receipt's PAYMENT LINE assert, and is it about THIS order? (#237, #226, #234)
 *
 * WHY THIS SUITE EXISTS. `issueReceiptForOrder` had no test at all — `issue-receipt.test.ts`
 * covers only the pure `toLineItem`. Everything else in that function, including which figure
 * ends up on the customer's payment line, was unasserted, on a money-facing path that three open
 * issues turn on.
 *
 * THE RULE IS NOT EXTRACTED ANYWHERE, so these drive the REAL `issueReceiptForOrder` through a
 * fake Supabase client rather than re-deriving the choice (#205: a test carrying its own copy of
 * the rule stays green against a reverted call site). What is asserted is the snapshot the
 * function actually writes.
 *
 * THE SHAPE THAT MATTERS. `payment_events.order_ids` is `uuid[]`, and
 * 20260705340000_payment_events_order_ids_array.sql states it plainly: "Tab settlement:
 * order_ids = full set of orders covered by that payment." ONE event, ONE amount, N orders. So an
 * event's amount is the whole settle and is not this order's payment. issueReceipt.ts:253-258
 * matches events by `.contains('order_ids', [orderId])` and :283 copies `event.amount` verbatim,
 * with no proration — which is #237.
 */
import { issueReceiptForOrder, type ReceiptSnapshot } from '@/lib/receipts/issueReceipt'

const RESTAURANT_ID = 'rest-1'
const ORDER_ID = 'order-A'
const SIBLING_ONE = 'order-B'
const SIBLING_TWO = 'order-C'

/** This order is N$40.56. The tab settle that paid it was N$120.00 across three orders. */
const THIS_ORDER_TOTAL = 40.56
const WHOLE_SETTLE_AMOUNT = 120.0

type Row = Record<string, any>

let orders: Row[] = []
let restaurants: Row[] = []
let billingProfiles: Row[] = []
let paymentEvents: Row[] = []
let receiptDocuments: Row[] = []
/** The row the function actually inserted, which is what every assertion below reads. */
let inserted: Row | null = null

/**
 * Implements only the operators issueReceiptForOrder uses, and implements them for real —
 * `.contains` genuinely tests array membership, so a change to how events are matched is
 * visible here rather than mocked away.
 */
function makeClient() {
  const tables: Record<string, Row[]> = {
    orders,
    restaurants,
    restaurant_billing_profiles: billingProfiles,
    payment_events: paymentEvents,
    receipt_documents: receiptDocuments,
  }

  return {
    rpc: async (fn: string) => {
      if (fn !== 'generate_document_number') throw new Error(`unexpected rpc ${fn}`)
      return { data: 'RCT-000187', error: null }
    },
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      let pending: Row | null = null

      const rows = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r)))

      const api: Record<string, any> = {
        select: () => api,
        eq(col: string, val: unknown) {
          preds.push((r) => r[col] === val)
          return api
        },
        contains(col: string, vals: unknown[]) {
          preds.push((r) => vals.every((v) => (r[col] ?? []).includes(v)))
          return api
        },
        insert(next: Row) {
          pending = { ...next, id: 'doc-1', issued_at: '2026-08-11T18:00:00.000Z' }
          inserted = pending
          receiptDocuments.push(pending)
          return api
        },
        async single() {
          if (pending) return { data: pending, error: null }
          const found = rows()
          if (found.length !== 1) return { data: null, error: { message: 'not found' } }
          return { data: { ...found[0] }, error: null }
        },
        async maybeSingle() {
          const found = rows()
          return { data: found.length === 1 ? { ...found[0] } : null, error: null }
        },
        then(resolve: (r: { data: Row[]; error: null }) => unknown) {
          return Promise.resolve(resolve({ data: rows().map((r) => ({ ...r })), error: null }))
        },
      }
      return api
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeClient(),
}))

function seed({ withSaleEvent }: { withSaleEvent: 'none' | 'single-order' | 'whole-tab' }) {
  orders.length = 0
  restaurants.length = 0
  billingProfiles.length = 0
  paymentEvents.length = 0
  receiptDocuments.length = 0
  inserted = null

  orders.push({
    id: ORDER_ID,
    restaurant_id: RESTAURANT_ID,
    payment_status: 'paid',
    payment_method: 'card',
    payment_reference: 'REF-1',
    paycloud_merchant_order_no: null,
    paid_at: '2026-08-11T17:55:00.000Z',
    subtotal: 35.27,
    tax: 5.29,
    total: THIS_ORDER_TOTAL,
    items: [{ name: 'Chicken burger', quantity: 1, unitPrice: 25.0, subtotal: 25.0 }],
    customer_name: null,
    table_number: 7,
    channel: 'table',
    order_instructions: null,
  })
  restaurants.push({ id: RESTAURANT_ID, name: 'Riviera', address: null, currency: 'NAD' })

  if (withSaleEvent === 'single-order') {
    paymentEvents.push({
      restaurant_id: RESTAURANT_ID,
      event_type: 'sale',
      order_ids: [ORDER_ID],
      amount: THIS_ORDER_TOTAL,
      transaction_id: 'TXN-1',
      business_order_no: 'BON-1',
      created_at: '2026-08-11T17:55:00.000Z',
    })
  }
  if (withSaleEvent === 'whole-tab') {
    paymentEvents.push({
      restaurant_id: RESTAURANT_ID,
      event_type: 'sale',
      order_ids: [ORDER_ID, SIBLING_ONE, SIBLING_TWO],
      amount: WHOLE_SETTLE_AMOUNT,
      transaction_id: 'TXN-1',
      business_order_no: 'BON-1',
      created_at: '2026-08-11T17:55:00.000Z',
    })
  }
}

function snapshotOf(): ReceiptSnapshot {
  if (!inserted) throw new Error('no receipt_documents row was inserted')
  return inserted.snapshot_json as ReceiptSnapshot
}

describe('#237 — the payment line must be about THIS order', () => {
  it('equals the order total when the sale event covers only this order', async () => {
    seed({ withSaleEvent: 'single-order' })
    await issueReceiptForOrder(ORDER_ID)
    const snapshot = snapshotOf()

    expect(snapshot.payments).toHaveLength(1)
    expect(snapshot.payments[0].amount).toBe(THIS_ORDER_TOTAL)
    expect(snapshot.totals.grand_total).toBe(THIS_ORDER_TOTAL)
  })

  it('equals the order total when NO sale event exists yet — the happy-path settle', async () => {
    /*
     * This is the branch that keeps #237 off the ordinary settle path, and nothing pinned it.
     * The terminal awaits settleTab (which issues the receipts) BEFORE its fire-and-forget
     * recordSaleEvent, so at issuance time there is no event and issueReceipt.ts:291-303
     * synthesizes the line from the order's own grand_total. Anyone "simplifying" that fallback
     * away would make #237 fire on every settle instead of only on late issuance.
     */
    seed({ withSaleEvent: 'none' })
    await issueReceiptForOrder(ORDER_ID)
    const snapshot = snapshotOf()

    expect(snapshot.payments).toHaveLength(1)
    expect(snapshot.payments[0].amount).toBe(THIS_ORDER_TOTAL)
  })

  /*
   * CONTROL FOR THE test.failing BELOW, and the reason it is not one-sided.
   *
   * `test.failing` passes whenever its body throws — including when the harness breaks and the
   * function never completes, which is the `Tests: 0 total` trap in another costume. This test
   * drives the IDENTICAL multi-order fixture and asserts the function ran to completion and
   * produced a well-formed document. So the failure below can only come from the payment
   * assertion itself, not from a broken fixture.
   */
  it('CONTROL: the multi-order fixture really does produce a complete receipt', async () => {
    seed({ withSaleEvent: 'whole-tab' })
    const doc = await issueReceiptForOrder(ORDER_ID)
    const snapshot = snapshotOf()

    expect(doc.document_number).toBe('RCT-000187')
    expect(snapshot.totals.grand_total).toBe(THIS_ORDER_TOTAL)
    expect(snapshot.line_items).toHaveLength(1)
    expect(snapshot.payments).toHaveLength(1)
    // Deliberately NOT asserting the amount here. Pinning today's wrong value would make the
    // suite defend the defect (#131), which is the failure mode this file exists to avoid.
  })

  /*
   * #237 ITSELF. Written as the assertion that SHOULD hold, and marked `failing` because it does
   * not hold today — so the suite stays honest without pinning the defect.
   *
   * Measured before marking, driving the same fixture as a plain `it`:
   *   expect(received).toBe(expected)   Expected: 40.56   Received: 120
   * The received value is the WHOLE SETTLE, unprorated, on a receipt whose own Total reads 40.56.
   *
   * WHEN #237 IS FIXED THIS TEST WILL FAIL — that is the point. `test.failing` errors once the
   * body passes, so whoever fixes it is forced to drop the marker rather than leave a stale
   * expectation behind.
   */
  it.failing('#237: does NOT yet equal the order total for a multi-order tab settle', async () => {
    seed({ withSaleEvent: 'whole-tab' })
    await issueReceiptForOrder(ORDER_ID)
    const snapshot = snapshotOf()

    expect(snapshot.payments[0].amount).toBe(THIS_ORDER_TOTAL)
  })

  it.failing('#237: the payments never sum above what the receipt says was owed', async () => {
    // The weaker invariant, and the one worth keeping after #237 lands: whatever the payment
    // lines say, they cannot exceed the total this receipt claims. Also currently false.
    seed({ withSaleEvent: 'whole-tab' })
    await issueReceiptForOrder(ORDER_ID)
    const snapshot = snapshotOf()

    const paid = snapshot.payments.reduce((sum, p) => sum + p.amount, 0)
    expect(paid).toBeLessThanOrEqual(snapshot.totals.grand_total)
  })
})
