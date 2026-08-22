import {
  autoCancelStalePosOrders,
  ORDER_CANCELLED_ACTION,
  VERIFICATION_SKIPPED_ACTION,
} from '@/lib/orders/auto-cancel-stale-pos-orders'

/**
 * THE CRON CANCEL LEAVES A TRAIL -- and still cancels exactly what it cancelled before.
 *
 * Measured on production 2026-08-22: 95 of 272 cancelled orders carry no audit row of any kind, and
 * 90 of those are this cron's `auto_timeout`. The automated path was the largest single source of
 * untracked cancellation in the system, about ten times the incident that prompted the audit.
 *
 * BOTH DIRECTIONS ARE ASSERTED. A one-sided fix here has two distinct failure modes: writing the
 * row but no longer cancelling (the queue stops draining), or writing the row from a path that must
 * never cancel at all (the 2026-08-05 ruling). Neither is caught by asserting the row exists.
 *
 * THE THIRD ASSERTION IS `cancellation_reason`. It must still be 'auto_timeout' on both paths.
 * isCancelledOnE04111Evidence treats that string as a NON-recoverable prefix, so quietly changing
 * it here would make these orders recoverable -- a money-path change nobody ruled.
 */
const RESTAURANT = 'rest-1'
const ORDER = 'order-1'
const MON = 'FT-TEST-0001'

type Row = Record<string, unknown>

const withRef = () => ({ id: ORDER, restaurant_id: RESTAURANT, total: 33, paycloud_merchant_order_no: MON })
const noRef = () => ({ id: ORDER, restaurant_id: RESTAURANT, total: 33, paycloud_merchant_order_no: null })

function makeSupabase(opts: {
  candidate: Row
  /** What the cancelling UPDATE ... .select() returns. Empty models losing the race. */
  updateReturns?: Row[]
  auditInsertFails?: boolean
}) {
  const inserted: Row[] = []
  const updates: Row[] = []
  const client = {
    from(table: string) {
      const st = { isAuditSelect: false, didUpdate: false }
      const chain: Record<string, unknown> = {}
      const self = () => chain
      chain.select = () => {
        if (table === 'audit_logs') st.isAuditSelect = true
        return self()
      }
      chain.insert = (rows: Row | Row[]) => {
        if (table === 'audit_logs') inserted.push(...(Array.isArray(rows) ? rows : [rows]))
        return { error: opts.auditInsertFails ? { message: 'insert failed' } : null }
      }
      chain.update = (patch: Row) => {
        st.didUpdate = true
        updates.push({ table, ...patch })
        return self()
      }
      chain.eq = () => self()
      chain.lt = () => self()
      chain.in = () => self()
      chain.is = () => self()
      chain.order = () => self()
      chain.limit = () => self()
      // The candidate sweep paginates through .range(); page 2 must be empty or it loops.
      chain.range = (from: number) =>
        Promise.resolve(
          table === 'orders' && from === 0 ? { data: [opts.candidate], error: null } : { data: [], error: null },
        )
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'audit_logs' && st.isAuditSelect) return Promise.resolve({ data: [], error: null }).then(resolve)
        if (table === 'orders' && st.didUpdate) {
          return Promise.resolve({ data: opts.updateReturns ?? [opts.candidate], error: null }).then(resolve)
        }
        if (table === 'orders') return Promise.resolve({ data: [opts.candidate], error: null }).then(resolve)
        return Promise.resolve({ data: [], error: null }).then(resolve)
      }
      return chain
    },
  }
  return { client: client as never, inserted, updates }
}

const reply = (over: Partial<Record<string, unknown>>) =>
  async () =>
    ({
      paid: false,
      statusRecognised: true,
      merchantOrderNo: MON,
      status: 'failed',
      transactionId: null,
      amount: 0,
      raw: {},
      ...over,
    }) as never

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'm', storeNo: 's' }),
}))

const cancelRows = (inserted: Row[]) => inserted.filter((r) => r.action === ORDER_CANCELLED_ACTION)

describe('a cancel with no gateway reference -- the 90-row path', () => {
  it('still cancels, and now records why', async () => {
    const { client, inserted, updates } = makeSupabase({ candidate: noRef() })
    const result = await autoCancelStalePosOrders(client, { verifyWithFinatic: false })

    expect(result.cancelledIds).toContain(ORDER)
    const rows = cancelRows(inserted)
    expect(rows).toHaveLength(1)
    expect(rows[0].entity_id).toBe(ORDER)
    expect(rows[0].restaurant_id).toBe(RESTAURANT)
    const meta = rows[0].metadata as Row
    expect(meta.basis).toBe('no_gateway_reference')
    expect(meta.orderTotal).toBe(33)
    expect(meta.businessOrderNo).toBeNull()

    // The order columns are untouched by this change.
    expect(updates.some((u) => u.cancellation_reason === 'auto_timeout')).toBe(true)
  })
})

describe('a cancel after Finatic confirmed not-paid', () => {
  it('records the gateway basis, and leaves cancellation_reason alone', async () => {
    const { client, inserted, updates } = makeSupabase({ candidate: withRef() })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: reply({ statusRecognised: true, status: 'failed' }),
    })

    expect(result.cancelledIds).toContain(ORDER)
    const rows = cancelRows(inserted)
    expect(rows).toHaveLength(1)
    expect((rows[0].metadata as Row).basis).toBe('finatic_verified_not_paid')
    expect((rows[0].metadata as Row).businessOrderNo).toBe(MON)

    // LOAD-BEARING: still 'auto_timeout', so these orders stay non-recoverable exactly as before.
    expect(updates.some((u) => u.cancellation_reason === 'auto_timeout')).toBe(true)
    expect(updates.some((u) => u.cancellation_reason === 'finatic_verified_not_paid')).toBe(false)
  })
})

describe('the paths that must NOT cancel write no cancellation row', () => {
  it('an unrecognised gateway status', async () => {
    const { client, inserted } = makeSupabase({ candidate: withRef() })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: reply({ statusRecognised: false, status: '3' }),
    })

    expect(result.cancelledIds).not.toContain(ORDER)
    expect(cancelRows(inserted)).toHaveLength(0)
    // It is recorded -- as a skip, which is a different thing entirely.
    expect(inserted.find((r) => r.action === VERIFICATION_SKIPPED_ACTION)).toBeDefined()
  })

  it('E04111 -- the 2026-08-05 ruling', async () => {
    const { client, inserted } = makeSupabase({ candidate: withRef() })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: (() => {
        throw Object.assign(new Error('PayCloud query failed: E04111 [E04111]Merchant order number is invalid'), {
          code: 'E04111',
        })
      }) as never,
    })

    expect(result.cancelledIds).not.toContain(ORDER)
    expect(cancelRows(inserted)).toHaveLength(0)
  })
})

describe('the row describes what actually happened, not what was attempted', () => {
  it('writes nothing when the cancel loses the race to a concurrent callback', async () => {
    // The UPDATE re-asserts payment_status='pending'; a terminal callback that won returns 0 rows.
    const { client, inserted } = makeSupabase({ candidate: noRef(), updateReturns: [] })
    const result = await autoCancelStalePosOrders(client, { verifyWithFinatic: false })

    expect(result.cancelledIds).not.toContain(ORDER)
    expect(cancelRows(inserted)).toHaveLength(0)
  })

  it('throws rather than letting a cancellation go unrecorded', async () => {
    // Deliberately unlike the skip-path audit, which is best-effort. Losing an observation costs
    // nothing; losing the record of a cancelled order is the defect this fixes.
    const { client } = makeSupabase({ candidate: noRef(), auditInsertFails: true })
    await expect(autoCancelStalePosOrders(client, { verifyWithFinatic: false })).rejects.toThrow(
      /cancelByIds audit/,
    )
  })
})
