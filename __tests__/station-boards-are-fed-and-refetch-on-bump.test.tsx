/**
 * @jest-environment jsdom
 *
 * THE BOARD DID NOT UPDATE WHEN YOU PRESSED THE BUTTON. Three causes, measured 2026-08-31.
 *
 * ============================================================================================
 * WHAT WAS ACTUALLY WRONG
 * ============================================================================================
 *
 * app/kitchen/page.tsx and app/bar/page.tsx subscribed to order_lines over `postgres_changes`
 * (lib/supabase/orders.ts). That feed is RLS-gated through auth.uid(), and a station wall screen
 * holds ONLY a terminal-JWT in localStorage — lib/stations/use-terminal-session.ts, no Supabase
 * Auth session anywhere — so its socket authenticates as `anon`. Measured against staging with a
 * service-role subscriber as the positive control:
 *
 *     [anon]         SUBSCRIBED  ->  0 events
 *     [service_role] SUBSCRIBED  ->  1 event at +686ms
 *
 * Publication correct, REPLICA IDENTITY FULL correct, delivery correct. RLS is the filter, and
 * Realtime answers a denied subscription with SILENCE, not an error — so the channel reported
 * SUBSCRIBED the whole time and the connection indicator read `live` over a feed that had never
 * delivered anything. The board's only real refresh was the 60s fallback poll.
 *
 * ============================================================================================
 * WHY THE INDICATOR ASSERTION HERE IS THE LOAD-BEARING ONE
 * ============================================================================================
 *
 * The replacement feed is a Broadcast (lib/stations/realtime-invalidate.ts) — no RLS, no data in
 * the payload. But a Broadcast channel can fail to join for its own reasons, and if it did so
 * while the postgres_changes channel kept reporting SUBSCRIBED, the indicator would read `live`
 * over a dead feed AGAIN — the identical defect, rebuilt with a different transport, and
 * invisible for exactly as long as the first one was.
 *
 * So `registers the broadcast channel...` below is not bookkeeping coverage. It is the test that
 * stops this bug from recurring silently, and it is the one to check first if this file ever goes
 * red.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KitchenScreenLive } from '@/app/kitchen/page'
import { BarScreenLive } from '@/app/bar/page'
import {
  getFeedConnectionState,
  resetFeedConnection,
  FEED_UP_STATUS,
} from '@/lib/dashboard/realtime-connection'
import type { KitchenLine, BarRound } from '@/lib/stations/types'
import type { TerminalSession } from '@/lib/stations/use-terminal-session'

const fetchInitialKitchenLines = jest.fn()
const fetchInitialBarRounds = jest.fn()
jest.mock('@/lib/stations/data-port', () => ({
  fetchInitialKitchenLines: (...args: unknown[]) => fetchInitialKitchenLines(...args),
  fetchInitialBarRounds: (...args: unknown[]) => fetchInitialBarRounds(...args),
}))

const postStationBump = jest.fn()
jest.mock('@/lib/stations/bump', () => ({
  postStationBump: (...args: unknown[]) => postStationBump(...args),
}))

/** The postgres_changes subscriber. Captured, not asserted on for delivery — the whole point of
 *  this file is that on a real wall screen it delivers nothing. */
type OrdersCallbacks = { onLineChange?: () => void; onStatus?: (status: string) => void }
let ordersCallbacks: OrdersCallbacks | null = null
jest.mock('@/lib/supabase/orders', () => ({
  subscribeRestaurantOrdersRealtime: (_restaurantId: string, callbacks: OrdersCallbacks) => {
    ordersCallbacks = callbacks
    return () => {}
  },
}))

/** The Broadcast subscriber — the feed that actually reaches a station screen. */
type LineChangedCallbacks = { onLineChanged: () => void; onStatus?: (status: string) => void }
let broadcastCallbacks: LineChangedCallbacks | null = null
let broadcastRestaurantId: string | null = null
let broadcastUnsubscribed = 0
const subscribeLineChanged = jest.fn(
  (_client: unknown, restaurantId: string, callbacks: LineChangedCallbacks) => {
    broadcastRestaurantId = restaurantId
    broadcastCallbacks = callbacks
    return () => {
      broadcastUnsubscribed += 1
    }
  },
)
jest.mock('@/lib/stations/realtime-invalidate', () => ({
  // Phase B's private-channel probe starts from the same mount effect. A no-op here keeps this
  // suite about the PUBLIC feed — but it must be PRESENT: omitting it left the import undefined
  // and the thrown TypeError took the whole board down at mount.
  subscribeLineChangedPrivate: () => () => {},
  subscribeLineChanged: (...args: unknown[]) =>
    subscribeLineChanged(...(args as [unknown, string, LineChangedCallbacks])),
}))

// Module scope of lib/supabase/client.ts constructs a browser client and throws without
// NEXT_PUBLIC_SUPABASE_URL. Stubbed so importing the page under test is possible at all — a suite
// that fails to load reports zero tests, which is a red that proves nothing.
jest.mock('@/lib/supabase/client', () => ({ supabase: { __stub: true } }))

const session: TerminalSession = {
  accessToken: 'tok',
  refreshToken: 'refresh',
  restaurantId: 'restaurant-1',
  terminalId: 'terminal-1',
  restaurantName: 'Test Venue',
}

const authFetch = jest.fn(async () => ({ ok: true, status: 200 }) as unknown as Response)

let container: HTMLDivElement
let root: Root

function kitchenLine(): KitchenLine {
  const at = new Date().toISOString()
  return {
    id: 'line-1',
    orderId: 'order-1',
    tableNumber: '9',
    orderNumber: 40,
    itemName: 'Ribeye',
    quantity: 1,
    lineNote: null,
    routeTo: 'kitchen',
    state: 'outstanding',
    placedAt: at,
    cookedAt: null,
    readyAt: null,
    unrouted: false,
    sharedWithOtherStation: false,
  }
}

function barRound(): BarRound {
  const at = new Date().toISOString()
  return {
    id: 'order-1',
    tableNumber: '9',
    orderNumber: 40,
    items: [
      { id: 'line-1', itemName: 'Coffee', quantity: 1, lineNote: null, state: 'outstanding', cookedAt: null, readyAt: null },
    ],
    placedAt: at,
    unrouted: false,
  }
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetFeedConnection()
  ordersCallbacks = null
  broadcastCallbacks = null
  broadcastRestaurantId = null
  broadcastUnsubscribed = 0
  subscribeLineChanged.mockClear()
  fetchInitialKitchenLines.mockReset()
  fetchInitialBarRounds.mockReset()
  postStationBump.mockReset()
  authFetch.mockClear()
  fetchInitialKitchenLines.mockResolvedValue({ items: [kitchenLine()], fault: null, pairedTo: null })
  fetchInitialBarRounds.mockResolvedValue({ items: [barRound()], fault: null, pairedTo: null })
  postStationBump.mockResolvedValue({ ok: true, total: 1, failedLineIds: [] })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetFeedConnection()
})

async function mount(node: React.ReactElement) {
  await act(async () => {
    root.render(node)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe.each([
  ['kitchen', () => <KitchenScreenLive session={session} authFetch={authFetch} />, () => fetchInitialKitchenLines],
  ['bar', () => <BarScreenLive session={session} authFetch={authFetch} />, () => fetchInitialBarRounds],
])('%s board is fed by the restaurant-lines broadcast', (_name, render, fetcher) => {
  it('subscribes to the broadcast for its own restaurant', async () => {
    await mount(render())

    expect(subscribeLineChanged).toHaveBeenCalledTimes(1)
    expect(broadcastRestaurantId).toBe('restaurant-1')
    expect(typeof broadcastCallbacks?.onLineChanged).toBe('function')
  })

  it('refetches when a line_changed broadcast arrives', async () => {
    await mount(render())
    const initial = fetcher().mock.calls.length

    await act(async () => {
      broadcastCallbacks!.onLineChanged()
      await Promise.resolve()
    })

    expect(fetcher().mock.calls.length).toBe(initial + 1)
  })

  /**
   * THE ONE THAT MATTERS. See this file's header: a broadcast that fails to join must degrade the
   * indicator even while the postgres_changes channel is happily reporting SUBSCRIBED, or the
   * indicator lies about a dead feed exactly as it did before this fix.
   */
  it('registers the broadcast channel, so a broadcast failure cannot hide behind a SUBSCRIBED postgres_changes channel', async () => {
    await mount(render())

    // The RLS-blocked feed reports healthy — as it really does on a wall screen.
    await act(async () => {
      ordersCallbacks!.onStatus!(FEED_UP_STATUS)
      broadcastCallbacks!.onStatus!(FEED_UP_STATUS)
    })
    expect(getFeedConnectionState()).toBe('live')

    // Now the feed that actually carries data dies, and only that one.
    await act(async () => {
      broadcastCallbacks!.onStatus!('CHANNEL_ERROR')
    })
    expect(getFeedConnectionState()).not.toBe('live')
  })

  it('tears the broadcast subscription down on unmount', async () => {
    await mount(render())
    expect(broadcastUnsubscribed).toBe(0)

    await act(async () => {
      root.unmount()
    })
    expect(broadcastUnsubscribed).toBe(1)

    // afterEach unmounts again; make that a no-op rather than a double-unmount error.
    root = createRoot(document.createElement('div'))
  })
})

/**
 * The tapping screen must not depend on a socket to learn about its own write. Before this, a
 * successful bump updated the database and nothing else: the board waited for the (silent) feed
 * or the 60s poll, which is the "I pressed it and nothing happened" report.
 *
 * Asserted through a REAL button click rather than by calling onBump directly, because the thing
 * that regressed is the wiring between the card's control and the page's refetch.
 */
describe('a bump refetches from the server', () => {
  it('kitchen: a successful bump triggers a refetch', async () => {
    await mount(<KitchenScreenLive session={session} authFetch={authFetch} />)
    const before = fetchInitialKitchenLines.mock.calls.length

    const button = container.querySelector('[data-testid="station-bump-button"]') as HTMLButtonElement
    expect(button).toBeTruthy()

    await act(async () => {
      button.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(postStationBump).toHaveBeenCalledTimes(1)
    expect(fetchInitialKitchenLines.mock.calls.length).toBe(before + 1)
  })

  /**
   * A refusal is the case a client-side optimistic update would get WRONG, so it is the case worth
   * pinning: the board's belief about that line is in question either way, and re-asking the
   * server is what stops it guessing. `outcome` must still reach the card unchanged so it can mark
   * the row.
   */
  it('kitchen: a REFUSED bump also refetches, and still reports the failure to the card', async () => {
    postStationBump.mockResolvedValue({ ok: false, total: 1, failedLineIds: ['line-1'] })

    await mount(<KitchenScreenLive session={session} authFetch={authFetch} />)
    const before = fetchInitialKitchenLines.mock.calls.length

    const button = container.querySelector('[data-testid="station-bump-button"]') as HTMLButtonElement
    await act(async () => {
      button.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(fetchInitialKitchenLines.mock.calls.length).toBe(before + 1)
    expect(container.querySelector('[data-testid="line-bump-failed"]')).toBeTruthy()
  })

  it('bar: a successful bump triggers a refetch', async () => {
    await mount(<BarScreenLive session={session} authFetch={authFetch} />)
    const before = fetchInitialBarRounds.mock.calls.length

    const button = container.querySelector('[data-testid="station-bump-button"]') as HTMLButtonElement
    expect(button).toBeTruthy()

    await act(async () => {
      button.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(postStationBump).toHaveBeenCalledTimes(1)
    expect(fetchInitialBarRounds.mock.calls.length).toBe(before + 1)
  })
})
