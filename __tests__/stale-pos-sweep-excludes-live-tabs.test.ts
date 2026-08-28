import { autoCancelStalePosOrders } from '@/lib/orders/auto-cancel-stale-pos-orders'

/**
 * Digi Cofee, 2026-08-28: three waiter-led rounds -- `channel: 'pos'`, `payment_status:
 * 'pending'`, `tab_id` set, no gateway reference by design (cash) -- were auto-cancelled by this
 * sweep 2-3 minutes after being sent, because to the sweep they were indistinguishable from a
 * stuck counter card payment. NAD 19 of food cooked and served, never billed.
 *
 * PROVES: an order attached to a tab that is still `open` survives past the sweep window
 * (STALE_POS_TIMEOUT_MS) untouched, while an ordinary counter sale with no tab_id past the same
 * window is still cancelled exactly as before -- the counter-service case this sweep exists for
 * must not be weakened by this fix.
 */
const RESTAURANT = 'rest-digi'
const OPEN_TAB_ID = 'tab-open'
const CLOSED_TAB_ID = 'tab-closed'
const WAITER_ROUND_ID = 'order-waiter-round'
const CLOSED_TAB_ORDER_ID = 'order-on-closed-tab'
const COUNTER_ORDER_ID = 'order-counter-sale'

type Row = Record<string, unknown>

function orderRows(): Row[] {
  return [
    {
      id: WAITER_ROUND_ID,
      restaurant_id: RESTAURANT,
      total: 5,
      channel: 'pos',
      paycloud_merchant_order_no: null,
      tab_id: OPEN_TAB_ID,
    },
    {
      id: CLOSED_TAB_ORDER_ID,
      restaurant_id: RESTAURANT,
      total: 7,
      channel: 'pos',
      paycloud_merchant_order_no: null,
      tab_id: CLOSED_TAB_ID,
    },
    {
      id: COUNTER_ORDER_ID,
      restaurant_id: RESTAURANT,
      total: 11,
      channel: 'pos',
      paycloud_merchant_order_no: null,
      tab_id: null,
    },
  ]
}

/** `tabs` sees only OPEN_TAB_ID: the .in('status', LIVE_TAB_STATUSES) filter excludes the closed one. */
function tabRows(): Row[] {
  return [{ id: OPEN_TAB_ID, status: 'open' }]
}

function makeSupabase() {
  const cancelledIds: string[] = []
  const inserted: Row[] = []

  const client = {
    from(table: string) {
      const state: { action: string } = { action: 'select' }
      const chain: Record<string, unknown> = {}
      const self = () => chain

      chain.select = () => self()
      chain.insert = (row: Row | Row[]) => {
        if (table === 'audit_logs') inserted.push(...(Array.isArray(row) ? row : [row]))
        return { error: null }
      }
      chain.update = () => {
        state.action = 'update'
        return self()
      }
      chain.eq = () => self()
      chain.lt = () => self()
      chain.in = (col: string, vals: string[]) => {
        if (table === 'orders' && state.action === 'update' && col === 'id') {
          cancelledIds.push(...vals)
        }
        return self()
      }
      chain.is = () => self()
      chain.order = () => self()
      chain.limit = () => self()
      chain.range = (from: number) =>
        Promise.resolve(
          table === 'orders' && state.action === 'select' && from === 0
            ? { data: orderRows(), error: null }
            : { data: [], error: null },
        )
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'tabs') {
          return Promise.resolve({ data: tabRows(), error: null }).then(resolve)
        }
        if (table === 'orders' && state.action === 'update') {
          // The cancel write's own .select() echo -- one row per id this call just cancelled.
          return Promise.resolve({
            data: cancelledIds.map((id) => ({
              id,
              restaurant_id: RESTAURANT,
              total: 0,
              paycloud_merchant_order_no: null,
            })),
            error: null,
          }).then(resolve)
        }
        return Promise.resolve({ data: [], error: null }).then(resolve)
      }
      return chain
    },
  }
  return { client: client as never, cancelledIds, inserted }
}

describe('the stale-POS sweep excludes orders on a live tab', () => {
  it('a waiter round on an OPEN tab survives past the sweep window untouched', async () => {
    const { client, cancelledIds } = makeSupabase()
    const result = await autoCancelStalePosOrders(client)

    expect(result.cancelledIds).not.toContain(WAITER_ROUND_ID)
    expect(cancelledIds).not.toContain(WAITER_ROUND_ID)
  })

  it('an order left on a CLOSED tab is still reachable -- only an open tab protects it', async () => {
    const { client } = makeSupabase()
    const result = await autoCancelStalePosOrders(client)

    expect(result.cancelledIds).toContain(CLOSED_TAB_ORDER_ID)
  })

  it('an ordinary counter sale with no tab_id is cancelled exactly as before', async () => {
    const { client } = makeSupabase()
    const result = await autoCancelStalePosOrders(client)

    expect(result.cancelledIds).toContain(COUNTER_ORDER_ID)
  })

  it('the waiter round is not surfaced as needing human review either -- it is not an anomaly', async () => {
    const { client } = makeSupabase()
    const result = await autoCancelStalePosOrders(client)

    expect(result.surfacedNeedsHumanIds).not.toContain(WAITER_ROUND_ID)
  })
})
