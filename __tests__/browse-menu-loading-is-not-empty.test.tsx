/**
 * @jest-environment jsdom
 *
 * #214 — a menu that is still LOADING must not render as a menu that is EMPTY.
 *
 * app/menu/[restaurantId]/browse/page.tsx had two body states where it needs three. The page's
 * `loading` flag tracks only the FIRST effect — the category list plus the table session — and
 * flips false the moment the CATEGORY NAMES arrive. The menu ITEMS are fetched by two separate
 * effects that carried no loading state at all:
 *
 *   - loadAllMenuItems  — the "All" view, which is the DEFAULT (`categoryFilter` starts as 'all')
 *                         and therefore the first thing a QR customer sees;
 *   - loadMenuItems     — one category, after the customer taps a category chip.
 *
 * So between `setLoading(false)` and those fetches resolving the page held
 * `loading=false, items={}, failure=null` and fell through to:
 *
 *     "Menu coming soon!  /  This restaurant hasn't added menu items yet."
 *
 * A claim about what the restaurant sells, made while we do not yet know. It resolves in about a
 * second on desktop and longer on mobile data — and mobile data is the entire QR use case.
 *
 * It also undercut the failure notice added by phase 3.3 (see
 * browse-menu-load-failure-is-told.test.tsx): that notice renders only once a fetch has REJECTED,
 * so until the request gave up, a slow load and a real outage were the same screen.
 *
 * These tests drive the REAL page over a fetch that never resolves, which is the state the
 * customer is in for the whole of a slow load.
 *
 * PROOF CEILING: jsdom. A pending promise is a faithful model of "the response has not arrived",
 * but it is not a phone on mobile data. The real-device check is the human's.
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

/** Category ids whose fetch never settles — the state a customer on slow mobile data is in. */
let hanging: string[] = []
/** Category ids that return `{}` with a 200 — a category the restaurant genuinely has nothing in. */
let genuinelyEmpty: string[] = []

function installFetch() {
  ;(globalThis as any).fetch = jest.fn(async (input: any) => {
    const url = String(input)
    const match = /\/api\/menu\/[^/]+\/category\/([^/?]+)/.exec(url)
    if (match) {
      const categoryId = decodeURIComponent(match[1])
      if (hanging.includes(categoryId)) {
        // Never resolves. Not a rejection: the request has not failed, it has not ARRIVED.
        return new Promise<never>(() => {})
      }
      if (genuinelyEmpty.includes(categoryId)) {
        return { ok: true, status: 200, json: async () => ({}) }
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
  hanging = []
  genuinelyEmpty = []
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
  // The page chains category load -> per-category fetch; let every settleable step settle. A
  // hanging category simply never advances, which is the point.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function buttonMatching(pattern: RegExp): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((el) =>
    pattern.test(el.textContent || '')
  )
  if (!button) throw new Error(`no button matching ${pattern}`)
  return button as HTMLButtonElement
}

const text = () => container.textContent || ''
const isLoadingBody = () => container.querySelector('[data-testid="menu-body-loading"]') !== null

describe('#214 — browse page distinguishes loading from empty', () => {
  it('does not claim the restaurant sells nothing while the default view is still loading', async () => {
    hanging = ['cat-food', 'cat-drinks']
    await renderBrowse()

    // The false statement, made before we know anything.
    expect(text()).not.toContain('Menu coming soon!')
    expect(text()).not.toContain("hasn't added menu items yet")
  })

  it('shows a loading treatment, not an empty state, while the default view is in flight', async () => {
    hanging = ['cat-food', 'cat-drinks']
    await renderBrowse()

    expect(isLoadingBody()).toBe(true)
  })

  it('does not claim a failure while the load is merely slow', async () => {
    hanging = ['cat-food', 'cat-drinks']
    await renderBrowse()

    // A slow load is not an outage. The notice belongs to a REJECTED fetch only.
    expect(text()).not.toMatch(/couldn.t load/i)
  })

  it('does not claim a tapped category is empty while that category is still loading', async () => {
    hanging = ['cat-food']
    await renderBrowse()

    await act(async () => {
      buttonMatching(/^Food$/).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(text()).not.toContain('Menu coming soon!')
    expect(text()).not.toMatch(/No items in "Food" yet/i)
    expect(isLoadingBody()).toBe(true)
  })

  /*
   * NOT TESTED HERE, deliberately, and recorded so nobody reads its absence as coverage.
   *
   * `menuBodyState`'s second gate — `if (!loadedOnce) return 'loading'` — defends the commit
   * BETWEEN a category tap and the passive effect that fetches that category. In that commit the
   * page has already switched to the category source, which holds no items, no failure and no
   * in-flight fetch: "nothing is loading" is true and "the category is empty" is not.
   *
   * A negative probe removing that line leaves every test in this file green, because
   * `IS_REACT_ACT_ENVIRONMENT` does not commit an un-`act`ed click, so the frame cannot be
   * observed from jsdom at all. A test written for it failed on BOTH sides of the probe — for the
   * wrong reason — and was removed rather than kept as false evidence.
   *
   * What the tests below DO prove is carried by the `loading` gate. The `loadedOnce` gate is
   * unproven by test here; it is a real-browser paint, and a real-device check.
   */

  it('still shows the menu once a slow load finally arrives', async () => {
    await renderBrowse()

    expect(text()).toContain('Beef Burger')
    expect(isLoadingBody()).toBe(false)
  })

  /*
   * CONTROL — passes on BOTH sides of the change, before and after.
   *
   * A fetch that COMPLETED SUCCESSFULLY and returned nothing is the one case where "Menu coming
   * soon!" is true, and it must survive. Without this, gating the empty state on a completed load
   * could be satisfied by never showing the empty state at all, and the tests above would still
   * be green.
   */
  it('CONTROL: still says "Menu coming soon!" when a successful fetch genuinely returns nothing', async () => {
    genuinelyEmpty = ['cat-food', 'cat-drinks']
    await renderBrowse()

    expect(text()).toContain('Menu coming soon!')
    expect(text()).toContain("hasn't added menu items yet")
    expect(isLoadingBody()).toBe(false)
  })

  it('CONTROL: a restaurant with no categories at all still reads as empty, not as loading', async () => {
    ;(getSupabaseCategories as jest.Mock).mockResolvedValue([])
    await renderBrowse()

    expect(text()).toContain('Menu coming soon!')
    expect(isLoadingBody()).toBe(false)
  })
})
