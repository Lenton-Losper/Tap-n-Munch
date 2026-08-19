/**
 * #239 — the reconcile sweep's BULK path must leave an audit trail.
 *
 * `reconcileOrphanPayments` has three subsets in one run, on a scheduled production cron:
 *
 *   auto-cancelled     -> markOrderPaidConfirmed, full audit entry
 *   amount mismatch    -> payment.verification_uncertain audit entry
 *   plain (the bulk)   -> updated payment_status/status DIRECTLY, and wrote NOTHING
 *
 * Same sweep, same run, three subsets, two evidentiary standards. An order marked paid by the
 * bulk path left no record of having been marked — exactly the record anyone reconciling a
 * disputed charge would go looking for.
 */
export {} // module scope: these specs share a global scope otherwise

type Row = Record<string, unknown>

const RESTAURANT_UUID = 'aaaaaaaa-0000-4000-8000-000000000001'
const ORDER_A = 'bbbbbbbb-0000-4000-8000-00000000000a'
const ORDER_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

const mockAudits: Row[] = []
const mockUpdates: Row[] = []

/** A settlement whose amount MATCHES, so the sweep reaches the bulk path rather than bailing. */
const eventRows: Row[] = [
  {
    id: 'evt-1',
    business_order_no: 'BON-1',
    order_ids: [ORDER_A, ORDER_B],
    amount: 60,
    created_at: new Date().toISOString(),
  },
]

/** Two unpaid orders, neither auto-cancelled — so both land in `plain`. */
const orderRows: Row[] = [
  { id: ORDER_A, restaurant_id: RESTAURANT_UUID, total: 30, payment_status: 'pending', cancellation_reason: null, cancelled_at: null, paycloud_merchant_order_no: null },
  { id: ORDER_B, restaurant_id: RESTAURANT_UUID, total: 30, payment_status: 'pending', cancellation_reason: null, cancelled_at: null, paycloud_merchant_order_no: null },
]

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: async () => ({ ok: true }),
}))

function makeSupabase() {
  return {
    from: (table: string) => {
      const state = { table, op: 'select' as string, patch: null as Row | null }
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        update: (patch: Row) => {
          state.op = 'update'
          state.patch = patch
          return b
        },
        insert: async (row: Row | Row[]) => {
          if (state.table === 'audit_logs') {
            // The fix inserts an ARRAY (one row per order); siblings insert a single object.
            for (const r of Array.isArray(row) ? row : [row]) mockAudits.push(r)
          }
          return { data: null, error: null }
        },
        eq: () => b,
        in: () => b,
        is: () => b,
        gte: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (state.table === 'orders' && state.op === 'update') {
            mockUpdates.push(state.patch as Row)
            return resolve({ data: null, error: null })
          }
          if (state.table === 'payment_events') return resolve({ data: eventRows, error: null })
          if (state.table === 'orders') return resolve({ data: orderRows, error: null })
          return resolve({ data: [], error: null })
        },
      })
      return b
    },
  }
}

beforeEach(() => {
  mockAudits.length = 0
  mockUpdates.length = 0
})

describe('the bulk mark-paid path', () => {
  const run = async () => {
    const { reconcileOrphanPayments } = require('@/lib/payments/reconcile-orphan-payments')
    return reconcileOrphanPayments(makeSupabase() as never, {})
  }

  it('still marks the orders paid — the control', async () => {
    // Without this, "writes an audit row" could be satisfied by a sweep that stopped working.
    await run()
    expect(mockUpdates.some((u) => u.payment_status === 'paid')).toBe(true)
  })

  it('writes an audit row for the bulk path — the defect, stated as a rule', async () => {
    await run()
    const rows = mockAudits.filter((a) => a.action === 'payment.marked_paid_by_reconcile')
    expect(rows.length).toBeGreaterThan(0)
  })

  it('writes ONE row per order, not one per batch', async () => {
    // A dispute is about a single order. A batch-shaped row would make the reconciler read the
    // whole sweep to find out whether their order was in it.
    await run()
    const rows = mockAudits.filter((a) => a.action === 'payment.marked_paid_by_reconcile')
    const ids = rows.map((r) => r.entity_id).sort()
    expect(ids).toEqual([ORDER_A, ORDER_B].sort())
  })

  it('carries each order OWN restaurant, not one borrowed from the loop above', async () => {
    await run()
    const rows = mockAudits.filter((a) => a.action === 'payment.marked_paid_by_reconcile')
    for (const r of rows) expect(r.restaurant_id).toBe(RESTAURANT_UUID)
  })

  it('records amountVerified: false, so it cannot read as a verified settlement', async () => {
    // This subset reaches the bulk path precisely because no per-order amount comparison was
    // made. Silence about that would let the row be mistaken for a confirmed one.
    await run()
    const row = mockAudits.find((a) => a.action === 'payment.marked_paid_by_reconcile')
    expect((row?.metadata as Row)?.amountVerified).toBe(false)
  })

  it('names the payment event, which is what a reconciliation starts from', async () => {
    await run()
    const row = mockAudits.find((a) => a.action === 'payment.marked_paid_by_reconcile')
    expect((row?.metadata as Row)?.paymentEventId).toBe('evt-1')
    expect((row?.metadata as Row)?.businessOrderNo).toBe('BON-1')
  })
})
