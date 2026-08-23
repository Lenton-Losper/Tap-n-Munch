/**
 * @jest-environment jsdom
 *
 * A member who JOINED a tab can see its PIN. That is the case #265 exists for, and until now
 * nothing tested it.
 *
 * WHAT WAS WRONG. The PIN in the tab strip came from `sessionStorage.flashtap_creator_tab_pin`,
 * written once by the device that CREATED the tab. That is not a check of anything — it is the
 * client reading back something it wrote itself — and it has two consequences. It dies when the
 * browser tab closes. And everyone who joined by typing the PIN could never see it again: the
 * value was never on their device to begin with. A table of four had one phone that knew the
 * number and three that did not, so the moment a fifth person arrived, or the creator's phone
 * locked, the table was stuck. That is most of why staff-driven PIN recovery was needed at all.
 *
 * The PIN now comes from GET /api/tabs/[tabId], gated on the customer session token — which every
 * member holds, because all three entry paths in contexts/tab-context.tsx (createNewTab,
 * joinTabWithPin, joinExistingTab) persist `flashtap_session_token` from their response.
 *
 * WHY THE FIRST TEST IS THE WHOLE POINT. It renders a joiner: session token present, and NO
 * creator keys in sessionStorage. Against the old code that customer saw no PIN at all, because
 * `creatorTabPin` was the only source and it was null for them. If someone reverts the fetch,
 * that test fails and the others do not.
 *
 * Deliberately NOT asserted here: that the server only releases the PIN to a token holder. That
 * is the gate, it is not observable from the client, and it is pinned separately in
 * __tests__/tabs-route-discloses-pin-only-to-token-holder.test.ts. This file is about who SEES
 * it on screen.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const TAB_ID = '11111111-2222-3333-4444-555555555555'
const PIN = '1490'

jest.mock('next/navigation', () => ({
  useParams: () => ({ restaurantId: 'riviera' }),
  useSearchParams: () => new URLSearchParams('table=4'),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}))

jest.mock('next/image', () => ({ __esModule: true, default: () => null }))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: any) => <span>{children}</span>,
}))

jest.mock('@/components/menu/food-item-image', () => ({ FoodItemImage: () => null }))
jest.mock('@/components/menu/item-detail-modal', () => ({ ItemDetailModal: () => null }))
jest.mock('@/components/OrderStatusBanner', () => ({ __esModule: true, default: () => null }))
jest.mock('@/components/menu/menu-order-status-tracker', () => ({
  MenuOrderStatusTracker: () => null,
}))

jest.mock('@/contexts/restaurant-context', () => ({
  useRestaurant: () => ({
    restaurant: { id: 'riviera', name: 'Riviera', currency: 'N$' },
    currency: 'N$',
  }),
}))
jest.mock('@/contexts/cart-context', () => ({
  useCart: () => ({
    items: [],
    getItemCount: () => 0,
    addItem: jest.fn(),
    clearCart: jest.fn(),
  }),
}))

/** In an OPEN tab with one other diner — the state the strip renders the PIN in. */
jest.mock('@/contexts/tab-context', () => ({
  useTab: () => ({
    isInTab: true,
    tabId: '11111111-2222-3333-4444-555555555555',
    tabTotal: 0,
    tabMembers: [{ member_key: 'mk_a', display_name: 'Ada' }],
    tabStatus: 'open',
    clearTab: jest.fn(),
  }),
}))

jest.mock('@/hooks/useClearCartOnTableChange', () => ({
  useClearCartOnTableChange: () => undefined,
}))
jest.mock('@/hooks/useTabSessionEndedRedirect', () => ({
  useTabSessionEndedRedirect: () => ({ redirecting: false }),
}))

jest.mock('@/lib/session', () => ({
  getOrCreateSession: () => 'sess-1',
  getCurrentSession: () => 'sess-1',
  getSessionInfo: () => ({ table: '4', restaurant: 'riviera' }),
}))
jest.mock('@/lib/session-recovery', () => ({ restoreSessionFromTable: async () => 'sess-1' }))
jest.mock('@/lib/tab-storage', () => ({
  readStoredTabId: () => '11111111-2222-3333-4444-555555555555',
}))
jest.mock('@/lib/tab-session', () => ({ fetchTabById: async () => null }))
jest.mock('@/lib/restaurant-logo', () => ({ restaurantLogoDisplayUrl: () => null }))
jest.mock('@/lib/supabase/tables', () => ({
  getSupabaseTableByNumber: async () => ({ is_view_only: false }),
}))
jest.mock('@/lib/supabase/menu', () => ({ getSupabaseCategories: jest.fn() }))

import BrowsePage from '@/app/menu/[restaurantId]/browse/page'
import { getSupabaseCategories } from '@/lib/supabase/menu'
import { SESSION_TOKEN_STORAGE_KEY } from '@/lib/fetch-with-session'

let container: HTMLDivElement
let root: Root
/** Every URL the page fetched, so a test can prove the PIN read was or was not attempted. */
let fetched: string[]

/** Serves the tab read; `pin` of null stands for a tab whose PIN the server withheld. */
function mockFetch(pin: string | null) {
  ;(globalThis as any).fetch = jest.fn(async (url: string) => {
    fetched.push(String(url))
    if (String(url).includes(`/api/tabs/${TAB_ID}`)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tab: pin ? { id: TAB_ID, tab_pin: pin } : { id: TAB_ID } }),
      }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetched = []
  sessionStorage.clear()
  localStorage.clear()
  mockFetch(PIN)
  ;(getSupabaseCategories as jest.Mock).mockReset()
  ;(getSupabaseCategories as jest.Mock).mockResolvedValue([{ id: 'cat-food', name: 'Food' }])
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  sessionStorage.clear()
  localStorage.clear()
  jest.restoreAllMocks()
})

async function renderBrowse() {
  await act(async () => {
    root.render(<BrowsePage />)
  })
  // Let the PIN fetch's promise chain settle.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** A member who JOINED: holds a session token, holds no creator keys. */
function beAJoinedMember() {
  sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, 'token-for-this-tab')
}

/** The device that CREATED the tab: holds the creator keys it wrote at creation. */
function beTheCreator() {
  sessionStorage.setItem('flashtap_creator_tab_id', TAB_ID)
  sessionStorage.setItem('flashtap_creator_tab_pin', PIN)
}

describe('the tab PIN is visible to a member who joined, not only to the creator (#265)', () => {
  it('shows the PIN to a joiner, who has no creator keys of their own', async () => {
    beAJoinedMember()

    await renderBrowse()

    // The strip, verbatim in the shape the customer reads it.
    expect(container.textContent).toContain(`PIN: ${PIN}`)
  })

  it('reads it from the token-guarded route, not from storage', async () => {
    beAJoinedMember()

    await renderBrowse()

    expect(fetched.some((u) => u.includes(`/api/tabs/${TAB_ID}`))).toBe(true)
  })

  it('shows nothing to a joiner when the server withholds the PIN', async () => {
    // pin_required off, or a tab with no PIN. The strip must not invent one.
    mockFetch(null)
    beAJoinedMember()

    await renderBrowse()

    expect(container.textContent).not.toContain('PIN:')
  })

  it('does not attempt the read at all without a session token', async () => {
    // No token, no creator keys: nothing to show and nothing to ask for.
    await renderBrowse()

    expect(fetched.some((u) => u.includes(`/api/tabs/${TAB_ID}`))).toBe(false)
    expect(container.textContent).not.toContain('PIN:')
  })

  it('still shows the creator their own PIN if the read fails', async () => {
    // The fallback that was the ONLY source before: this device showing what it wrote itself.
    ;(globalThis as any).fetch = jest.fn(async () => {
      throw new Error('offline')
    })
    beTheCreator()

    await renderBrowse()

    expect(container.textContent).toContain(`PIN: ${PIN}`)
  })

  it('renders the PIN exactly once on the page', async () => {
    // A second copy was briefly added as its own header line above the strip. It answered a
    // question the strip already answers two rows down.
    beAJoinedMember()

    await renderBrowse()

    const occurrences = (container.textContent || '').split(PIN).length - 1
    expect(occurrences).toBe(1)
  })
})
