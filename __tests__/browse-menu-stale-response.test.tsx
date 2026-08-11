/**
 * @jest-environment jsdom
 *
 * #225 — a slow response for a category the customer has LEFT must not paint over the one they
 * are looking at.
 *
 * The two menu-item effects in app/menu/[restaurantId]/browse/page.tsx set state from a resolved
 * fetch with no staleness guard, unlike two SIBLING effects in the very same file (the view-only
 * table lookup and the tab-pin lookup) which both use `let cancelled = false` and clear it from
 * the effect's cleanup. So when the customer taps Food and then Drinks before Food has answered,
 * Food's response — arriving second — wins, and its items are rendered under the Drinks heading.
 *
 * The condition is reconstructed from the defect report, not from the #214 harness: it needs two
 * DIFFERENT categories in flight at once with a CONTROLLED resolution ORDER, which neither of the
 * #214 files can express. Each category here gets its own deferred response that the test releases
 * by name.
 *
 * Three distinct consequences are asserted, because they fail independently:
 *   1. the wrong ITEMS are shown under the right heading;
 *   2. a stale FAILURE can raise a notice naming a category the customer has left;
 *   3. a stale SUCCESS can clear a notice that belongs to the category on screen.
 *
 * PROOF CEILING: UNIT. This proves the ordering — that a late response for an abandoned category
 * is applied. It models the network with deferred promises, so it says nothing about how often
 * real mobile latency actually produces this interleaving. Whether a customer hits it in practice
 * is a real-device question and is not answered here.
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
  useCart: () => ({ items: [], getItemCount: () => 0, addItem: jest.fn(), clearCart: jest.fn() }),
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

type Deferred = { release: (outcome?: 'ok' | 'fail') => void }

let container: HTMLDivElement
let root: Root
/** One deferral per category id; the test decides WHEN and IN WHAT ORDER each answers. */
let pending: Map<string, Deferred>
/** Category ids whose response the test wants to hold. Anything else answers immediately. */
let held: string[] = []

function installFetch() {
  pending = new Map()
  ;(globalThis as any).fetch = jest.fn(async (input: any) => {
    const url = String(input)
    const match = /\/api\/menu\/[^/]+\/category\/([^/?]+)/.exec(url)
    if (!match) return { ok: true, status: 200, json: async () => ({}) }

    const categoryId = decodeURIComponent(match[1])
    const respond = (outcome: 'ok' | 'fail') =>
      outcome === 'fail'
        ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
        : { ok: true, status: 200, json: async () => PAYLOADS[categoryId] ?? {} }

    if (!held.includes(categoryId)) return respond('ok')

    return new Promise((resolve) => {
      pending.set(categoryId, { release: (outcome = 'ok') => resolve(respond(outcome)) })
    })
  })
}

async function releaseCategory(categoryId: string, outcome: 'ok' | 'fail' = 'ok') {
  const deferred = pending.get(categoryId)
  if (!deferred) throw new Error(`no pending request for ${categoryId}`)
  await act(async () => {
    deferred.release(outcome)
    await Promise.resolve()
  })
  await flush()
}

async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  held = []
  installFetch()
  ;(getSupabaseCategories as jest.Mock).mockReset()
  ;(getSupabaseCategories as jest.Mock).mockResolvedValue(CATEGORIES)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  jest.restoreAllMocks()
})

const text = () => container.textContent || ''

function chip(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (el) => (el.textContent || '').trim() === label
  )
  if (!button) throw new Error(`no chip labelled ${label}`)
  return button as HTMLButtonElement
}

async function tap(label: string) {
  await act(async () => {
    chip(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

async function renderBrowse() {
  await act(async () => {
    root.render(<BrowsePage />)
  })
  await flush(6)
}

describe('#225 — a response for a category the customer has left must not be applied', () => {
  it('does not paint the abandoned category\'s items under the current heading', async () => {
    // Both categories are held so BOTH are in flight at once — the actual condition.
    held = ['cat-food', 'cat-drinks']
    await renderBrowse()

    await tap('Food')
    await tap('Drinks')

    // Drinks answers first: the customer is looking at Drinks and sees Drinks.
    await releaseCategory('cat-drinks')
    expect(text()).toContain('Coke')

    // Now Food — the category they LEFT — finally answers.
    await releaseCategory('cat-food')

    // The customer is still on Drinks. They must still be seeing Drinks.
    expect(text()).toContain('Coke')
    expect(text()).not.toContain('Beef Burger')
  })

  it('does not raise a failure notice for a category the customer has left', async () => {
    held = ['cat-food', 'cat-drinks']
    await renderBrowse()

    await tap('Food')
    await tap('Drinks')

    await releaseCategory('cat-drinks')
    expect(text()).toContain('Coke')

    // Food fails, late. The customer is on Drinks, which loaded perfectly.
    await releaseCategory('cat-food', 'fail')

    expect(text()).not.toMatch(/couldn.t load/i)
    expect(text()).toContain('Coke')
  })

  it('does not clear the notice belonging to the category actually on screen', async () => {
    held = ['cat-food', 'cat-drinks']
    await renderBrowse()

    await tap('Food')
    await tap('Drinks')

    // Drinks genuinely fails. The customer must be told.
    await releaseCategory('cat-drinks', 'fail')
    expect(text()).toMatch(/couldn.t load/i)

    // Food succeeds, late, for a category they are not looking at.
    await releaseCategory('cat-food')

    // The Drinks failure is still true and must still be on screen.
    expect(text()).toMatch(/couldn.t load/i)
  })

  /*
   * The interaction between #225 and #214.
   *
   * The cancellation guard has to cover the LOADING FLAG too, not just the data. A superseded run
   * finishing in a `finally` would report "not loading" while the category the customer is
   * actually on is still in flight — and with a previous successful load having already set
   * loadedOnce, menuBodyState then resolves to `empty` and prints "Menu coming soon!" for a load
   * that has not finished. That is #214, reintroduced through a different door.
   */
  it('does not leave the previous category on screen while the new one is still loading', async () => {
    // Food answers immediately, so the page is holding Food's items...
    await renderBrowse()
    await tap('Food')
    expect(text()).toContain('Beef Burger')

    // ...then Drinks is tapped and does NOT answer. Nothing has been cleared, so the page is
    // rendering Food's items under the Drinks heading before any race even occurs. This one is
    // unconditional — it does not need two requests in flight, only a switch and a slow response.
    held = ['cat-drinks']
    await tap('Drinks')

    expect(text()).not.toContain('Beef Burger')
    expect(text()).not.toContain('Menu coming soon!')
    expect(container.querySelector('[data-testid="menu-body-loading"]')).not.toBeNull()
  })

  it('does not fall back to the empty state when a superseded request finishes first', async () => {
    // A first successful load, so `loadedOnce` is true from here on — that is what makes the
    // window below reachable rather than hypothetical.
    await renderBrowse()
    await tap('Food')
    expect(text()).toContain('Beef Burger')

    // Drinks is tapped and held, then Food is tapped and held. The customer is on FOOD, and the
    // abandoned DRINKS request is still in flight.
    held = ['cat-drinks', 'cat-food']
    await tap('Drinks')
    await tap('Food')

    // The abandoned Drinks response lands while Food is still in flight. If its `finally` clears
    // the loading flag, menuBodyState resolves to `empty` and prints "Menu coming soon!" for a
    // load that has not finished — #214, through a different door.
    await releaseCategory('cat-drinks')

    expect(text()).not.toContain('Menu coming soon!')
    expect(text()).not.toMatch(/No items in "Food" yet/i)
    expect(container.querySelector('[data-testid="menu-body-loading"]')).not.toBeNull()
  })

  /*
   * CONTROLS — these pass on BOTH sides. Cancelling a stale response must not be achieved by
   * ignoring responses generally.
   */
  it('CONTROL: the current category still renders when its own response arrives', async () => {
    held = ['cat-food']
    await renderBrowse()

    await tap('Food')
    await releaseCategory('cat-food')

    expect(text()).toContain('Beef Burger')
  })

  it('CONTROL: a genuine failure of the current category is still reported', async () => {
    held = ['cat-food']
    await renderBrowse()

    await tap('Food')
    await releaseCategory('cat-food', 'fail')

    expect(text()).toMatch(/couldn.t load/i)
  })

  it('CONTROL: switching categories with no stale request still shows the new one', async () => {
    await renderBrowse()

    await tap('Food')
    expect(text()).toContain('Beef Burger')

    await tap('Drinks')
    expect(text()).toContain('Coke')
    expect(text()).not.toContain('Beef Burger')
  })
})
