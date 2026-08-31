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
  it('advances the visible READY clock every second without causing another fetch', async () => {
    const readyAt = new Date(Date.now()).toISOString()
    fetchInitialKitchenLines.mockResolvedValue({
      items: [readyKitchenLine(readyAt)],
      notEnabled: false,
      notPaired: false,
      pairedTo: null,
    })

    await act(async () => {
      root.render(<KitchenScreenLive session={session} authFetch={authFetch} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const clock = () => container.querySelector('[data-testid="dispatch-row-clock"]')?.textContent
    expect(clock()).toBe('READY 00:00')
    expect(fetchInitialKitchenLines).toHaveBeenCalledTimes(1)

    // Three 1s ticks. If the interval were still 30s (what this was before the fix), none of
    // these would have moved the displayed clock at all.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        jest.advanceTimersByTime(1_000)
      })
    }

    expect(clock()).toBe('READY 00:03')
    // The clock tick's only job is setNowMs — a pure re-render. Nothing about ticking it three
    // times may have triggered a second fetch of the board.
    expect(fetchInitialKitchenLines).toHaveBeenCalledTimes(1)
  })
})

describe('bar board wall clock', () => {
  it('advances the visible READY clock every second without causing another fetch', async () => {
    const readyAt = new Date(Date.now()).toISOString()
    fetchInitialBarRounds.mockResolvedValue({
      items: [readyBarRound(readyAt)],
      notEnabled: false,
      notPaired: false,
      pairedTo: null,
    })

    await act(async () => {
      root.render(<BarScreenLive session={session} authFetch={authFetch} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const clock = () => container.querySelector('[data-testid="dispatch-row-clock"]')?.textContent
    expect(clock()).toBe('READY 00:00')
    expect(fetchInitialBarRounds).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 4; i++) {
      await act(async () => {
        jest.advanceTimersByTime(1_000)
      })
    }

    expect(clock()).toBe('READY 00:04')
    expect(fetchInitialBarRounds).toHaveBeenCalledTimes(1)
  })
})
