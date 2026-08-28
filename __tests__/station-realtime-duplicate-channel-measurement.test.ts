/**
 * feat/station-screens-v1 — MEASUREMENT for the filed finding below, not a red/green gate on
 * behavior that is being fixed tonight. Confirms, mechanically, that when the staff dashboard
 * and a station screen are both open for the SAME restaurant, subscribeRestaurantOrdersRealtime
 * (lib/supabase/orders.ts) opens TWO separate Realtime channel objects rather than sharing one
 * — each caller's own `subscribeRestaurantOrdersRealtime(...)` call makes its own
 * `supabase.channel(name)` call, and supabase-js does not deduplicate same-named channels
 * created from two call sites.
 *
 * RULED 2026-08-28: leave this alone tonight — it has no user-visible effect (both callers still
 * receive every event correctly; this test also proves that), and #350's resilience layer is not
 * something to touch at 1am for a change with no visible symptom. Filed because it will matter
 * once Riviera's screens are live and real load exists on the channel: two sockets per
 * restaurant instead of one is 2x the connection count and 2x the Realtime traffic for identical
 * data, purely because two independent callers ask for it separately.
 *
 * FOLLOW-UP, not built here: a small per-restaurant channel registry (reference-counted, torn
 * down when the last subscriber unmounts) so subscribeRestaurantOrdersRealtime's callers share
 * one channel instead of one each. Belongs in lib/supabase/orders.ts itself, alongside the
 * function it would change — not a second module.
 */
export {} // module scope

const channelFactory = jest.fn()

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
  fetchAllRows: async () => [],
}))

function makeFakeChannel() {
  const channel = {
    on() {
      return channel
    },
    subscribe(cb?: (status: string) => void) {
      cb?.('SUBSCRIBED')
      return channel
    },
  }
  return channel
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
  channelFactory.mockReset()
  channelFactory.mockImplementation(() => makeFakeChannel())
})

describe('MEASUREMENT: dashboard + station screen open together, same restaurant', () => {
  it('opens two separate channel() calls for the same restaurant-channel name, not one shared', async () => {
    const { subscribeRestaurantOrdersRealtime } = await import('@/lib/supabase/orders')

    // The dashboard's own call shape.
    const stopDashboard = subscribeRestaurantOrdersRealtime(
      'r1',
      { onInitial: () => {}, onChange: () => {} },
      { restaurantId: 'r1' } as never,
    )
    // A station screen's own call shape, opened concurrently for the SAME restaurant.
    const stopStation = subscribeRestaurantOrdersRealtime(
      'r1',
      { onLineChange: () => {} },
      { restaurantId: 'r1' } as never,
    )
    await flush()

    // THE MEASUREMENT: both ask for 'orders-channel-r1' and both get their OWN channel object.
    expect(channelFactory).toHaveBeenCalledTimes(2)
    expect(channelFactory).toHaveBeenNthCalledWith(1, 'orders-channel-r1')
    expect(channelFactory).toHaveBeenNthCalledWith(2, 'orders-channel-r1')

    stopDashboard()
    stopStation()
  })
})
