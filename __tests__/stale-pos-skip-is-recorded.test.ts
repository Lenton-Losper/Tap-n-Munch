import {
  autoCancelStalePosOrders,
  SKIP_REPROBE_INTERVAL_MS,
  VERIFICATION_SKIPPED_ACTION,
} from '@/lib/orders/auto-cancel-stale-pos-orders'

/**
 * PART 2 of docs/design-persistence-pass-2026-08-21.md: the skip path writes itself down, and stops
 * asking Finatic the same question every two minutes.
 *
 * WHY IT MATTERS. Until now this path wrote NOTHING — a `console.warn` and nothing else — so the
 * database could not say whether the cron had looked at an order once or sixty times. That is
 * exactly why "why has #876 sat for two hours" had to be answered by reading source instead of
 * data. Ten stale orders also cost roughly 7,200 Finatic queries a day that could not change
 * anything.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: any decision about money. This change makes no cancel, no
 * correction and no status write — that is the point of it being safe to ship. The cancel and
 * correct paths are covered by exploiter-223-original-repro and staff-cancel-reason-and-audit.
 */
const RESTAURANT = 'rest-1'
const ORDER = 'order-with-a-reference'
const MERCHANT_ORDER_NO = 'FT-TEST-0001'

type Row = Record<string, unknown>

const orderRow = () => ({
  id: ORDER,
  restaurant_id: RESTAURANT,
  total: 33,
  paycloud_merchant_order_no: MERCHANT_ORDER_NO,
})

/**
 * A supabase double narrow enough to be read in one sitting. `priorSkips` is what the audit_logs
 * SELECT returns, which is how the rest interval is expressed.
 */
function makeSupabase(opts: { priorSkips?: Row[]; auditReadThrows?: boolean; auditInsertFails?: boolean }) {
  const inserted: Row[] = []
  const updates: Row[] = []

  const client = {
    from(table: string) {
      const state: { action: string; isAuditSelect: boolean } = { action: 'select', isAuditSelect: false }
      const chain: Record<string, unknown> = {}
      const self = () => chain

      chain.select = () => {
        if (table === 'audit_logs') {
          state.isAuditSelect = true
          if (opts.auditReadThrows) throw new Error('audit read exploded')
        }
        return self()
      }
      chain.insert = (row: Row) => {
        if (table === 'audit_logs') inserted.push(row)
        return { error: opts.auditInsertFails ? { message: 'insert failed' } : null }
      }
      chain.update = (patch: Row) => {
        updates.push({ table, ...patch })
        return self()
      }
      chain.eq = () => self()
      chain.lt = () => self()
      chain.in = () => self()
      chain.is = () => self()
      chain.order = () => self()
      chain.limit = () => self()
      /**
       * The candidate query is read through fetchAllRows, which paginates with .range() -- so the
       * orders come back HERE, not through .then(). Page 2 must be empty or fetchAllRows loops.
       */
      chain.range = (from: number) =>
        Promise.resolve(
          table === 'orders' && from === 0
            ? { data: [orderRow()], error: null }
            : { data: [], error: null },
        )
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'audit_logs' && state.isAuditSelect) {
          return Promise.resolve({ data: opts.priorSkips ?? [], error: null }).then(resolve)
        }
        if (table === 'orders' && state.action === 'select') {
          return Promise.resolve({ data: [orderRow()], error: null }).then(resolve)
        }
        return Promise.resolve({ data: [], error: null }).then(resolve)
      }
      return chain
    },
  }
  return { client: client as never, inserted, updates }
}

/** Finatic answering E04111 — the case that is skipped and must now be recorded. */
const e04111 = () => {
  throw Object.assign(new Error('PayCloud query failed: E04111 [E04111]Merchant order number is invalid'), {
    code: 'E04111',
  })
}

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'm', storeNo: 's' }),
}))

describe('the stale-POS skip path', () => {
  it('records the skip as an audit row instead of only a console warning', async () => {
    const { client, inserted } = makeSupabase({ priorSkips: [] })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: e04111 as never,
    })

    expect(result.skippedUncertainIds).toContain(ORDER)
    const skipRow = inserted.find((r) => r.action === VERIFICATION_SKIPPED_ACTION)
    expect(skipRow).toBeDefined()
    expect(skipRow!.entity_id).toBe(ORDER)
    const meta = skipRow!.metadata as Row
    expect(meta.isE04111).toBe(true)
    expect(meta.gatewayCode).toBe('E04111')
    expect(meta.businessOrderNo).toBe(MERCHANT_ORDER_NO)
    // The persistence pass needs a count; the first skip is observation zero.
    expect(meta.observationCount).toBe(0)
  })

  it('does NOT re-probe an order already asked about within the rest interval', async () => {
    const recent = new Date(Date.now() - SKIP_REPROBE_INTERVAL_MS / 2).toISOString()
    let probes = 0
    const { client, inserted } = makeSupabase({
      priorSkips: [{ entity_id: ORDER, created_at: recent }],
    })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: (() => {
        probes++
        return e04111()
      }) as never,
    })

    expect(probes).toBe(0)
    expect(result.deferredRecentlyProbedIds).toContain(ORDER)
    // Deferred is NOT skipped — a quiet run must be distinguishable from one that learned nothing.
    expect(result.skippedUncertainIds).not.toContain(ORDER)
    expect(inserted.find((r) => r.action === VERIFICATION_SKIPPED_ACTION)).toBeUndefined()
  })

  it('DOES re-probe once the rest interval has elapsed', async () => {
    const old = new Date(Date.now() - SKIP_REPROBE_INTERVAL_MS * 2).toISOString()
    let probes = 0
    const { client, inserted } = makeSupabase({
      priorSkips: [{ entity_id: ORDER, created_at: old }],
    })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: (() => {
        probes++
        return e04111()
      }) as never,
    })

    expect(probes).toBe(1)
    expect(result.deferredRecentlyProbedIds).not.toContain(ORDER)
    const skipRow = inserted.find((r) => r.action === VERIFICATION_SKIPPED_ACTION)
    // The prior observation is counted, so persistence is measurable across runs.
    expect((skipRow!.metadata as Row).observationCount).toBe(1)
  })

  it('fails OPEN when the audit read throws — probes everything rather than deferring blindly', async () => {
    // Losing the rate cut is a cost. Silently skipping an order because an unrelated read failed
    // would be a behaviour change, and this must never make one.
    let probes = 0
    const { client } = makeSupabase({ auditReadThrows: true })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: (() => {
        probes++
        return e04111()
      }) as never,
    })

    expect(probes).toBe(1)
    expect(result.deferredRecentlyProbedIds).toHaveLength(0)
    expect(result.skippedUncertainIds).toContain(ORDER)
  })

  it('a failed audit INSERT does not change what happens to the order', async () => {
    // Best-effort by design: losing the row costs an observation, never a different decision.
    const { client } = makeSupabase({ priorSkips: [], auditInsertFails: true })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: e04111 as never,
    })

    expect(result.skippedUncertainIds).toContain(ORDER)
    expect(result.cancelledIds).not.toContain(ORDER)
  })

  it('never cancels or corrects on this path', async () => {
    // The load-bearing safety property: E04111 alone still authorises nothing, per the
    // 2026-08-05 ruling. This change adds observability, not a decision.
    const { client, updates } = makeSupabase({ priorSkips: [] })
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: e04111 as never,
    })

    expect(result.cancelledIds).not.toContain(ORDER)
    expect(result.correctedToPaidIds).not.toContain(ORDER)
    expect(updates.some((u) => u.status === 'cancelled')).toBe(false)
  })
})
