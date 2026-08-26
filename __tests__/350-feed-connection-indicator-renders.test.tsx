/**
 * @jest-environment jsdom
 *
 * #350 — THE CONNECTION STATE REACHES THE SCREEN, and keeps reaching it.
 *
 * Item 5 of the issue is "surface the state", and the standard it has to meet is the one the sound
 * indicator set: SUBSCRIBED, not read once, because an indicator that went stale would be lying
 * about the one thing it exists to report. A unit test on the store cannot show that — the store
 * can be perfect while the component reads it at mount and never again, which is precisely the
 * failure this issue is about, one level up.
 *
 * So this MOUNTS the real component out of `components/orders-dashboard.tsx` and drives the real
 * channel statuses through the real store, asserting the DOM changes each time.
 *
 * IT ALSO EXERCISES THAT MODULE'S TOP LEVEL, which is worth more than it looks: that file is
 * `@ts-nocheck`, so tsc skips it entirely and a missing or renamed import becomes `undefined` under
 * jest without throwing until something renders. A `ReferenceError` from exactly that blind spot
 * took the staff dashboard down across three production deploys in August 2026.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(''),
}))

jest.mock('@/components/auth/auth-provider', () => ({
  useAuth: () => ({ user: null, restaurantId: '', restaurant: null }),
}))

jest.mock('@/hooks/use-permissions', () => ({
  usePermissions: () => ({ hasPermission: () => true, permissionsLoaded: true }),
}))

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock('@/lib/supabase/client', () => ({
  supabase: { channel: () => ({ on: () => ({}), subscribe: () => ({}) }), removeChannel: jest.fn() },
  getSupabaseClient: () => ({}),
}))

import { FeedConnectionIndicator } from '@/components/orders-dashboard'
import {
  registerFeedChannel,
  reportFeedChannelStatus,
  resetFeedConnection,
  FEED_OFFLINE_AFTER_MS,
} from '@/lib/dashboard/realtime-connection'
import { FEED_CONNECTION_COPY } from '@/lib/dashboard/feed-connection-copy'

let container: HTMLDivElement
let root: Root

const indicator = () =>
  container.querySelector('[data-testid="feed-connection-indicator"]') as HTMLElement | null

beforeEach(() => {
  // Without this React does not commit updates made inside `act`, and the assertions below would
  // read pre-update DOM -- a suite that passes on the wrong evidence.
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  resetFeedConnection()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(<FeedConnectionIndicator />)
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  jest.useRealTimers()
  resetFeedConnection()
})

describe('#350 the connection indicator on Live Orders', () => {
  it('renders, and does not claim the feed is live before any channel has joined', () => {
    const el = indicator()
    expect(el).toBeTruthy()
    expect(el!.getAttribute('data-feed-state')).toBe('reconnecting')
  })

  it('goes live when the channel subscribes, and BACK when it drops', () => {
    act(() => {
      registerFeedChannel('orders:r1')
      reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    })
    expect(indicator()!.getAttribute('data-feed-state')).toBe('live')

    // The whole defect in one line: before this, the socket died and the screen said nothing.
    act(() => {
      reportFeedChannelStatus('orders:r1', 'CHANNEL_ERROR')
    })
    expect(indicator()!.getAttribute('data-feed-state')).toBe('reconnecting')

    act(() => {
      reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    })
    expect(indicator()!.getAttribute('data-feed-state')).toBe('live')
  })

  it('escalates to offline on screen without any further channel event', () => {
    jest.useFakeTimers()
    act(() => {
      registerFeedChannel('orders:r1')
      reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
      reportFeedChannelStatus('orders:r1', 'TIMED_OUT')
    })
    expect(indicator()!.getAttribute('data-feed-state')).toBe('reconnecting')

    // A dead socket says nothing more. If the indicator needed an event to escalate it would sit on
    // "reconnecting" for the rest of the shift -- a stale indicator, which is the thing being fixed.
    act(() => {
      jest.advanceTimersByTime(FEED_OFFLINE_AFTER_MS + 1_000)
    })
    expect(indicator()!.getAttribute('data-feed-state')).toBe('offline')
  })

  it('carries the state in text, aria-label and title, so it is legible three ways', () => {
    act(() => {
      registerFeedChannel('orders:r1')
      reportFeedChannelStatus('orders:r1', 'SUBSCRIBED')
    })
    const el = indicator()!
    // Wording is not asserted -- it is unsigned placeholder copy. What is asserted is that all
    // three surfaces carry the SAME string, which is the property the sound indicator's docblock
    // requires and the reason its labels have to read as standalone statements.
    expect(el.textContent).toContain(FEED_CONNECTION_COPY.live)
    expect(el.getAttribute('aria-label')).toBe(FEED_CONNECTION_COPY.live)
    expect(el.getAttribute('title')).toBe(FEED_CONNECTION_COPY.live)
  })
})
