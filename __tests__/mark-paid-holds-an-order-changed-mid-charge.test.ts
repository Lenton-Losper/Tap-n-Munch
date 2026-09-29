/**
 * markOrderPaidConfirmed HOLDS AN ORDER THE DATABASE REFUSES TO MARK PAID BECAUSE IT CHANGED
 * MID-CHARGE (Sprint 2026-09-29 brief, task 5).
 *
 * `orders_refuse_paid_on_changed_charge` (20260929120000) raises FTCHG when a non-cash payment would
 * mark paid an order whose content moved after its charge was prepared. Every caller of this
 * function -- the device's success callback, verify-before-cancel, the auto-cancel cron, reconcile --
 * is reporting money the gateway has ALREADY taken, so a thrown error would lose it into a retry
 * loop. It must come back as a named refusal, with the order held and both figures recorded.
 */
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({ safeIssueReceiptForOrder: jest.fn(async () => undefined) }))

type Call = { table: string; op: string; payload?: Record<string, unknown>; filters: Array<[string, unknown]> }

function mockSupabase(paidWriteError: { code: string; message: string } | null) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] }
      calls.push(call)
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (c: string, v: unknown) => (call.filters.push([c, v]), b),
        in: (c: string, v: unknown) => (call.filters.push([`in:${c}`, v]), b),
        update: (payload: Record<string, unknown>) => ((call.op = 'update'), (call.payload = payload), b),
        insert: async (payload: Record<string, unknown>) => {
          call.op = 'insert'
          call.payload = payload
          return { error: null }
        },
        maybeSingle: async () => {
          if (call.op === 'update' && call.payload?.payment_status === 'paid') {
            return paidWriteError
              ? { data: null, error: paidWriteError }
              : { data: { id: 'o1', tab_id: null, payment_status: 'paid' }, error: null }
          }
          return { data: { total: 45, pending_charge_cents: 4000, pending_charge_at: '2026-09-29T10:00:00Z', payment_status: 'pending' }, error: null }
        },
        then: (onF: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(onF),
      }
      return b
    },
  }
  return { client, calls }
}

const PARAMS = {
  orderId: 'o1',
  restaurantId: 'r1',
  reference: 'FT-1',
  amount: 40,
  source: 'terminal_callback',
}

describe('markOrderPaidConfirmed on FTCHG', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}))
  afterEach(() => jest.restoreAllMocks())

  it('returns order_changed instead of throwing, holds the order, and records both figures', async () => {
    const { client, calls } = mockSupabase({ code: 'FTCHG', message: 'order changed' })
    const result = await markOrderPaidConfirmed(client as never, PARAMS)
    expect(result).toEqual({ claimed: false, reason: 'order_changed' })

    const hold = calls.find((c) => c.op === 'update' && c.payload?.payment_status === 'amount_mismatch_hold')
    expect(hold).toBeDefined()
    expect(hold!.filters).toContainEqual(['id', 'o1'])
    // Conditional on still owing: a concurrent resolution is never overwritten.
    expect(hold!.filters.some(([c]) => c === 'in:payment_status')).toBe(true)

    const audit = calls.find((c) => c.op === 'insert' && c.table === 'audit_logs')
    expect(audit?.payload?.action).toBe('payment.held_order_changed_since_charge_prepared')
    const meta = audit?.payload?.metadata as Record<string, unknown>
    expect(meta.orderChargeCents).toBe(4000)
    expect(meta.orderTotalNow).toBe(45)
    // No payment.completed row: nothing was completed.
    expect(calls.some((c) => c.op === 'insert' && c.payload?.action === 'payment.completed')).toBe(false)
  })

  it('negative control: any OTHER database error still throws', async () => {
    const { client } = mockSupabase({ code: '40001', message: 'serialization' })
    await expect(markOrderPaidConfirmed(client as never, PARAMS)).rejects.toMatchObject({ code: '40001' })
  })

  it('negative control: an unchanged order is claimed as before', async () => {
    const { client } = mockSupabase(null)
    const result = await markOrderPaidConfirmed(client as never, PARAMS)
    expect(result).toEqual({ claimed: true, orderId: 'o1', tabId: null })
  })
})
