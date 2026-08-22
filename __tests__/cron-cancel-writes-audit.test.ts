import { autoCancelStalePosOrders } from '@/lib/orders/auto-cancel-stale-pos-orders'
import { ORDER_CANCELLED_ACTION } from '@/lib/orders/cancel-order-with-trail'

/**
 * THE CRON CANCEL LEAVES A TRAIL -- and still cancels exactly what it cancelled before.
 *
 * Measured on production 2026-08-22: 95 of 272 cancelled orders carry no audit row of any kind, and
 * 90 of those are this cron's `auto_timeout`. The automated path was the largest single source of
 * untracked cancellation in the system, about ten times the incident that prompted the audit.
 *
 * BOTH DIRECTIONS ARE ASSERTED. A one-sided fix has two distinct failure modes: writing the row but
 * no longer cancelling (the queue stops draining), or writing the row from a path that must never
 * cancel at all (the 2026-08-05 E04111 ruling). Neither is caught by asserting the row exists.
 *
 * THE THIRD ASSERTION IS `cancellation_reason`. It must still be 'auto_timeout'.
 * isCancelledOnE04111Evidence treats that string as a NON-recoverable prefix, so quietly changing it
 * would make these orders recoverable -- a money-path change nobody ruled.
 */
const RESTAURANT = 'rest-1'
const ORDER = 'order-1'
const MON = 'FT-TEST-0001'

type Row = Record<string, unknown>

const withRef = () => ({ id: ORDER, restaurant_id: RESTAURANT, total: 33, paycloud_merchant_order_no: MON })
const noRef = () => ({ id: ORDER, restaurant_id: RESTAURANT, total: 33, paycloud_merchant_order_no: null })

function makeSupabase(opts: { candidate: Row; updateReturns?: Row[]; auditInsertFails?: boolean }) {
  const inserted: Row[] = []
  const updates: Row[] = []
  const client = {
    from(table: string) {
      const st = { didUpdate: false }
      const chain: Record<string, unknown> = {}
      const self = () => chain
      chain.select = () => self()
      chain.insert = (rows: Row | Row[]) => {
        // A failed insert writes nothing, so the double must not record one either.
        if (table === 'audit_logs' && !opts.auditInsertFails) {
          inserted.push(...(Array.isArray(rows) ? rows : [rows]))
        }
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
      // The candidate sweep reads through fetchAllRows, which paginates with .range().
      chain.range = (from: number) =>
        Promise.resolve(
          table === 'orders' && from === 0 ? { data: [opts.candidate], error: null } : { data: [], error: null },
        )
      chain.then = (resolve: (v: unknown) => unknown) => {
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

const notPaid = async () =>
  ({
    paid: false,
    merchantOrderNo: MON,
    status: 'failed',
    transactionId: null,
    amount: 0,
    raw: {},
  }) as never

const e04111 = () => {
  throw Object.assign(new Error('PayCloud query failed: E04111 [E04111]Merchant order number is invalid'), {
    code: 'E04111',
  })
}

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
  it('records it too, and leaves cancellation_reason alone', async () => {
    const { client, inserted, updates } = makeSupabase({ candidate: withRef() })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: notPaid,
    })

    expect(result.cancelledIds).toContain(ORDER)
    expect(cancelRows(inserted)).toHaveLength(1)
    expect(updates.some((u) => u.cancellation_reason === 'auto_timeout')).toBe(true)
  })
})

describe('the path that must NOT cancel writes no cancellation row', () => {
  it('E04111 -- the 2026-08-05 ruling', async () => {
    const { client, inserted } = makeSupabase({ candidate: withRef() })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: e04111 as never,
    })

    expect(result.cancelledIds).not.toContain(ORDER)
    expect(result.skippedUncertainIds).toContain(ORDER)
    expect(cancelRows(inserted)).toHaveLength(0)
  })
})

describe('the row describes what actually happened, not what was attempted', () => {
  it('writes nothing when the cancel loses the race to a concurrent callback', async () => {
    const { client, inserted } = makeSupabase({ candidate: noRef(), updateReturns: [] })
    const result = await autoCancelStalePosOrders(client, { verifyWithFinatic: false })

    expect(result.cancelledIds).not.toContain(ORDER)
    expect(cancelRows(inserted)).toHaveLength(0)
  })

  it('throws rather than letting a cancellation go unrecorded', async () => {
    const { client } = makeSupabase({ candidate: noRef(), auditInsertFails: true })
    await expect(autoCancelStalePosOrders(client, { verifyWithFinatic: false })).rejects.toThrow(
      /cancelByIds audit/,
    )
  })
})
