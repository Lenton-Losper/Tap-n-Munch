/**
 * feat/station-screens-v1 — RULED: reuse subscribeRestaurantOrdersRealtime rather than write a
 * second subscriber for order_lines. This proves the EXTENSION, not just reads the source:
 * `onLineChange` actually receives an order_lines postgres_changes payload on the same channel,
 * `onChange`/`onInitial` remaining untouched proves nothing forked, and a lines-only caller
 * (onInitial/onChange both omitted) never touches the orders fetch or subscription at all.
 *
 * Hermetic, same fake-channel technique as __tests__/350-subscribe-helpers-forward-channel-
 * status.test.ts: nothing goes near a network or a database.
 */
export {} // module scope

const channelFactory = jest.fn()
const fetchAllRowsMock = jest.fn(async (_args: unknown[]) => [])

jest.mock('@/lib/supabase/client', () => ({
  supabase: {
    channel: (...args: unknown[]) => channelFactory(...args),
    removeChannel: jest.fn(),
    from: () => {
      const chain: Record<string, unknown> = {}
      for (const key of ['select', 'eq', 'in', 'order', 'limit']) chain[key] = () => chain
      return chain
    },
  },
  getSupabaseClient: () => ({}),
}))

jest.mock('@/lib/supabase/fetch-all-rows', () => ({
  fetchAllRows: (...args: unknown[]) => fetchAllRowsMock(args),
}))

type OnCall = {
  event: string
  config: { table: string; event?: string; schema?: string; filter?: string }
  handler: (payload: any) => void
}

/** Captures every `.on()` registration so a test can fire a fake postgres_changes payload. */
function makeFakeChannel() {
  const calls: OnCall[] = []
  const channel = {
    on(event: string, config: OnCall['config'], handler: (payload: unknown) => void) {
      calls.push({ event, config, handler })
      return channel
    },
    subscribe(cb?: (status: string) => void) {
      cb?.('SUBSCRIBED')
      return channel
    },
    calls: () => calls,
  }
  return channel
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
  channelFactory.mockReset()
  fetchAllRowsMock.mockClear()
})

describe('subscribeRestaurantOrdersRealtime, extended for order_lines', () => {
  it('onLineChange receives an order_lines change on the same channel', async () => {
    const fake = makeFakeChannel()
    channelFactory.mockReturnValue(fake)

    const { subscribeRestaurantOrdersRealtime } = await import('@/lib/supabase/orders')
    const lineChanges: unknown[] = []
    const stop = subscribeRestaurantOrdersRealtime(
      'r1',
      { onLineChange: (payload) => lineChanges.push(payload) },
      { restaurantId: 'r1' } as never,
    )
    await flush()

    const lineSubscription = fake.calls().find((c) => c.config.table === 'order_lines')
    expect(lineSubscription).toBeTruthy()
    lineSubscription!.handler({ eventType: 'UPDATE', new: { id: 'l1' }, old: { id: 'l1' } })

    expect(lineChanges).toEqual([{ eventType: 'UPDATE', new: { id: 'l1' }, old: { id: 'l1' } }])
    stop()
  })

  it('is one channel, not two: exactly one channel() call carries both subscriptions', async () => {
    const fake = makeFakeChannel()
    channelFactory.mockReturnValue(fake)

    const { subscribeRestaurantOrdersRealtime } = await import('@/lib/supabase/orders')
    const stop = subscribeRestaurantOrdersRealtime(
      'r1',
      { onInitial: () => {}, onChange: () => {}, onLineChange: () => {} },
      { restaurantId: 'r1' } as never,
    )
    await flush()

    expect(channelFactory).toHaveBeenCalledTimes(1)
    expect(fake.calls().map((c) => c.config.table).sort()).toEqual(['order_lines', 'orders'])
    stop()
  })

  it('a lines-only caller (no onInitial/onChange) never fetches or subscribes to orders', async () => {
    const fake = makeFakeChannel()
    channelFactory.mockReturnValue(fake)

    const { subscribeRestaurantOrdersRealtime } = await import('@/lib/supabase/orders')
    const stop = subscribeRestaurantOrdersRealtime(
      'r1',
      { onLineChange: () => {} },
      { restaurantId: 'r1' } as never,
    )
    await flush()

    expect(fetchAllRowsMock).not.toHaveBeenCalled()
    expect(fake.calls().map((c) => c.config.table)).toEqual(['order_lines'])
    stop()
  })

  it('an existing orders-only caller is unaffected: no order_lines subscription is added uninvited', async () => {
    const fake = makeFakeChannel()
    channelFactory.mockReturnValue(fake)

    const { subscribeRestaurantOrdersRealtime } = await import('@/lib/supabase/orders')
    const stop = subscribeRestaurantOrdersRealtime(
      'r1',
      { onInitial: () => {}, onChange: () => {} },
      { restaurantId: 'r1' } as never,
    )
    await flush()

    expect(fake.calls().map((c) => c.config.table)).toEqual(['orders'])
    stop()
  })

  /**
   * Answers directly: "does anything an existing dashboard user would see change?" — this
   * mounts the EXACT call shape components/orders-dashboard.tsx uses (onInitial, onChange,
   * onStatus, no onLineChange — see that file's own subscribeRestaurantOrdersRealtime call
   * site) and asserts every observable detail is unchanged: the channel name, the
   * postgres_changes filter config verbatim, the onInitial data, the onChange payload shape for
   * each event type, and onStatus forwarding. Not "no order_lines table appears" (already
   * covered above) — this is "everything about the orders path is byte-identical."
   */
  it('the dashboard call shape is byte-identical: channel name, filter config, payload shape, status forwarding', async () => {
    const fake = makeFakeChannel()
    channelFactory.mockReturnValue(fake)

    const { subscribeRestaurantOrdersRealtime } = await import('@/lib/supabase/orders')
    const initial: unknown[] = []
    const changes: unknown[] = []
    const statuses: string[] = []

    const stop = subscribeRestaurantOrdersRealtime(
      'r1',
      {
        onInitial: (orders) => initial.push(orders),
        onChange: (payload) => changes.push(payload),
        onStatus: (status) => statuses.push(status),
      },
      { restaurantId: 'r1' } as never,
    )
    await flush()

    // Same channel name shape this function has always used.
    expect(channelFactory).toHaveBeenCalledWith('orders-channel-r1')

    // The exact postgres_changes registration a dashboard subscriber has always gotten.
    const ordersCall = fake.calls().find((c) => c.config.table === 'orders')!
    expect(ordersCall.event).toBe('postgres_changes')
    expect(ordersCall.config).toEqual({
      event: '*',
      schema: 'public',
      table: 'orders',
      filter: 'restaurant_id=eq.r1',
    })

    // onInitial still fires with the fetched rows (fetchAllRows mocked to [] above).
    expect(initial).toEqual([[]])

    // onChange still forwards INSERT/UPDATE/DELETE with the same { eventType, new, old } shape,
    // and still drops anything that isn't one of those three.
    ordersCall.handler({ eventType: 'INSERT', new: { id: 'o1' }, old: null })
    ordersCall.handler({ eventType: 'UPDATE', new: { id: 'o1', status: 'ready' }, old: { id: 'o1' } })
    ordersCall.handler({ eventType: 'DELETE', new: null, old: { id: 'o1' } })
    ordersCall.handler({ eventType: 'HEARTBEAT' } as never)
    expect(changes).toEqual([
      { eventType: 'INSERT', new: { id: 'o1' }, old: null },
      { eventType: 'UPDATE', new: { id: 'o1', status: 'ready' }, old: { id: 'o1' } },
      { eventType: 'DELETE', new: null, old: { id: 'o1' } },
    ])

    // Status still reaches onStatus untouched, same as #350's own test proves in isolation —
    // the fake channel's subscribe() fires 'SUBSCRIBED' during setup above.
    expect(statuses).toEqual(['SUBSCRIBED'])

    stop()
  })
})
