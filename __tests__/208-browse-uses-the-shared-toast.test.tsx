/**
 * @jest-environment jsdom
 *
 * #208 — browse's hand-rolled toast stack is RETIRED, not tuned.
 *
 * Until #204 no customer route had a toast viewport mounted, so browse grew its own: its own state,
 * its own 1800ms/2000ms timers, and its own `pointer-events-none fixed inset-x-0 top-3 z-[60]`
 * container at the bottom of the render. One is mounted app-wide now, and both were live on the
 * same page — z-[60] under the shared z-[100].
 *
 * THE REASON THIS HAPPENED IS ACCESSIBILITY, and that is what the first test asserts. The old stack
 * was a plain div: no `aria-live` region, no dismiss control. A screen reader got nothing and the
 * message could not be dismissed. Asserting only "the sentence is on screen" would pass just as
 * well against the div this change deletes, which would make the whole suite decorative.
 *
 * The second thing at stake is `TOAST_LIMIT`. The ruling was that the replacement decides it, and
 * the old stack was UNBOUNDED — three quick adds gave three confirmations. At the shared store's
 * previous limit of 1 that becomes one, replaced twice. So the limit is pinned here, from the
 * observable side: three adds must leave three confirmations on screen.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const addItem = jest.fn()

jest.mock('next/navigation', () => ({
  useParams: () => ({ restaurantId: 'fnb-chownow' }),
  useSearchParams: () => new URLSearchParams('table=4'),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}))

jest.mock('next/image', () => ({ __esModule: true, default: () => null }))
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: any) => <span>{children}</span>,
}))

jest.mock('@/components/menu/food-item-image', () => ({ FoodItemImage: () => null }))
jest.mock('@/components/OrderStatusBanner', () => ({ __esModule: true, default: () => null }))
jest.mock('@/components/menu/menu-order-status-tracker', () => ({
  MenuOrderStatusTracker: () => null,
}))

jest.mock('@/contexts/restaurant-context', () => ({
  useRestaurant: () => ({
    restaurant: { id: 'fnb-chownow', name: 'FNB ChowNow', currency: 'N$' },
    currency: 'N$',
  }),
}))
jest.mock('@/contexts/cart-context', () => ({
  useCart: () => ({
    items: [],
    getItemCount: () => 0,
    addItem,
    clearCart: jest.fn(),
  }),
}))
jest.mock('@/contexts/tab-context', () => ({
  useTab: () => ({
    isInTab: true,
    tabId: 'tab-1',
    tabTotal: 0,
    tabMembers: [],
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
  getSessionInfo: () => ({ table: '4', restaurant: 'fnb-chownow' }),
}))
jest.mock('@/lib/session-recovery', () => ({ restoreSessionFromTable: async () => 'sess-1' }))
jest.mock('@/lib/tab-storage', () => ({ readStoredTabId: () => 'tab-1' }))
jest.mock('@/lib/tab-session', () => ({ fetchTabById: async () => null }))
jest.mock('@/lib/restaurant-logo', () => ({ restaurantLogoDisplayUrl: () => null }))
jest.mock('@/lib/supabase/tables', () => ({
  getSupabaseTableByNumber: async () => ({ is_view_only: false }),
}))
jest.mock('@/lib/supabase/menu', () => ({ getSupabaseCategories: jest.fn() }))

import BrowsePage from '@/app/menu/[restaurantId]/browse/page'
import { Toaster } from '@/components/ui/toaster'
import { getSupabaseCategories } from '@/lib/supabase/menu'
import { MENU_COPY } from '@/lib/customer-copy/menu-copy'
import { reducer } from '@/hooks/use-toast'

const CATEGORIES = [{ id: 'cat-hot-drinks', name: 'Hot Drinks' }]

/**
 * The item's NAME changes per test, and that is not decoration.
 *
 * hooks/use-toast.ts keeps ONE module-level store for the whole process, so toasts fired by an
 * earlier test are still in it when the next one mounts a fresh `<Toaster />` — and at TOAST_LIMIT
 * 3 the counting assertions below would read three copies of the same sentence and blame this
 * change. A distinct name per test makes each count answerable.
 */
let itemName = 'Still Water 0'
let nameCounter = 0

const STILL_WATER = {
  id: 'still-water',
  get name() {
    return itemName
  },
  description: '500ml bottle',
  base_price: 15,
  status: 'active',
  has_sizes: false,
  has_addons: false,
  sizes: [],
  addons: [],
}

let container: HTMLDivElement
let root: Root

function installFetch() {
  ;(globalThis as any).fetch = jest.fn(async (input: any) => {
    const url = String(input)
    if (/\/api\/menu\/[^/]+\/category\/([^/?]+)/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          'sub-coffee': {
            subcategory: { id: 'sub-coffee', name: 'Coffee', display_order: 1 },
            items: [STILL_WATER],
          },
        }),
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
  addItem.mockReset()
  itemName = `Still Water ${++nameCounter}`
  installFetch()
  ;(getSupabaseCategories as jest.Mock).mockReset()
  ;(getSupabaseCategories as jest.Mock).mockResolvedValue(CATEGORIES)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  jest.restoreAllMocks()
})

/**
 * The page PLUS the shared viewport, which is what app/providers.tsx mounts around every customer
 * route. Rendering the page alone would prove nothing: the toast would go into the module store and
 * nowhere else, which is exactly the #204 no-op this replacement depends on being fixed.
 */
async function renderBrowse() {
  await act(async () => {
    root.render(
      <>
        <BrowsePage />
        <Toaster />
      </>,
    )
  })
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function click(el: Element | null | undefined, what: string) {
  if (!el) throw new Error(`${what} not rendered`)
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Card tap, then confirm in the popup — the only path that reaches the cart. */
function addStillWater() {
  click(
    container.querySelector(`button[aria-label="Add ${itemName} to cart"]`),
    'card add button',
  )
  const confirm = Array.from(container.querySelectorAll('button')).find((el) =>
    /add to cart/i.test(el.textContent || ''),
  )
  click(confirm, 'popup Add to Cart button')
}

/** The sentence THIS test expects, derived from the copy key rather than restated. */
function expected(): string {
  return MENU_COPY.cartItemAdded.replace('{item}', itemName)
}

/** Every element in the document whose own text is exactly this test's confirmation. */
function confirmations(): Element[] {
  return Array.from(document.body.querySelectorAll('*')).filter(
    (el) => el.children.length === 0 && el.textContent === expected(),
  )
}

describe('the confirmation now comes from the shared, accessible toast', () => {
  it('renders the same sentence the hand-rolled pill rendered', async () => {
    await renderBrowse()
    addStillWater()

    expect(addItem).toHaveBeenCalledTimes(1)
    expect(confirmations()).toHaveLength(1)
  })

  it('puts it inside an aria-live region — the reason this change happened', async () => {
    await renderBrowse()
    addStillWater()

    // ALL of them, not the first: the store is process-global, so an earlier test's toast may still
    // be mounted ahead of this one. The claim is that THIS sentence is announced, not that it is
    // announced first.
    const regions = Array.from(document.body.querySelectorAll('[aria-live]'))
    expect(regions.length).toBeGreaterThan(0)
    expect(regions.some((el) => (el.textContent || '').includes(expected()))).toBe(true)
  })

  it('gives the customer a way to dismiss it, which the old stack never had', async () => {
    await renderBrowse()
    addStillWater()

    // ToastClose carries `toast-close=""` (components/ui/toast.tsx). The old stack rendered no
    // control at all, so this selector matching anything is the whole assertion.
    expect(container.querySelector('[toast-close]')).not.toBeNull()
  })
})

describe("the hand-rolled stack is gone, not merely hidden behind the shared one", () => {
  it('renders no z-[60] toast container of its own', async () => {
    await renderBrowse()
    addStillWater()

    // Both were live on the page at once: browse's own at z-[60], the shared viewport at z-[100].
    // The shared one won, so the old one was invisible rather than absent — and an invisible
    // duplicate is what a "replacement" quietly turns into if only the visible layer is checked.
    expect(container.querySelector('.z-\\[60\\]')).toBeNull()
  })

  it('paints the confirmation exactly once, not once per stack', async () => {
    await renderBrowse()
    addStillWater()

    expect(confirmations()).toHaveLength(1)
  })
})

describe('TOAST_LIMIT is what the replacement needs', () => {
  it('keeps three confirmations, because the stack it replaces was unbounded', () => {
    // Asserted through the reducer rather than three real clicks: the modal closes and reopens
    // between adds, and this is the property that matters — how many the STORE keeps. At the
    // previous limit of 1 the third add leaves one, which is the regression the ruling named.
    let state = { toasts: [] as any[] }
    for (const id of ['a', 'b', 'c']) {
      state = reducer(state, { type: 'ADD_TOAST', toast: { id, open: true } as any })
    }
    expect(state.toasts.map((t) => t.id)).toEqual(['c', 'b', 'a'])
  })

  it('is still BOUNDED — a fourth add evicts the oldest', () => {
    // Below `sm` the shared viewport is a full-width band across the top of a phone. Unbounded
    // there covers the screen, which is the other half of why this number is 3 and not "all".
    let state = { toasts: [] as any[] }
    for (const id of ['a', 'b', 'c', 'd']) {
      state = reducer(state, { type: 'ADD_TOAST', toast: { id, open: true } as any })
    }
    expect(state.toasts.map((t) => t.id)).toEqual(['d', 'c', 'b'])
  })
})
