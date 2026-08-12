/**
 * #223 — reconcileOrphanPayments marked orders paid from a payment_events 'sale' row with no
 * amount comparison at all (`amount: Number(row.total) || 0` used the ORDER's own total, never
 * asking whether the event agreed with it). This asserts the fix: the event's `amount` must
 * agree with the SUM of every order it names, compared once, before anything is written.
 *
 * The sum matters: a payment_events row can name several orders in one `order_ids` array (a
 * tab settle), and comparing the event's single figure against only ONE order's total — or
 * only the currently-unpaid subset, if a sibling is already paid — would manufacture a false
 * mismatch. Both are covered below.
 */
import { reconcileOrphanPayments } from '@/lib/payments/reconcile-orphan-payments'

const markOrderPaidConfirmed = jest.fn(async (..._args: unknown[]) => ({
  claimed: true,
  orderId: 'ord-x',
  tabId: null,
}))
jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: (...args: unknown[]) => markOrderPaidConfirmed(...args),
}))

const safeIssueReceiptForOrder = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: (...args: unknown[]) => safeIssueReceiptForOrder(...args),
}))

type Row = Record<string, unknown>

const bulkUpdates: Array<{ patch: Row; ids: string[] }> = []
const auditInserts: Row[] = []

function makeSupabase(orders: Row[], events: Row[]) {
  return {
    from(table: string) {
      if (table === 'audit_logs') {
        return {
          insert: async (row: Row) => {
            auditInserts.push(row)
            return { error: null }
          },
        }
      }

      const filters: Array<(r: Row) => boolean> = []
      let patch: Row | null = null

      const source = () => {
        if (table === 'payment_events') return events
        if (table === 'orders') return orders
        return [] // receipt_documents: pretend receipts already exist
      }

      const run = () => {
        const matched = source().filter((r) => filters.every((f) => f(r)))
        if (patch) {
          bulkUpdates.push({ patch, ids: matched.map((r) => String(r.id)) })
          for (const r of matched) Object.assign(r, patch)
        }
        return matched
      }

      const builder: Record<string, unknown> = {
        select: () => builder,
        update: (p: Row) => {
          patch = p
          return builder
        },
        eq: (col: string, val: unknown) => {
          filters.push((r) => String(r[col] ?? '') === String(val))
          return builder
        },
        neq: (col: string, val: unknown) => {
          filters.push((r) => String(r[col] ?? '') !== String(val))
          return builder
        },
        gte: () => builder,
        order: () => builder,
        limit: () => builder,
        is: (col: string) => {
          filters.push((r) => r[col] == null)
          return builder
        },
        in: (col: string, vals: unknown[]) => {
          const wanted = vals.map(String)
          filters.push((r) => wanted.includes(String(r[col] ?? '')))
          return builder
        },
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: run(), error: null }).then(resolve),
      }
      return builder
    },
  }
}

describe('#223 — reconcileOrphanPayments refuses a disagreeing or absent event amount', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    bulkUpdates.length = 0
    auditInserts.length = 0
  })

  test('agreeing amount: applied exactly as before (control)', async () => {
    const orders: Row[] = [
      { id: 'ord-1', restaurant_id: 'rest-1', total: 42.5, payment_method: 'card', payment_status: 'pending' },
    ]
    const events: Row[] = [
      { id: 'evt-1', event_type: 'sale', business_order_no: 'FT1', order_ids: ['ord-1'], amount: 42.5, created_at: '2026-08-03T11:00:00.000Z' },
    ]

    const result = await reconcileOrphanPayments(makeSupabase(orders, events) as never)
    expect(result.markedPaidIds).toContain('ord-1')
    expect(result.amountMismatchCount).toBe(0)
    expect(auditInserts.find((a) => a.action === 'payment.verification_uncertain')).toBeUndefined()
  })

  test('disagreeing amount: refused, order left pending, both figures recorded', async () => {
    const orders: Row[] = [
      { id: 'ord-1', restaurant_id: 'rest-1', total: 42.5, payment_method: 'card', payment_status: 'pending' },
    ]
    const events: Row[] = [
      { id: 'evt-1', event_type: 'sale', business_order_no: 'FT1', order_ids: ['ord-1'], amount: 20, created_at: '2026-08-03T11:00:00.000Z' },
    ]

    const result = await reconcileOrphanPayments(makeSupabase(orders, events) as never)
    expect(result.markedPaidIds).not.toContain('ord-1')
    expect(result.amountMismatchCount).toBe(1)
    expect(result.amountMismatchIds).toEqual(['ord-1'])
    expect(bulkUpdates.some((u) => u.patch.payment_status === 'paid')).toBe(false)

    const uncertain = auditInserts.find((a) => a.action === 'payment.verification_uncertain')
    expect(uncertain).toBeDefined()
    expect((uncertain!.metadata as Row).gatewayAmount).toBe(20)
    expect((uncertain!.metadata as Row).expectedAmount).toBe(42.5)

    const mismatch = auditInserts.find((a) => a.action === 'payment.amount_mismatch')
    expect(mismatch).toBeDefined()
  })

  test('absent amount: refused, no amount_mismatch row (never checked, not disagreed)', async () => {
    const orders: Row[] = [
      { id: 'ord-1', restaurant_id: 'rest-1', total: 42.5, payment_method: 'card', payment_status: 'pending' },
    ]
    const events: Row[] = [
      { id: 'evt-1', event_type: 'sale', business_order_no: 'FT1', order_ids: ['ord-1'], created_at: '2026-08-03T11:00:00.000Z' },
    ]

    const result = await reconcileOrphanPayments(makeSupabase(orders, events) as never)
    expect(result.markedPaidIds).not.toContain('ord-1')
    expect(result.amountMismatchCount).toBe(1)
    expect(auditInserts.find((a) => a.action === 'payment.amount_mismatch')).toBeUndefined()
    expect(auditInserts.find((a) => a.action === 'payment.verification_uncertain')).toBeDefined()
  })

  test('SUM, not a single row: a two-order event agrees on the total though neither order alone matches it', async () => {
    const orders: Row[] = [
      { id: 'ord-1', restaurant_id: 'rest-1', total: 30, payment_method: 'card', payment_status: 'pending' },
      { id: 'ord-2', restaurant_id: 'rest-1', total: 12.5, payment_method: 'card', payment_status: 'pending' },
    ]
    const events: Row[] = [
      { id: 'evt-1', event_type: 'sale', business_order_no: 'FT1', order_ids: ['ord-1', 'ord-2'], amount: 42.5, created_at: '2026-08-03T11:00:00.000Z' },
    ]

    const result = await reconcileOrphanPayments(makeSupabase(orders, events) as never)
    expect(result.markedPaidIds.sort()).toEqual(['ord-1', 'ord-2'])
    expect(result.amountMismatchCount).toBe(0)
  })

  test('an already-paid sibling does not shrink the expected total for the still-unpaid order', async () => {
    // event.amount was for BOTH orders together (52.5). ord-1 is already paid through another
    // caller; comparing the event only against the unpaid subset (ord-2's 10) would read as a
    // mismatch even though the event and the full order set agree.
    const orders: Row[] = [
      { id: 'ord-1', restaurant_id: 'rest-1', total: 42.5, payment_method: 'card', payment_status: 'paid' },
      { id: 'ord-2', restaurant_id: 'rest-1', total: 10, payment_method: 'card', payment_status: 'pending' },
    ]
    const events: Row[] = [
      { id: 'evt-1', event_type: 'sale', business_order_no: 'FT1', order_ids: ['ord-1', 'ord-2'], amount: 52.5, created_at: '2026-08-03T11:00:00.000Z' },
    ]

    const result = await reconcileOrphanPayments(makeSupabase(orders, events) as never)
    expect(result.amountMismatchCount).toBe(0)
    expect(result.markedPaidIds).toEqual(['ord-2'])
  })
})
