/**
 * @jest-environment jsdom
 *
 * Phase 3.3 — a failed menu load must not render as an empty menu.
 *
 * app/menu/[restaurantId]/browse/page.tsx swallowed every menu fetch error into a
 * console.error plus setGroupedItems({}) / setAllGroupedItems({}). The customer was told
 * nothing, and the page's empty state then made an affirmative false claim:
 *
 *     "Menu coming soon!  /  This restaurant hasn't added menu items yet."
 *
 * That is the QR entry surface for every customer. A total outage was indistinguishable from a
 * restaurant that sells nothing, and a category the customer could not see was
 * indistinguishable from one the restaurant does not sell.
 *
 * These tests drive the real page over a fake fetch. The notice is in-page, not a toast, which
 * is why these assertions read the document.
 *
 * That choice was originally made because a toast on this surface rendered nothing at all —
 * <Toaster /> was mounted only in components/dashboard/dashboard-shell.tsx. #204 has since
 * mounted it in app/providers.tsx, so that reason no longer holds and the note is corrected here
 * rather than left to mislead. The in-page notice is NOT being revisited by #204: it is a
 * persistent failure with a retry affordance, and a toast that fades after a few seconds is a
 * different thing. Anyone wanting to convert it should argue that on the merits.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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
jest.mock('@/contexts/tab-context', () => ({
  useTab: () => ({
    isInTab: false,
    tabId: '',
    tabTotal: 0,
    tabMembers: [],
    tabStatus: null,
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
jest.mock('@/lib/tab-storage', () => ({ readStoredTabId: () => '' }))
jest.mock('@/lib/tab-session', () => ({ fetchTabById: async () => null }))
jest.mock('@/lib/restaurant-logo', () => ({ restaurantLogoDisplayUrl: () => null }))
jest.mock('@/lib/supabase/tables', () => ({
  getSupabaseTableByNumber: async () => ({ is_view_only: false }),
}))
jest.mock('@/lib/supabase/menu', () => ({ getSupabaseCategories: jest.fn() }))

import BrowsePage from '@/app/menu/[restaurantId]/browse/page'
import { getSupabaseCategories } from '@/lib/supabase/menu'

const CATEGORIES = [
  { id: 'cat-food', name: 'Food' },
  { id: 'cat-drinks', name: 'Drinks' },
]

const PAYLOADS: Record<string, unknown> = {
  'cat-food': {
    'sub-burgers': {
      subcategory: { id: 'sub-burgers', name: 'Burgers', display_order: 1 },
      items: [{ id: 'item-burger', name: 'Beef Burger', base_price: 95 }],
    },
  },
  'cat-drinks': {
    'sub-soft': {
      subcategory: { id: 'sub-soft', name: 'Soft Drinks', display_order: 1 },
      items: [{ id: 'item-coke', name: 'Coke', base_price: 20 }],
    },
  },
}

let container: HTMLDivElement
let root: Root
let failing: string[] = []
let fetchCalls: string[] = []

/** Serves PAYLOADS, 500s for whatever is in `failing`, and 404s anything else the page asks for. */
function installFetch() {
  fetchCalls = []
  ;(globalThis as any).fetch = jest.fn(async (input: any) => {
    const url = String(input)
    fetchCalls.push(url)

    const match = /\/api\/menu\/[^/]+\/category\/([^/?]+)/.exec(url)
    if (match) {
      const categoryId = decodeURIComponent(match[1])
      if (failing.includes(categoryId)) {
        return { ok: false, status: 500, json: async () => ({ error: 'Failed to load menu' }) }
      }
      return { ok: true, status: 200, json: async () => PAYLOADS[categoryId] ?? {} }
    }

    return { ok: true, status: 200, json: async () => ({}) }
  })
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  failing = []
  installFetch()
  ;(getSupabaseCategories as jest.Mock).mockReset()
  ;(getSupabaseCategories as jest.Mock).mockResolvedValue(CATEGORIES)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  jest.restoreAllMocks()
})

async function renderBrowse() {
  await act(async () => {
    root.render(<BrowsePage />)
  })
  // The page chains category load -> per-category fetch; let those settle.
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

function buttonMatching(pattern: RegExp): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((el) =>
    pattern.test(el.textContent || '')
  )
  if (!button) throw new Error(`no button matching ${pattern}`)
  return button as HTMLButtonElement
}

const text = () => container.textContent || ''

describe('browse page — the customer is told when the menu fails to load', () => {
  it('shows the menu normally when everything loads', async () => {
    await renderBrowse()

    expect(text()).toContain('Beef Burger')
    expect(text()).toContain('Coke')
    expect(text()).not.toMatch(/couldn.t load/i)
  })

  it('tells the customer when NOTHING loaded, instead of an empty menu', async () => {
    failing = ['cat-food', 'cat-drinks']
    await renderBrowse()

    expect(text()).toMatch(/couldn.t load the menu/i)
  })

  it('does not claim the restaurant has no menu when the load actually failed', async () => {
    failing = ['cat-food', 'cat-drinks']
    await renderBrowse()

    // The false statement this whole change exists to remove.
    expect(text()).not.toContain('Menu coming soon!')
    expect(text()).not.toContain("hasn't added menu items yet")
  })

  it('offers a way to retry after a total failure', async () => {
    failing = ['cat-food', 'cat-drinks']
    await renderBrowse()

    expect(() => buttonMatching(/try again/i)).not.toThrow()
  })

  it('recovers when the customer retries and the menu comes back', async () => {
    failing = ['cat-food', 'cat-drinks']
    await renderBrowse()
    expect(text()).toMatch(/couldn.t load the menu/i)

    failing = []
    await act(async () => {
      buttonMatching(/try again/i).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(text()).toContain('Beef Burger')
    expect(text()).not.toMatch(/couldn.t load/i)
  })

  it('shows what loaded and names what did not on a partial failure', async () => {
    failing = ['cat-drinks']
    await renderBrowse()

    expect(text()).toContain('Beef Burger')
    expect(text()).toMatch(/part of the menu didn.t load/i)
    expect(text()).toContain('Drinks')
  })

  it('does not show the failure notice for a restaurant that genuinely has no items', async () => {
    ;(getSupabaseCategories as jest.Mock).mockResolvedValue([
      { id: 'cat-empty', name: 'Empty' },
    ])
    await renderBrowse()

    expect(text()).not.toMatch(/couldn.t load/i)
    expect(text()).toContain('Menu coming soon!')
  })
})
