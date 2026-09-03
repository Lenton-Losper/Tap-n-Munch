/**
 * @jest-environment jsdom
 *
 * Verifies the wall-clock architecture app/kitchen/page.tsx and app/bar/page.tsx settled on:
 *
 *   - the server timestamp (readyAt) stays authoritative — never mutated, never reset locally;
 *   - elapsed time is DERIVED from it (ageSeconds/formatElapsedClock), every render;
 *   - the visible MM:SS advances every second because `nowMs` ticks every 1s (fixed from the
 *     30s/60s it used to be — see the interval's own comment in app/kitchen/page.tsx);
 *   - that 1s tick is a pure local re-render. It must never itself cause a network request —
 *     the only things that fetch are the initial mount and the (separately tested, separately
 *     throttled) realtime/poll machinery in lib/dashboard/realtime-connection.ts.
 *
 * Reported as: "how do we make the countdown actually count down smoothly."
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KitchenScreenLive } from '@/app/kitchen/page'
import { BarScreenLive } from '@/app/bar/page'
import type { KitchenLine, BarRound } from '@/lib/stations/types'
import type { TerminalSession } from '@/lib/stations/use-terminal-session'

const fetchInitialKitchenLines = jest.fn()
const fetchInitialBarRounds = jest.fn()
jest.mock('@/lib/stations/data-port', () => ({
  fetchInitialKitchenLines: (...args: unknown[]) => fetchInitialKitchenLines(...args),
  fetchInitialBarRounds: (...args: unknown[]) => fetchInitialBarRounds(...args),
}))

// Realtime is a separate concern (covered by its own tests below in this file's sibling suite
// for the terminal, and by lib/dashboard/realtime-connection.ts's own tests) — stubbed here to a
// no-op so this file tests exactly one thing: the clock tick, in isolation from the socket.
const subscribeRestaurantOrdersRealtime = jest.fn(() => () => {})
jest.mock('@/lib/supabase/orders', () => ({
  subscribeRestaurantOrdersRealtime: (...args: unknown[]) =>
    subscribeRestaurantOrdersRealtime(...(args as [])),
}))

// The SECOND realtime subscriber the pages carry — the restaurant-lines Broadcast that is the
// feed actually reaching a station screen (see lib/stations/realtime-invalidate.ts). Stubbed for
// the same reason the postgres_changes one above is: this file tests the clock tick and nothing
// else. It is mocked at the module boundary rather than left to run against a stub client
// because importing it for real pulls in lib/supabase/client.ts, whose module scope constructs a
// browser Supabase client and throws without NEXT_PUBLIC_SUPABASE_URL — a suite that fails to
// load reports zero tests, which is a red that proves nothing.
const subscribeLineChanged = jest.fn(() => () => {})
jest.mock('@/lib/stations/realtime-invalidate', () => ({
  // Phase B's private-channel probe starts from the same mount effect. A no-op here keeps this
  // suite about the PUBLIC feed — but it must be PRESENT: omitting it left the import undefined
  // and the thrown TypeError took the whole board down at mount.
  subscribeLineChangedPrivate: () => () => {},
  subscribeLineChanged: (...args: unknown[]) => subscribeLineChanged(...(args as [])),
}))
jest.mock('@/lib/supabase/client', () => ({ supabase: {} }))

let container: HTMLDivElement
let root: Root

const session: TerminalSession = {
  accessToken: 'tok',
  refreshToken: 'refresh',
  restaurantId: 'restaurant-1',
  terminalId: 'terminal-1',
  restaurantName: 'Test Venue',
}

// Only the heartbeat effect calls this directly (fetchInitial* is mocked above and bypasses it).
// It's fire-and-forget (`void authFetch(...)`) and nothing reads the result, so any resolved
// value is fine.
const authFetch = jest.fn(async () => ({ ok: true, status: 200 }) as unknown as Response)

beforeEach(() => {
  jest.useFakeTimers()
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchInitialKitchenLines.mockReset()
  fetchInitialBarRounds.mockReset()
  authFetch.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  jest.clearAllTimers()
  jest.useRealTimers()
})

function readyKitchenLine(readyAt: string): KitchenLine {
  return {
    id: 'line-1',
    orderId: 'order-1',
    tableNumber: '9',
    orderNumber: 40,
    itemName: 'Ribeye',
    quantity: 1,
    lineNote: null,
    routeTo: 'kitchen',
    state: 'ready',
    placedAt: readyAt,
    cookedAt: readyAt,
    readyAt,
    unrouted: false,
    sharedWithOtherStation: false,
  }
}

function readyBarRound(readyAt: string): BarRound {
  return {
    id: 'order-1',
    tableNumber: '9',
    orderNumber: 40,
    items: [
      {
        id: 'line-1',
        itemName: 'Coffee',
        quantity: 1,
        lineNote: null,
        state: 'ready',
        cookedAt: readyAt,
        readyAt,
      },
    ],
    placedAt: readyAt,
    unrouted: false,
  }
}

describe('kitchen board wall clock', () => {
  it('advances the visible age across a minute boundary without causing another fetch', async () => {
    const readyAt = new Date(Date.now()).toISOString()
    fetchInitialKitchenLines.mockResolvedValue({
      items: [readyKitchenLine(readyAt)],
      fault: null,
      pairedTo: null,
    })

    await act(async () => {
      root.render(<KitchenScreenLive session={session} authFetch={authFetch} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const clock = () => container.querySelector('[data-testid="dispatch-row-clock"]')?.textContent
    // REDESIGN 2026-09-01: whole minutes, no seconds. The 1s tick still runs and is still a pure
    // local re-render — the property this file exists to protect — but what it advances is now a
    // minute counter and the escalation bands rather than a ticking MM:SS.
    expect(clock()).toBe('<1m')
    expect(fetchInitialKitchenLines).toHaveBeenCalledTimes(1)

    // 59 one-second ticks, deliberately stopping SHORT of FEED_POLL_INTERVAL_MS (60s) so the poll
    // cannot account for any fetch. This is the real guarantee: ticking never fetches.
    await act(async () => {
      jest.advanceTimersByTime(59_000)
    })
    expect(fetchInitialKitchenLines).toHaveBeenCalledTimes(1)

    // Cross the minute boundary — the display moves. (The 60s poll also fires here, which is
    // correct and separately covered, so fetch counts are not asserted past this point.)
    await act(async () => {
      jest.advanceTimersByTime(2_000)
    })
    expect(clock()).toBe('1m')
  })
})

describe('bar board wall clock', () => {
  it('advances the visible age across a minute boundary without causing another fetch', async () => {
    const readyAt = new Date(Date.now()).toISOString()
    fetchInitialBarRounds.mockResolvedValue({
      items: [readyBarRound(readyAt)],
      fault: null,
      pairedTo: null,
    })

    await act(async () => {
      root.render(<BarScreenLive session={session} authFetch={authFetch} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const clock = () => container.querySelector('[data-testid="dispatch-row-clock"]')?.textContent
    // REDESIGN 2026-09-01 — see the kitchen's matching test. Whole minutes, no seconds.
    // REDESIGN 2026-09-01 — see the kitchen's matching test.
    expect(clock()).toBe('<1m')
    expect(fetchInitialBarRounds).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(59_000)
    })
    expect(fetchInitialBarRounds).toHaveBeenCalledTimes(1)

    await act(async () => {
      jest.advanceTimersByTime(2_000)
    })
    expect(clock()).toBe('1m')
  })
})
