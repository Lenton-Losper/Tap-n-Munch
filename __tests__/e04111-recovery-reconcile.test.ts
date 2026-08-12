/**
 * PR1 — reconcileOrphanPayments must not produce contradictory rows.
 *
 * Its bulk update sets payment_status/status but leaves cancelled_at and
 * cancellation_reason in place, so recovering an auto-cancelled order produced a
 * completed + paid + cancellation_reason row and told nobody. Auto-cancelled orders now
 * go through markOrderPaidConfirmed instead; everything else keeps the bulk path.
 */
import { reconcileOrphanPayments } from '@/lib/payments/reconcile-orphan-payments'

const markOrderPaidConfirmed = jest.fn()
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
      let inIds: string[] = []

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
          inIds = vals.map(String)
          filters.push((r) => inIds.includes(String(r[col] ?? '')))
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

describe('reconcileOrphanPayments recovery of auto-cancelled orders', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    bulkUpdates.length = 0
    auditInserts.length = 0
    markOrderPaidConfirmed.mockResolvedValue({ claimed: true, orderId: 'ord-cancelled', tabId: null })
  })

  test('auto-cancelled order goes through markOrderPaidConfirmed, NOT the bulk update', async () => {
    const orders: Row[] = [
      {
        id: 'ord-cancelled',
        restaurant_id: 'rest-1',
        total: 42.5,
        payment_method: 'card',
        payment_status: 'cancelled',
        cancellation_reason: 'auto_cancelled_e04111_persistent',
        cancelled_at: '2026-08-03T10:00:00.000Z',
        paycloud_merchant_order_no: 'FT149',
      },
      {
        id: 'ord-plain',
        restaurant_id: 'rest-1',
        total: 10,
        payment_method: 'card',
        payment_status: 'pending',
        cancellation_reason: null,
        cancelled_at: null,
        paycloud_merchant_order_no: 'FT150',
      },
    ]
    const events: Row[] = [
      {
        id: 'evt-1',
        event_type: 'sale',
        business_order_no: 'FT149',
        order_ids: ['ord-cancelled', 'ord-plain'],
        amount: 52.5, // #223: must equal the sum of the named orders' totals (42.5 + 10) or the event is refused, not recovered.
        created_at: '2026-08-03T11:00:00.000Z',
      },
    ]

    const result = await reconcileOrphanPayments(makeSupabase(orders, events) as never)
    console.log('RECONCILE_RESULT', JSON.stringify(result, null, 2))

    expect(result.recoveredAfterAutoCancel).toBe(1)
    expect(result.recoveredAfterAutoCancelIds).toEqual(['ord-cancelled'])

    // Auto-cancelled order routed through the full confirm path...
    expect(markOrderPaidConfirmed).toHaveBeenCalledTimes(1)
    expect(markOrderPaidConfirmed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orderId: 'ord-cancelled',
        fromPaymentStatuses: expect.arrayContaining(['cancelled']),
        extraAuditMetadata: expect.objectContaining({ recoveredAfterAutoCancel: true }),
      }),
    )

    // ...and NOT included in the bulk paid update that leaves cancellation fields set.
    const paidBulk = bulkUpdates.filter((u) => u.patch.payment_status === 'paid')
    console.log('BULK_PAID_UPDATES', JSON.stringify(paidBulk, null, 2))
    for (const u of paidBulk) {
      expect(u.ids).not.toContain('ord-cancelled')
    }
    expect(paidBulk.some((u) => u.ids.includes('ord-plain'))).toBe(true)

    const recovery = auditInserts.find((a) => a.action === 'payment.recovered_after_auto_cancel')
    expect(recovery).toBeDefined()
    expect((recovery!.metadata as Row).severity).toBe('error')
    expect((recovery!.metadata as Row).previousCancellationReason).toBe(
      'auto_cancelled_e04111_persistent',
    )
  })

  test('an unclaimed recovery is reported, not counted as recovered', async () => {
    markOrderPaidConfirmed.mockResolvedValue({ claimed: false, reason: 'claim_conflict' })

    const orders: Row[] = [
      {
        id: 'ord-cancelled',
        restaurant_id: 'rest-1',
        total: 42.5,
        payment_method: 'card',
        payment_status: 'cancelled',
        cancellation_reason: 'auto_cancelled_e04111_persistent',
        cancelled_at: '2026-08-03T10:00:00.000Z',
        paycloud_merchant_order_no: 'FT149',
      },
    ]
    const events: Row[] = [
      {
        id: 'evt-1',
        event_type: 'sale',
        business_order_no: 'FT149',
        order_ids: ['ord-cancelled'],
        amount: 42.5, // #223: matches the single named order's total.
        created_at: '2026-08-03T11:00:00.000Z',
      },
    ]

    const result = await reconcileOrphanPayments(makeSupabase(orders, events) as never)
    expect(result.recoveredAfterAutoCancel).toBe(0)
    expect(auditInserts.find((a) => a.action === 'payment.recovered_after_auto_cancel')).toBeUndefined()
  })

  test('a throw on one order does not abort the sweep', async () => {
    markOrderPaidConfirmed.mockRejectedValue(new Error('transient db error'))

    const orders: Row[] = [
      {
        id: 'ord-cancelled',
        restaurant_id: 'rest-1',
        total: 42.5,
        payment_method: 'card',
        payment_status: 'cancelled',
        cancellation_reason: 'auto_cancelled_e04111_persistent',
        cancelled_at: '2026-08-03T10:00:00.000Z',
        paycloud_merchant_order_no: 'FT149',
      },
      {
        id: 'ord-plain',
        restaurant_id: 'rest-1',
        total: 10,
        payment_method: 'card',
        payment_status: 'pending',
        cancellation_reason: null,
        cancelled_at: null,
        paycloud_merchant_order_no: 'FT150',
      },
    ]
    const events: Row[] = [
      {
        id: 'evt-1',
        event_type: 'sale',
        business_order_no: 'FT149',
        order_ids: ['ord-cancelled', 'ord-plain'],
        amount: 52.5, // #223: matches the sum of the named orders' totals (42.5 + 10).
        created_at: '2026-08-03T11:00:00.000Z',
      },
    ]

    const result = await reconcileOrphanPayments(makeSupabase(orders, events) as never)
    expect(result.recoveredAfterAutoCancel).toBe(0)
    expect(result.markedPaidIds).toContain('ord-plain')
  })
})
