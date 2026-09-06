/**
 * A FAILED READ IS NOT AN EMPTY RESULT.
 *
 * ================================================================================================
 * THE SHAPE
 * ================================================================================================
 *
 * Three money-path reads discarded their `error` and applied a fallback — `?? []`, `?? null`,
 * `!x?.length` — that is INDISTINGUISHABLE from a legitimate empty answer. Each therefore turned a
 * transient database failure into a confident wrong action:
 *
 *   1. markOrderPaidConfirmed  a failed read of a tab's orders reduced to 0 and WROTE it, setting
 *                              a tab that still owed money to N$0.00 — the exact defect the
 *                              comment above that code says it exists to prevent.
 *   2. reconcileOrphanPayments a failed receipt lookup read as "no receipt exists" and issued
 *                              another: a DUPLICATE RCT-NUMBERED TAX DOCUMENT, from a cron, with
 *                              nobody watching.
 *   3. reconcileOrphanPayments a failed order lookup read as "this event names no orders" and
 *                              stepped over a real orphaned payment in silence — on the one path
 *                              whose whole job is finding money that got lost.
 *
 * Found by sweeping for the shape after the same bug was caught by mutation in
 * allocationIdsHeldByLiveCard. Owner's ruling, 2026-09-06: where absence and failure lead to
 * different actions, they need different code paths.
 *
 * ================================================================================================
 * EVERY TEST HERE DRIVES THE REAL FUNCTION
 * ================================================================================================
 *
 * The fake fails ONE named read and lets the rest succeed, so what is asserted is the shipped
 * behaviour under a partial failure — not a restatement of the rule. Each was mutation-verified by
 * putting the discarded error back and watching the matching test go red.
 */
import { markOrderPaidConfirmed } from '@/lib/payments/mark-order-paid-confirmed'
import { reconcileOrphanPayments } from '@/lib/payments/reconcile-orphan-payments'

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptForOrder: jest.fn(async () => undefined),
}))

type Row = Record<string, unknown>

/**
 * A Supabase fake that can fail one table's reads on demand.
 *
 * `failReads` names tables whose SELECTs error. Writes are recorded so "did it write, and what"
 * is answerable — the tab-total case turns entirely on whether a write happened at all.
 */
function fake(opts: {
  tables: Record<string, Row[]>
  failReads?: string[]
  /**
   * Fail only the FIRST read of a table, then let it succeed — a transient blip, which is the
   * scenario these guards are for. reconcileOrphanPayments reads `orders` twice for different
   * reasons and the second read ALREADY throws correctly; failing both would mask the counter
   * behind that throw and test the wrong thing.
   */
  failFirstReadOf?: string[]
  writes?: Array<{ table: string; patch: Row }>
  rpc?: Record<string, unknown>
}) {
  const writes = opts.writes ?? []
  const failReads = new Set(opts.failReads ?? [])
  const failOnce = new Set(opts.failFirstReadOf ?? [])

  const client = {
    writes,
    rpc: async () => ({ data: opts.rpc ?? null, error: null }),
    from(table: string) {
      const rows = [...(opts.tables[table] ?? [])]
      let pending: Row | null = null
      let isWrite = false

      const shouldFail = () => {
        if (isWrite) return false
        if (failReads.has(table)) return true
        if (failOnce.has(table)) {
          failOnce.delete(table)
          return true
        }
        return false
      }

      const result = () =>
        shouldFail()
          ? { data: null, error: { message: `simulated read failure on ${table}` } }
          : { data: rows, error: null }

      const b: Record<string, unknown> = {
        select: () => b,
        insert: (patch: Row) => {
          isWrite = true
          writes.push({ table, patch })
          return b
        },
        update: (patch: Row) => {
          isWrite = true
          pending = patch
          return b
        },
        eq: () => b,
        neq: () => b,
        in: () => b,
        is: () => b,
        not: () => b,
        gte: () => b,
        lte: () => b,
        overlaps: () => b,
        order: () => b,
        limit: () => b,
        range: () => Promise.resolve(result()),
        single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        maybeSingle: () => {
          if (shouldFail()) {
            return Promise.resolve({ data: null, error: { message: `simulated read failure on ${table}` } })
          }
          return Promise.resolve({ data: rows[0] ?? null, error: null })
        },
        then(resolve: (v: unknown) => unknown) {
          if (isWrite && pending) writes.push({ table, patch: pending })
          return Promise.resolve(isWrite ? { data: null, error: null } : result()).then(resolve)
        },
      }
      return b
    },
  }
  return client as never
}

describe('a failed read never zeroes a tab that still owes money', () => {
  const base = () => ({
    tables: {
      orders: [{ id: 'o1', tab_id: 'tab1', payment_status: 'paid', total: 40 }],
      audit_logs: [],
      tabs: [{ id: 'tab1', total: 90 }],
    },
    writes: [] as Array<{ table: string; patch: Row }>,
  })

  it('writes a recomputed total when the read succeeds', async () => {
    // The positive control. Without it, "no tabs write" below would pass on a function that never
    // writes at all.
    const opts = base()
    await markOrderPaidConfirmed(fake(opts), {
      orderId: 'o1', restaurantId: 'r1', reference: 'ref', amount: 40,
      gatewayAmount: null, paymentMethod: 'card', source: 'test',
    } as never)

    expect(opts.writes.some((w) => w.table === 'tabs')).toBe(true)
  })

  it('writes NOTHING to tabs when the orders read fails', async () => {
    /**
     * The tab keeps the total it already has — stale, and honest about being stale — rather than
     * being overwritten with a number nothing computed. A transient failure must not be able to
     * tell staff a table owes nothing.
     */
    const opts = { ...base(), failReads: ['orders'] }
    await markOrderPaidConfirmed(fake(opts), {
      orderId: 'o1', restaurantId: 'r1', reference: 'ref', amount: 40,
      gatewayAmount: null, paymentMethod: 'card', source: 'test',
    } as never)

    const tabWrites = opts.writes.filter((w) => w.table === 'tabs')
    expect(tabWrites).toEqual([])
  })

  it('and specifically never writes total: 0', async () => {
    // Said as its own assertion because 0 is the value the old code produced, and it is the one
    // that reads to staff as "this table owes nothing".
    const opts = { ...base(), failReads: ['orders'] }
    await markOrderPaidConfirmed(fake(opts), {
      orderId: 'o1', restaurantId: 'r1', reference: 'ref', amount: 40,
      gatewayAmount: null, paymentMethod: 'card', source: 'test',
    } as never)

    expect(opts.writes.some((w) => w.table === 'tabs' && w.patch.total === 0)).toBe(false)
  })
})

describe('a failed receipt lookup never issues a second tax document', () => {
  const { safeIssueReceiptForOrder } = jest.requireMock('@/lib/receipts/safeIssueReceipt') as {
    safeIssueReceiptForOrder: jest.Mock
  }

  beforeEach(() => safeIssueReceiptForOrder.mockClear())

  const tables = {
    payment_events: [],
    orders: [{ id: 'o1', restaurant_id: 'r1', payment_status: 'paid', paid_at: new Date().toISOString() }],
    receipt_documents: [],
  }

  it('issues one when the lookup succeeds and finds nothing', async () => {
    // Positive control: the loop does reach safeIssueReceiptForOrder under normal conditions, so
    // the assertion below is about the guard and not about an unreachable branch.
    const result = await reconcileOrphanPayments(fake({ tables }), { restaurantId: 'r1' } as never)
    expect(safeIssueReceiptForOrder).toHaveBeenCalledTimes(1)
    expect(result.receiptsIssued).toBe(1)
    expect(result.receiptLookupsFailed).toBe(0)
  })

  it('issues NOTHING when the lookup fails, and counts it', async () => {
    /**
     * Not knowing must mean do not issue. A duplicate RCT-numbered document cannot be undone by a
     * later sweep; a skipped order costs one more pass.
     */
    const result = await reconcileOrphanPayments(
      fake({ tables, failReads: ['receipt_documents'] }),
      { restaurantId: 'r1' } as never,
    )
    expect(safeIssueReceiptForOrder).not.toHaveBeenCalled()
    expect(result.receiptsIssued).toBe(0)
    expect(result.receiptLookupsFailed).toBe(1)
  })
})

describe('a recovery path does not abandon a payment in silence', () => {
  const tables = {
    payment_events: [
      { id: 'e1', business_order_no: 'FT-1', amount: 40, order_ids: ['o1'], created_at: new Date().toISOString() },
    ],
    orders: [],
    receipt_documents: [{ id: 'rd1' }],
  }

  it('counts an event it could not read, rather than stepping over it', async () => {
    /**
     * Nothing is wrongly marked paid, which is why this one never surfaced. But this function's
     * whole job is finding money that got lost, and a silent skip there is money that stays lost.
     * `markedPaid: 0` from a quiet night and from a failing database must not look the same.
     */
    const result = await reconcileOrphanPayments(
      // The event-orders read fails; the later paid-orders read succeeds. That second read already
      // throws on error, correctly — this test is about the first one, which used to skip in
      // silence.
      fake({ tables, failFirstReadOf: ['orders'] }),
      { restaurantId: 'r1' } as never,
    )
    expect(result.ordersLookupsFailed).toBeGreaterThan(0)
    expect(result.markedPaid).toBe(0)
  })

  it('reports zero failures on a genuinely quiet run', async () => {
    // The control that stops the counter reading as "always non-zero".
    const result = await reconcileOrphanPayments(
      fake({ tables: { payment_events: [], orders: [], receipt_documents: [] } }),
      { restaurantId: 'r1' } as never,
    )
    expect(result.ordersLookupsFailed).toBe(0)
    expect(result.receiptLookupsFailed).toBe(0)
  })
})
