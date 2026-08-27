/**
 * #350 — THE STATUS CALLBACK MUST ACTUALLY REACH THE CALLER.
 *
 * `subscribeRestaurantOrdersRealtime` declared `onStatus` and forwarded it into `.subscribe()`
 * from the day it was written, and no caller anywhere ever passed one — so nothing had ever
 * executed that line. `subscribeOrderRequestsRealtime`, which carries the QR order requests, was
 * worse: a bare `.subscribe()` with no callback at all.
 *
 * This drives both helpers with a fake Supabase channel and asserts the real status string a
 * dropped socket produces comes back out. Reading the source is not evidence that it does.
 *
 * Hermetic: the Supabase browser client and the row fetcher are both mocked; nothing goes near a
 * network or a database.
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

// The initial load is not what is under test here.
jest.mock('@/lib/supabase/fetch-all-rows', () => ({
  fetchAllRows: async () => [],
}))

type StatusListener = (status: string) => void

/** A channel that hands back whatever `.subscribe()` was given, so a test can fire statuses. */
function makeFakeChannel() {
  let listener: StatusListener | null = null
  const channel = {
    on() {
      return channel
    },
    subscribe(cb?: StatusListener) {
      listener = cb ?? null
      return channel
    },
    /** null means `.subscribe()` was called with nothing — the original defect. */
    listener: () => listener,
  }
  return channel
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
  channelFactory.mockReset()
})

describe('#350 subscribeRestaurantOrdersRealtime', () => {
  it('hands the channel status to onStatus', async () => {
    const fake = makeFakeChannel()
    channelFactory.mockReturnValue(fake)

    const { subscribeRestaurantOrdersRealtime } = await import('@/lib/supabase/orders')
    const seen: string[] = []
    const stop = subscribeRestaurantOrdersRealtime(
      'r1',
      { onInitial: () => {}, onChange: () => {}, onStatus: (s) => seen.push(s) },
      { restaurantId: 'r1' } as never,
    )
    await flush()

    const listener = fake.listener()
    expect(listener).toBeTruthy()
    listener!('SUBSCRIBED')
    listener!('CHANNEL_ERROR')
    listener!('SUBSCRIBED')
    expect(seen).toEqual(['SUBSCRIBED', 'CHANNEL_ERROR', 'SUBSCRIBED'])
    stop()
  })
})

describe('#350 subscribeOrderRequestsRealtime', () => {
  it('no longer calls subscribe() with nothing, and forwards the status', async () => {
    const fake = makeFakeChannel()
    channelFactory.mockReturnValue(fake)

    const { subscribeOrderRequestsRealtime } = await import('@/lib/supabase/order-requests')
    const seen: string[] = []
    const stop = subscribeOrderRequestsRealtime(
      'r1',
      { onInitial: () => {}, onChange: () => {}, onStatus: (s) => seen.push(s) },
      { restaurantId: 'r1' } as never,
    )
    await flush()

    const listener = fake.listener()
    // A bare `.subscribe()` is what let this channel die in silence.
    expect(listener).toBeTruthy()
    listener!('TIMED_OUT')
    expect(seen).toEqual(['TIMED_OUT'])
    stop()
  })
})
