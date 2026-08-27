/**
 * #353 — the stale sweep SEES every channel and ACTS on one.
 *
 * THE DEFECT. `autoCancelStalePosOrders` carried `.eq('channel','pos')` in its candidate query,
 * so the other channels were not spared — they were invisible, and nothing else in the system
 * looked for them. Measured on production 2026-08-27:
 *
 *     channel   stuck   avg days   oldest   no gateway reference
 *     pos           7       10.9     14.4    0 of 7
 *     table         9        3.3      8.0    9 of 9
 *     kiosk         4       33.8     40.6    3 of 4
 *
 * Seven of twenty seen; the thirteen unseen ones stuck three times longer.
 *
 * THE RULING IS NOT "WIDEN THE FILTER". Eleven of those thirteen carry no gateway reference at
 * all, and the sweep's no-reference branch CANCELS on the reasoning that prepare-payment never
 * ran. That reasoning is POS-specific: a `table` order is pay-at-till, legitimately never had a
 * reference, and eleven of them are ready/preparing/completed — the food was made. So the tests
 * below assert the two halves separately: every channel is now VISIBLE, and no channel but `pos`
 * is ever WRITTEN TO.
 *
 * THE LOAD-BEARING ASSERTIONS ARE THE NEGATIVE ONES. `updates` and `inserted` are captured from
 * the supabase double and asserted EMPTY for non-POS orders. A test that only checked
 * `surfacedNeedsHumanIds` would pass with the cancel firing as well.
 */
import {
  autoCancelStalePosOrders,
  SWEEP_ACTIONABLE_CHANNEL,
} from '@/lib/orders/auto-cancel-stale-pos-orders'

const RESTAURANT = 'rest-1'

type Row = Record<string, unknown>

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'm', storeNo: 's' }),
}))

/**
 * A supabase double narrow enough to read in one sitting. Every write the sweep attempts lands in
 * `updates` (orders) or `inserted` (audit_logs), which is what the negative assertions read.
 */
function makeSupabase(orders: Row[]) {
  const inserted: Row[] = []
  const updates: Row[] = []
  /** Ids the candidate query returned, so a test can prove the query itself saw them. */
  const seen: string[] = []
  /**
   * Every filter the sweep put on the CANDIDATE query, as (column, value).
   *
   * Recorded because the double answers `.range()` with whatever fixtures it was given and
   * ignores the filters entirely -- so a `seen` assertion alone passes with
   * `.eq('channel','pos')` back on the query. The absence of a channel filter is a structural
   * claim about the query and has to be asserted structurally. (Verified by mutation: without
   * this the restored filter is invisible to all ten other tests in this file.)
   */
  const candidateFilters: Array<{ col: string; val: unknown }> = []

  const client = {
    from(table: string) {
      const state = { action: 'select', isAuditSelect: false, updateIds: [] as string[] }
      const chain: Record<string, unknown> = {}
      const self = () => chain

      chain.select = () => {
        if (table === 'audit_logs') state.isAuditSelect = true
        return self()
      }
      chain.insert = (row: Row) => {
        if (table === 'audit_logs') inserted.push(row)
        return { error: null }
      }
      chain.update = (patch: Row) => {
        state.action = 'update'
        updates.push({ table, ...patch })
        return self()
      }
      chain.eq = (col: string, val: unknown) => {
        if (table === 'orders' && state.action === 'select') candidateFilters.push({ col, val })
        return self()
      }
      chain.lt = (col: string, val: unknown) => {
        if (table === 'orders' && state.action === 'select') candidateFilters.push({ col, val })
        return self()
      }
      chain.in = (col: string, vals: unknown) => {
        // cancelByIds narrows its update with `.in('id', ids)`. Honouring that is what makes
        // `updates`/the returned rows a faithful account of WHICH orders were written to --
        // a double that ignores it reports every fixture as cancelled and cannot tell the
        // partition from a widened filter.
        if (table === 'orders' && state.action === 'update' && col === 'id') {
          state.updateIds = (vals as unknown[]).map(String)
        }
        return self()
      }
      chain.is = () => self()
      chain.order = () => self()
      chain.limit = () => self()
      chain.range = (from: number) => {
        if (table === 'orders' && from === 0) {
          seen.push(...orders.map((o) => String(o.id)))
          return Promise.resolve({ data: orders, error: null })
        }
        return Promise.resolve({ data: [], error: null })
      }
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'audit_logs' && state.isAuditSelect) {
          return Promise.resolve({ data: [], error: null }).then(resolve)
        }
        // An `update(...).select()` on orders returns the rows the update actually claimed.
        // A non-POS id appearing here is the failure.
        if (table === 'orders' && state.action === 'update') {
          const claimed = orders.filter((o) => state.updateIds.includes(String(o.id)))
          return Promise.resolve({ data: claimed, error: null }).then(resolve)
        }
        return Promise.resolve({ data: [], error: null }).then(resolve)
      }
      return chain
    },
  }
  return { client: client as never, inserted, updates, seen, candidateFilters }
}

const posNoRef = { id: 'pos-no-ref', restaurant_id: RESTAURANT, total: 20, channel: 'pos', paycloud_merchant_order_no: null }
const tableNoRef = { id: 'table-no-ref', restaurant_id: RESTAURANT, total: 50, channel: 'table', paycloud_merchant_order_no: null }
const kioskNoRef = { id: 'kiosk-no-ref', restaurant_id: RESTAURANT, total: 3, channel: 'kiosk', paycloud_merchant_order_no: null }
const kioskWithRef = { id: 'kiosk-with-ref', restaurant_id: RESTAURANT, total: 8, channel: 'kiosk', paycloud_merchant_order_no: 'MO-8' }

describe('#353 visibility widens to every channel', () => {
  it('the candidate query carries NO channel filter at all', async () => {
    const { client, candidateFilters } = makeSupabase([posNoRef, tableNoRef, kioskNoRef])
    await autoCancelStalePosOrders(client)
    // THE assertion of Part A. `.eq('channel','pos')` here is what made twelve stranded orders
    // invisible; putting it back must break a test.
    expect(candidateFilters.filter((f) => f.col === 'channel')).toEqual([])
    // ...while the filters that DO belong on the query are still there.
    expect(candidateFilters).toEqual(
      expect.arrayContaining([{ col: 'payment_status', val: 'pending' }]),
    )
    expect(candidateFilters.some((f) => f.col === 'placed_at')).toBe(true)
  })

  it('every channel reaches the sweep and none is thrown away before reporting', async () => {
    const { client, seen } = makeSupabase([posNoRef, tableNoRef, kioskNoRef])
    const result = await autoCancelStalePosOrders(client)
    expect(seen).toEqual(['pos-no-ref', 'table-no-ref', 'kiosk-no-ref'])
    expect([...result.surfacedNeedsHumanIds, ...result.cancelledIds].sort()).toEqual([
      'kiosk-no-ref',
      'pos-no-ref',
      'table-no-ref',
    ])
  })

  it('reports every non-POS stale order, with the figures needed to act on it', async () => {
    const { client } = makeSupabase([posNoRef, tableNoRef, kioskWithRef])
    const result = await autoCancelStalePosOrders(client)

    expect(result.surfacedNeedsHumanCount).toBe(2)
    expect(result.surfacedNeedsHumanIds.sort()).toEqual(['kiosk-with-ref', 'table-no-ref'])
    expect(result.surfacedNeedsHuman).toEqual(
      expect.arrayContaining([
        { id: 'table-no-ref', restaurantId: RESTAURANT, channel: 'table', total: 50, hasGatewayReference: false },
        { id: 'kiosk-with-ref', restaurantId: RESTAURANT, channel: 'kiosk', total: 8, hasGatewayReference: true },
      ]),
    )
  })

  it('a run with ONLY non-POS orders still reports them', async () => {
    // Before this change such a run returned an empty candidate set and reported nothing at all.
    const { client } = makeSupabase([tableNoRef, kioskNoRef])
    const result = await autoCancelStalePosOrders(client)
    expect(result.surfacedNeedsHumanCount).toBe(2)
    expect(result.cancelledCount).toBe(0)
  })
})

describe('#353 action does NOT widen — non-POS orders are surfaced, never written to', () => {
  it('a table order with no gateway reference is NOT cancelled', async () => {
    // The exact order the widened filter alone would have destroyed: pay-at-till, no reference
    // because none was ever needed, and on production the food was already made.
    const { client, updates, inserted } = makeSupabase([tableNoRef])
    const result = await autoCancelStalePosOrders(client)

    expect(result.cancelledIds).toEqual([])
    expect(result.cancelledCount).toBe(0)
    expect(updates).toEqual([])
    expect(inserted).toEqual([])
    expect(result.surfacedNeedsHumanIds).toEqual(['table-no-ref'])
  })

  it('a kiosk order is never probed against Finatic', async () => {
    let probes = 0
    const { client } = makeSupabase([kioskWithRef])
    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: (async () => {
        probes++
        return { paid: false, statusRecognised: true, status: 1, amount: null, transactionId: null }
      }) as never,
    })

    expect(probes).toBe(0)
    expect(result.correctedToPaidCount).toBe(0)
    expect(result.skippedUncertainCount).toBe(0)
    expect(result.surfacedNeedsHumanIds).toEqual(['kiosk-with-ref'])
  })

  it('an order whose channel is missing is surfaced, not swept into the cancel path', async () => {
    // Unknown is not not-paid; unknown is not POS either. Same asymmetry the unrecognised-gateway
    // -status branch established.
    const { client, updates } = makeSupabase([
      { id: 'no-channel', restaurant_id: RESTAURANT, total: 12, channel: null, paycloud_merchant_order_no: null },
    ])
    const result = await autoCancelStalePosOrders(client)
    expect(result.cancelledIds).toEqual([])
    expect(updates).toEqual([])
    expect(result.surfacedNeedsHumanIds).toEqual(['no-channel'])
  })

  it("a stray 'POS' still counts as POS rather than silently becoming a surfaced order", async () => {
    // The direction that looks safe and is not: falling OUT of the actionable set is a behaviour
    // change on the money path, made by a casing accident.
    const { client } = makeSupabase([{ ...posNoRef, id: 'pos-upper', channel: ' POS ' }])
    const result = await autoCancelStalePosOrders(client)
    expect(result.surfacedNeedsHumanIds).toEqual([])
    expect(result.cancelledIds).toContain('pos-upper')
  })
})

describe('#353 the POS path is unchanged', () => {
  it('a POS order with no gateway reference is still cancelled immediately', async () => {
    const { client, updates } = makeSupabase([posNoRef])
    const result = await autoCancelStalePosOrders(client)
    expect(result.cancelledIds).toContain('pos-no-ref')
    expect(updates.some((u) => u.status === 'cancelled')).toBe(true)
  })

  it('POS orders are cancelled while non-POS ones beside them are not', async () => {
    const { client } = makeSupabase([posNoRef, tableNoRef, kioskNoRef])
    const result = await autoCancelStalePosOrders(client)
    expect(result.cancelledIds).toEqual(['pos-no-ref'])
    expect(result.surfacedNeedsHumanIds.sort()).toEqual(['kiosk-no-ref', 'table-no-ref'])
  })

  it('the actionable channel is named, not spelled inline', () => {
    expect(SWEEP_ACTIONABLE_CHANNEL).toBe('pos')
  })
})
