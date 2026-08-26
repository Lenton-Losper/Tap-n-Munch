/**
 * #350 — THE LIVE ORDERS FEED MUST NOTICE WHEN IT STOPS BEING FED.
 *
 * The defect these assertions exist for: a dropped Realtime socket froze the only order surface
 * staff have, and nothing on the page said so. The 60-second clock tick kept advancing relative
 * timestamps on frozen data, so the screen looked alive; the new-order chime fires from inside the
 * subscription callback, so no event meant no sound either. A frozen list was indistinguishable
 * from a quiet kitchen.
 *
 * WHAT IS ACTUALLY PROVEN HERE is behaviour, not shape. The load-bearing one is
 * `refetches on a RETURN to SUBSCRIBED` — resubscribing alone leaves the list permanently missing
 * whatever Postgres changed while the socket was away, because Realtime does not replay it.
 *
 * Hermetic: no network, no Supabase, no DOM. `startFeedFallback` takes its event hosts by
 * injection precisely so this suite does not need jsdom.
 */
export {} // module scope

import {
  classifyChannelStatus,
  registerFeedChannel,
  reportFeedChannelStatus,
  getFeedConnectionState,
  subscribeFeedConnectionState,
  resetFeedConnection,
  startFeedFallback,
  FEED_OFFLINE_AFTER_MS,
  FEED_DOWN_STATUSES,
  FEED_POLL_INTERVAL_MS,
} from '@/lib/dashboard/realtime-connection'

type Listener = () => void

/** A stand-in for `document` / `window` that records what was registered and lets tests fire it. */
function fakeHost() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener)
    },
    fire(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

beforeEach(() => {
  resetFeedConnection()
})

afterEach(() => {
  jest.useRealTimers()
  resetFeedConnection()
})

describe('#350 channel status vocabulary', () => {
  it('reads SUBSCRIBED as up', () => {
    expect(classifyChannelStatus('SUBSCRIBED')).toBe('up')
  })

  it.each(FEED_DOWN_STATUSES.map((s) => [s]))('reads %s as down', (status) => {
    // All three were unhandled everywhere in the repo before this issue.
    expect(classifyChannelStatus(status)).toBe('down')
  })

  it('never guesses "up" from an unknown status', () => {
    // Guessing up is the one direction that would re-create the defect: a channel presumed healthy
    // that is not receiving.
    for (const status of ['', null, undefined, 'JOINING', 'whatever']) {
      expect(classifyChannelStatus(status)).not.toBe('up')
    }
  })
})

describe('#350 refetch on reconnect, not just resubscribe', () => {
  it('does NOT ask for a refetch on the first SUBSCRIBED', () => {
    // The subscribe helper fetches the initial list itself. Refetching here would double the
    // query on every single mount.
    registerFeedChannel('orders:r1')
    expect(reportFeedChannelStatus('orders:r1', 'SUBSCRIBED').refetch).toBe(false)
  })

  it.each(FEED_DOWN_STATUSES.map((s) => [s]))(
    'DOES ask for a refetch when the socket returns after %s',
    (down) => {
      registerFeedChannel('orders:r1')
      reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')

      const dropped = reportFeedChannelStatus('orders:r1', down)
      expect(dropped.refetch).toBe(false)
      expect(dropped.state).not.toBe('live')

      // THIS IS THE POINT OF THE ISSUE. Postgres changes during the gap are gone; a socket that
      // comes back does not backfill them. Resubscribing without refetching leaves the list
      // permanently missing a window of orders while looking healthy.
      const back = reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
      expect(back.refetch).toBe(true)
      expect(back.state).toBe('live')
    },
  )

  it('does not ask twice for one reconnect', () => {
    registerFeedChannel('orders:r1')
    reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    reportFeedChannelStatus('orders:r1', 'TIMED_OUT')
    expect(reportFeedChannelStatus('orders:r1', 'SUBSCRIBED').refetch).toBe(true)
    expect(reportFeedChannelStatus('orders:r1', 'SUBSCRIBED').refetch).toBe(false)
  })

  it('tracks each channel separately', () => {
    registerFeedChannel('orders:r1')
    registerFeedChannel('order_requests:r1')
    reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    reportFeedChannelStatus('order_requests:r1', 'SUBSCRIBED')

    reportFeedChannelStatus('order_requests:r1', 'CHANNEL_ERROR')
    // The orders channel never dropped, so its next SUBSCRIBED is not a reconnect.
    expect(reportFeedChannelStatus('orders:r1', 'SUBSCRIBED').refetch).toBe(false)
    expect(reportFeedChannelStatus('order_requests:r1', 'SUBSCRIBED').refetch).toBe(true)
  })
})

describe('#350 the state is observable, and reports the worst channel', () => {
  it('opens as reconnecting, never as live', () => {
    // Claiming "live" before any channel has joined would be the indicator lying at first paint.
    expect(getFeedConnectionState()).toBe('reconnecting')
    registerFeedChannel('orders:r1')
    expect(getFeedConnectionState()).toBe('reconnecting')
  })

  it('is live only when every registered channel is up', () => {
    registerFeedChannel('orders:r1')
    registerFeedChannel('tabs:r1')
    reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    expect(getFeedConnectionState()).not.toBe('live')
    reportFeedChannelStatus('tabs:r1', 'SUBSCRIBED')
    expect(getFeedConnectionState()).toBe('live')
  })

  it('notifies subscribers on every change — it is not read once', () => {
    // Same reason the sound indicator subscribes: an indicator read once at mount would go stale,
    // and a stale indicator lies about the one thing it exists to report.
    const seen: string[] = []
    subscribeFeedConnectionState(() => seen.push(getFeedConnectionState()))

    registerFeedChannel('orders:r1')
    reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    reportFeedChannelStatus('orders:r1', 'CLOSED')
    reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')

    expect(seen).toEqual(['live', 'reconnecting', 'live'])
  })

  it('escalates to offline on its own when a dead channel says nothing further', () => {
    jest.useFakeTimers()
    registerFeedChannel('orders:r1')
    reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    reportFeedChannelStatus('orders:r1', 'CHANNEL_ERROR')
    expect(getFeedConnectionState()).toBe('reconnecting')

    // A channel that drops and then goes quiet is the exact shape of the bug. Without a timer the
    // indicator would read "reconnecting" for the rest of the shift.
    jest.advanceTimersByTime(FEED_OFFLINE_AFTER_MS + 1_000)
    expect(getFeedConnectionState()).toBe('offline')
  })

  it('drops back to live from offline when the channel returns', () => {
    jest.useFakeTimers()
    registerFeedChannel('orders:r1')
    reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    reportFeedChannelStatus('orders:r1', 'TIMED_OUT')
    jest.advanceTimersByTime(FEED_OFFLINE_AFTER_MS + 1_000)
    expect(getFeedConnectionState()).toBe('offline')

    const back = reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    expect(back.state).toBe('live')
    expect(back.refetch).toBe(true)
  })

  it('a torn-down channel stops counting against the state', () => {
    registerFeedChannel('orders:r1')
    reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    const unregister = registerFeedChannel('tabs:r1')
    expect(getFeedConnectionState()).toBe('reconnecting')
    unregister()
    // Otherwise a scope change would leave a phantom outage on screen forever.
    expect(getFeedConnectionState()).toBe('live')
  })
})

describe('#350 the fallbacks — a permanently dead socket still updates', () => {
  it('polls on a slow interval', () => {
    jest.useFakeTimers()
    const refetch = jest.fn()
    const stop = startFeedFallback({
      refetch,
      isHidden: () => false,
      visibilityHost: null,
      networkHost: null,
    })

    jest.advanceTimersByTime(FEED_POLL_INTERVAL_MS * 2 + 10)
    expect(refetch).toHaveBeenCalledTimes(2)
    expect(refetch).toHaveBeenCalledWith('poll')
    stop()
  })

  it('stops polling once torn down', () => {
    jest.useFakeTimers()
    const refetch = jest.fn()
    const stop = startFeedFallback({
      refetch,
      isHidden: () => false,
      visibilityHost: null,
      networkHost: null,
    })
    stop()
    jest.advanceTimersByTime(FEED_POLL_INTERVAL_MS * 3)
    expect(refetch).not.toHaveBeenCalled()
  })

  it('does not poll a hidden tab, but refetches the moment it becomes visible', () => {
    jest.useFakeTimers()
    const refetch = jest.fn()
    const doc = fakeHost()
    let hidden = true
    const stop = startFeedFallback({
      refetch,
      isHidden: () => hidden,
      visibilityHost: doc,
      networkHost: null,
    })

    jest.advanceTimersByTime(FEED_POLL_INTERVAL_MS * 3)
    expect(refetch).not.toHaveBeenCalled()

    // A tab left open overnight is the NORMAL case for this screen: browsers suspend background
    // tabs and let their sockets die quietly, and the first thing staff do is look at the screen.
    hidden = false
    doc.fire('visibilitychange')
    expect(refetch).toHaveBeenCalledWith('visible')
    stop()
  })

  it('ignores a visibilitychange that made the tab hidden', () => {
    const refetch = jest.fn()
    const doc = fakeHost()
    const stop = startFeedFallback({
      refetch,
      isHidden: () => true,
      visibilityHost: doc,
      networkHost: null,
    })
    doc.fire('visibilitychange')
    expect(refetch).not.toHaveBeenCalled()
    stop()
  })

  it('refetches when the network comes back', () => {
    const refetch = jest.fn()
    const win = fakeHost()
    const stop = startFeedFallback({
      refetch,
      isHidden: () => false,
      visibilityHost: null,
      networkHost: win,
    })
    win.fire('online')
    expect(refetch).toHaveBeenCalledWith('online')
    stop()
  })

  it('removes its listeners on teardown', () => {
    const doc = fakeHost()
    const win = fakeHost()
    const stop = startFeedFallback({
      refetch: jest.fn(),
      isHidden: () => false,
      visibilityHost: doc,
      networkHost: win,
    })
    expect(doc.count('visibilitychange')).toBe(1)
    expect(win.count('online')).toBe(1)
    stop()
    expect(doc.count('visibilitychange')).toBe(0)
    expect(win.count('online')).toBe(0)
  })

  it('polls slowly enough to be a safety net, not a replacement for the socket', () => {
    // Guards the constant against being tuned into a per-second poll on every staff dashboard at
    // every venue. Low frequency is the whole point: the requirement is that the list cannot be
    // INDEFINITELY stale.
    expect(FEED_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(30_000)
  })
})
