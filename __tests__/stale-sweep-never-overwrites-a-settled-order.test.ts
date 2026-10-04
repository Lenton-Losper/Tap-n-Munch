import { autoCancelStalePosOrders } from '@/lib/orders/auto-cancel-stale-pos-orders'

/**
 * SAFETY INVARIANT: the stale-POS sweep cannot cancel an order that was paid while it was deciding.
 *
 * The sweep READS a pending order, then asks Finatic -- a network call that takes real time -- and
 * only then writes. A terminal callback can land in that gap and mark the order paid. The cancel
 * must lose that race: it re-asserts `.eq('payment_status', 'pending')` on the write, so a row that
 * is no longer pending matches nothing.
 *
 * The staff cancel route has this test (staff-cancel-reason-and-audit). The sweep's own cancel did
 * not, so the guard could be deleted with every sweep suite still green. This double STORES rows and
 * applies `.eq()` on writes, so a missing guard overwrites the stored row and the test sees it.
 */
type Row = Record<string, unknown>

const ORDER = 'order-paid-mid-sweep'
const RESTAURANT = 'rest-1'

function makeSupabase(orders: Row[]) {
  const client = {
    from(table: string) {
      const eqs: Array<[string, unknown]> = []
      let ins: { col: string; vals: unknown[] } | null = null
      let op: 'select' | 'update' = 'select'
      let patch: Row = {}
      const chain: Record<string, unknown> = {}
      const self = () => chain
      const matching = () =>
        table !== 'orders'
          ? []
          : orders.filter(
              (o) =>
                eqs.every(([c, v]) => String(o[c] ?? '') === String(v)) &&
                (!ins || ins.vals.map(String).includes(String(o[ins.col]))),
            )
      const resolve = () => {
        if (op === 'update') {
          const hit = matching()
          for (const row of hit) Object.assign(row, patch)
          return { data: hit.map((o) => ({ ...o })), error: null }
        }
        return { data: matching().map((o) => ({ ...o })), error: null }
      }
      chain.select = () => self()
      chain.insert = () => ({ error: null })
      chain.update = (p: Row) => {
        op = 'update'
        patch = p
        return self()
      }
      chain.eq = (c: string, v: unknown) => {
        eqs.push([c, v])
        return self()
      }
      chain.in = (c: string, vals: unknown[]) => {
        ins = { col: c, vals }
        return self()
      }
      for (const m of ['lt', 'gte', 'is', 'order', 'limit']) chain[m] = () => self()
      chain.range = (from: number) => Promise.resolve(from === 0 ? resolve() : { data: [], error: null })
      chain.then = (onResolve: (v: unknown) => unknown) => Promise.resolve(resolve()).then(onResolve)
      return chain
    },
  }
  return client as never
}

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'm', storeNo: 's' }),
}))
// No money is recorded against the order at READ time -- that is what makes it a cancel candidate.
jest.mock('@/lib/orders/paid-order-cancellation', () => ({
  findOrdersWithMoney: async () => new Set<string>(),
  recordAutoCancelRefusals: async () => {},
}))
jest.mock('@/lib/orders/order-lines', () => ({
  voidOutstandingOrderLines: async () => ({ voided: 0 }),
}))

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('the stale-POS sweep against a payment that lands mid-decision', () => {
  it('does NOT cancel an order a terminal callback paid while Finatic was being asked', async () => {
    const order: Row = {
      id: ORDER,
      restaurant_id: RESTAURANT,
      total: 50,
      channel: 'pos',
      tab_id: null,
      payment_status: 'pending',
      status: 'pending',
      paycloud_merchant_order_no: 'FT-RACE-1',
    }
    const client = makeSupabase([order])

    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: (async () => {
        // The concurrent terminal callback, landing while the sweep waits on the gateway.
        order.payment_status = 'paid'
        order.status = 'completed'
        // Finatic's answer was formed before the payment registered: recognised, not paid.
        return { paid: false, statusRecognised: true, status: '1', amount: null, transactionId: null }
      }) as never,
    })

    expect(order.payment_status).toBe('paid')
    expect(order.status).toBe('completed')
    expect(result.cancelledIds).not.toContain(ORDER)
  })

  it('positive control: the same order, NOT paid mid-sweep, IS cancelled on a recognised not-paid answer', async () => {
    // Without this, "not cancelled" above could just mean this double never lets a cancel through.
    const order: Row = {
      id: ORDER,
      restaurant_id: RESTAURANT,
      total: 50,
      channel: 'pos',
      tab_id: null,
      payment_status: 'pending',
      status: 'pending',
      paycloud_merchant_order_no: 'FT-RACE-1',
    }
    const client = makeSupabase([order])

    const result = await autoCancelStalePosOrders(client, {
      verifyWithFinatic: true,
      queryFinaticOrderPaidFn: (async () => ({
        paid: false,
        statusRecognised: true,
        status: '1',
        amount: null,
        transactionId: null,
      })) as never,
    })

    expect(order.payment_status).toBe('cancelled')
    expect(result.cancelledIds).toContain(ORDER)
  })
})
