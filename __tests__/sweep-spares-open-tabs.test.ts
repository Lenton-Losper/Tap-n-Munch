/**
 * THE SWEEP MUST NOT CANCEL A MEAL IN PROGRESS.
 *
 * Measured on PRODUCTION 2026-08-28, Digi Cofee, Table 1, tab 2a5b2794:
 *
 *   order  total  payment_status  paid_at  placed_at  cancelled_at  reason
 *   #30        3  cancelled       null     09:23:38   09:26:46      auto_timeout
 *   #31        5  cancelled       null     09:29:11   09:32:14      auto_timeout
 *   #32       11  cancelled       null     09:32:11   09:34:14      auto_timeout
 *
 * Three live rounds, cancelled two to three minutes after being placed, on a tab still `open`
 * with `settled_at: null`. Their order_lines were already `kitchen_state: 'ready'` — the kitchen
 * cooked and passed food against orders the database had marked cancelled, and nothing on the
 * terminal said so. NAD 19 of food that can never be billed.
 *
 * A waiter-led round writes `channel: 'pos'` and `payment_status: 'pending'` because it IS unpaid,
 * and it stays unpaid for the whole meal by design. On the candidate query alone that is
 * indistinguishable from a card payment the customer walked away from.
 *
 * NOT FIXED BY A LONGER TIMEOUT. A two-hour dinner is not a slower payment, it is a different
 * lifecycle. Any timeout that survives a real service is far too long to catch the abandoned
 * attempt this sweep exists for, and would still cancel the meal that ran long.
 *
 * THE CONTROL IS THE POINT OF THIS FILE. "An order on an open tab is not cancelled" passes
 * trivially if the sweep cancels nothing at all — a broken query, a thrown error, an empty
 * fixture. Every protection test below is paired with an identical order on a CLOSED tab that
 * MUST still be cancelled. Only the pair distinguishes "spares meals" from "does nothing".
 */
import { autoCancelStalePosOrders } from '@/lib/orders/auto-cancel-stale-pos-orders'

const RESTAURANT = 'rest-1'

type Row = Record<string, unknown>

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'm', storeNo: 's' }),
}))

/**
 * `openTabIds` is what the `tabs` read answers with. `tabsFail` makes that read error, which is
 * how the fail-closed posture is exercised.
 */
function makeSupabase(orders: Row[], openTabIds: string[], tabsFail = false) {
  const updates: Row[] = []
  const cancelledIds: string[] = []

  const client = {
    from(table: string) {
      const state = { action: 'select', updateIds: [] as string[] }
      const chain: Record<string, unknown> = {}
      const self = () => chain

      chain.select = () => self()
      chain.insert = () => ({ error: null })
      chain.update = (patch: Row) => {
        state.action = 'update'
        updates.push({ table, ...patch })
        return self()
      }
      chain.eq = () => self()
      chain.lt = () => self()
      chain.is = () => self()
      chain.order = () => self()
      chain.limit = () => self()
      chain.in = (col: string, vals: unknown) => {
        if (table === 'orders' && state.action === 'update' && col === 'id') {
          state.updateIds = (vals as unknown[]).map(String)
        }
        return self()
      }
      chain.range = (from: number) => {
        if (table === 'orders' && from === 0) {
          return Promise.resolve({ data: orders, error: null })
        }
        return Promise.resolve({ data: [], error: null })
      }
      chain.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'tabs') {
          if (tabsFail) {
            return Promise.resolve({
              data: null,
              error: { message: 'tabs unavailable' },
            }).then(resolve)
          }
          return Promise.resolve({
            data: openTabIds.map((id) => ({ id })),
            error: null,
          }).then(resolve)
        }
        if (table === 'orders' && state.action === 'update') {
          const claimed = orders.filter((o) => state.updateIds.includes(String(o.id)))
          for (const c of claimed) cancelledIds.push(String(c.id))
          return Promise.resolve({ data: claimed, error: null }).then(resolve)
        }
        return Promise.resolve({ data: [], error: null }).then(resolve)
      }
      return chain
    },
  }
  return { client: client as never, updates, cancelledIds }
}

/** A waiter-led round: pos channel, no gateway reference, sitting on a tab. */
const round = (id: string, tabId: string | null) => ({
  id,
  restaurant_id: RESTAURANT,
  total: 5,
  channel: 'pos',
  tab_id: tabId,
  paycloud_merchant_order_no: null,
})

describe('a round on an OPEN tab survives the sweep', () => {
  it('does not cancel it, and says so rather than dropping it silently', async () => {
    const { client, cancelledIds, updates } = makeSupabase(
      [round('digi-30', 'tab-open')],
      ['tab-open'],
    )
    const result = await autoCancelStalePosOrders(client)

    expect(cancelledIds).toEqual([])
    // The negative assertion that matters: no write of any kind reached orders.
    expect(updates.filter((u) => u.table === 'orders')).toEqual([])
    expect(result.cancelledIds).toEqual([])

    // Skipped, not invisible. A sweep that quietly drops rows is indistinguishable from one
    // whose query is broken.
    expect(result.skippedOpenTabCount).toBe(1)
    expect(result.skippedOpenTabIds).toEqual(['digi-30'])
  })

  /**
   * THE CONTROL. Identical order, identical age, identical channel — the ONLY difference is that
   * its tab is not open. If this does not cancel, the test above proves nothing.
   */
  it('CONTROL: the same order on a CLOSED tab is still cancelled', async () => {
    const { client, cancelledIds } = makeSupabase([round('abandoned', 'tab-closed')], [])
    const result = await autoCancelStalePosOrders(client)

    expect(cancelledIds).toEqual(['abandoned'])
    expect(result.cancelledIds).toEqual(['abandoned'])
    expect(result.skippedOpenTabCount).toBe(0)
  })

  it('CONTROL: an order on NO tab at all is still cancelled', async () => {
    const { client, cancelledIds } = makeSupabase([round('no-tab', null)], ['tab-open'])
    await autoCancelStalePosOrders(client)
    expect(cancelledIds).toEqual(['no-tab'])
  })

  it('sweeps the abandoned one and spares the meal in the SAME run', async () => {
    const { client, cancelledIds } = makeSupabase(
      [round('meal', 'tab-open'), round('abandoned', 'tab-closed')],
      ['tab-open'],
    )
    const result = await autoCancelStalePosOrders(client)

    // Both halves in one pass: this is the discrimination, not merely a global on/off.
    expect(cancelledIds).toEqual(['abandoned'])
    expect(result.skippedOpenTabIds).toEqual(['meal'])
  })

  /**
   * If the tabs read fails, a live meal cannot be told from an abandoned payment. Cancelling on
   * an empty protected set would destroy real orders whenever a query hiccups — the exact outcome
   * being fixed — so the run does nothing instead.
   */
  it('sweeps NOTHING when the tabs read fails, rather than assuming no tab is open', async () => {
    const { client, cancelledIds, updates } = makeSupabase(
      [round('meal', 'tab-open'), round('abandoned', 'tab-closed')],
      [],
      true,
    )
    const result = await autoCancelStalePosOrders(client)

    expect(cancelledIds).toEqual([])
    expect(updates.filter((u) => u.table === 'orders')).toEqual([])
    expect(result.cancelledIds).toEqual([])
  })

  /** The three real production ids, as the regression they are. */
  it('spares the three Digi Cofee rounds that were actually cancelled on production', async () => {
    const { client, cancelledIds } = makeSupabase(
      [round('digi-30', 'digi-tab'), round('digi-31', 'digi-tab'), round('digi-32', 'digi-tab')],
      ['digi-tab'],
    )
    const result = await autoCancelStalePosOrders(client)

    expect(cancelledIds).toEqual([])
    expect(result.skippedOpenTabIds.sort()).toEqual(['digi-30', 'digi-31', 'digi-32'])
  })
})
