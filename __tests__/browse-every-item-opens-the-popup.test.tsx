/**
 * @jest-environment jsdom
 *
 * EVERY menu item opens the popup, including one with nothing to choose.
 *
 * An item with no sizes, no add-ons and no variant groups used to be added straight from the
 * card. The add worked, but nothing on screen said so -- no dialog, no interruption -- so a
 * customer who was not watching the cart badge tapped again. The ruling: always open
 * ItemDetailModal, and for a zero-option item show the same component with nothing to
 * configure.
 *
 * The whole risk of that change is the SECOND describe below, not the first. Items with
 * variant groups and no add-ons ALSO took the silent path, and that path was the only thing in
 * the app that resolved a variant selection: it built `selected_variants`, the "- Large" suffix
 * and the variant-resolved price. ItemDetailModal rendered no variant UI at all. Routing those
 * items to the modal without giving it a variant chooser would have dropped the customer's
 * variant on the floor -- the line would reach the kitchen as a plain "Cappucinno" priced at an
 * unresolved base. So these tests assert the modal carries all three through.
 *
 * The variant fixture is the same production row __tests__/browse-required-variant-group-
 * orderability.test.tsx uses (menu_items e184dfe6-a077-4976-b9f3-286fd48d568b, "Cappucinno",
 * read read-only from ihlmmpmolnpchzgwyhgh on 2026-08-11): a `variant_groups` entry with no
 * `type`, which normalizeVariantGroups drops, plus a legacy `variants` column that synthesises
 * the required "Size" group instead. That legacy column is what customers actually see, so it
 * is the path worth pinning.
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
// ItemDetailModal is deliberately NOT mocked: it is the subject.
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
import { getSupabaseCategories } from '@/lib/supabase/menu'

const CATEGORIES = [{ id: 'cat-hot-drinks', name: 'Hot Drinks' }]

/** Nothing to choose: no sizes, no add-ons, no variants. The old silent-add case. */
const STILL_WATER = {
  id: 'still-water',
  name: 'Still Water',
  description: '500ml bottle',
  base_price: 15,
  status: 'active',
  has_sizes: false,
  has_addons: false,
  sizes: [],
  addons: [],
}

/** Verbatim from production menu_items, row e184dfe6-a077-4976-b9f3-286fd48d568b. */
const CAPPUCINNO = {
  id: 'e184dfe6-a077-4976-b9f3-286fd48d568b',
  name: 'Cappucinno',
  description: '',
  base_price: 45,
  status: 'active',
  has_sizes: false,
  has_addons: false,
  sizes: [],
  addons: [],
  variants: [
    { size: 'L', label: 'Large', price: 45 },
    { size: 'S', label: 'Small', price: 35 },
  ],
  variant_groups: [
    {
      id: 'size',
      name: 'Size',
      required: true,
      options: [
        { id: '250ml', name: '250ml', price_modifier: 0 },
        { id: '350ml', name: '350ml', price_modifier: 10 },
      ],
    },
  ],
}

let container: HTMLDivElement
let root: Root
let item: Record<string, unknown>

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
            items: [item],
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
  item = STILL_WATER
  addItem.mockReset()
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

/** The round + button on the menu card. */
function tapCard(itemName: string) {
  click(
    container.querySelector(`button[aria-label="Add ${itemName} to cart"]`),
    `card add button for ${itemName}`
  )
}

/**
 * True once ItemDetailModal is on screen.
 *
 * Keyed on the dialog ROLE, not on any string it renders. This used to search for the literal
 * "Customize Item" in its header — which was fine until that header was removed (every item
 * opens this modal now, and a bottle of water is not something to customize). A detector that
 * depends on copy turns every copy edit into a silent test failure, or worse, a silently
 * passing one.
 */
function popupIsOpen(): boolean {
  return Boolean(container.querySelector('[role="dialog"]'))
}

/** The popup's own Add to Cart button, which is the only one that reaches the cart now. */
function confirmInPopup() {
  const button = Array.from(container.querySelectorAll('button')).find((el) =>
    /add to cart/i.test(el.textContent || '')
  )
  click(button, 'popup Add to Cart button')
}

describe('an item with nothing to choose still opens the popup', () => {
  it('does NOT add silently on the card tap', async () => {
    await renderBrowse()
    tapCard('Still Water')

    // The whole point: the tap opens something the customer has to answer, rather than
    // changing a badge they were not looking at.
    expect(addItem).not.toHaveBeenCalled()
    expect(popupIsOpen()).toBe(true)
  })

  it('shows the item, its price, a quantity control and Add to Cart', async () => {
    await renderBrowse()
    tapCard('Still Water')

    const text = container.textContent || ''
    expect(text).toContain('Still Water')
    expect(text).toContain('500ml bottle')
    expect(text).toContain('15.00')
    expect(container.querySelector('[aria-label="Increase quantity"]')).not.toBeNull()
    expect(popupIsOpen()).toBe(true)
  })

  it('adds the line once the customer confirms in the popup', async () => {
    await renderBrowse()
    tapCard('Still Water')
    confirmInPopup()

    expect(addItem).toHaveBeenCalledTimes(1)
    const line = addItem.mock.calls[0][0]
    expect(line.menu_item_id).toBe('still-water')
    expect(line.quantity).toBe(1)
    expect(line.base_price).toBe(15)
    expect(line.subtotal).toBe(15)
    expect(line.selected_size).toBeNull()
    expect(line.selected_addons).toEqual([])
  })

  it('can add more than one, which the silent single-tap add could never do', async () => {
    await renderBrowse()
    tapCard('Still Water')
    click(container.querySelector('[aria-label="Increase quantity"]'), 'quantity +')
    confirmInPopup()

    const line = addItem.mock.calls[0][0]
    expect(line.quantity).toBe(2)
    expect(line.subtotal).toBe(30)
  })
})

describe('a variant item keeps its variant through the popup', () => {
  beforeEach(() => {
    item = CAPPUCINNO
  })

  it('renders a chooser for the group instead of dropping it', async () => {
    await renderBrowse()
    tapCard('Cappucinno')

    expect(popupIsOpen()).toBe(true)
    // Seeded to the same default the silent path resolved: the first legacy option.
    const checked = container.querySelector('[role="radio"][aria-checked="true"]')
    expect(checked?.getAttribute('value')).toBe('Large')
  })

  it('carries selected_variants, the display name and the resolved price into the cart', async () => {
    await renderBrowse()
    tapCard('Cappucinno')
    confirmInPopup()

    expect(addItem).toHaveBeenCalledTimes(1)
    const line = addItem.mock.calls[0][0]
    // All three of these came from the silent path and from nowhere else. Without the modal's
    // chooser the line arrives as a bare "Cappucinno" with no selection and the wrong price.
    expect(line.selected_variants).toEqual({ Size: 'Large' })
    expect(line.display_name).toBe('Cappucinno - Large')
    expect(line.base_price).toBe(45)
    expect(line.subtotal).toBe(45)
    // The legacy shim the cart, the ticket and line identity all read.
    expect(line.selected_size).toEqual({ name: 'Large', price_modifier: 0 })
  })

  it('honours a variant the customer already picked on the card', async () => {
    await renderBrowse()
    const chip = Array.from(container.querySelectorAll('button')).find((el) =>
      /^Small\b/.test((el.textContent || '').trim())
    )
    click(chip, 'Small chip on the card')
    tapCard('Cappucinno')
    confirmInPopup()

    // Opening the popup must not reset a choice that is still visible behind it.
    const line = addItem.mock.calls[0][0]
    expect(line.selected_variants).toEqual({ Size: 'Small' })
    expect(line.display_name).toBe('Cappucinno - Small')
    expect(line.base_price).toBe(35)
  })

  it('reprices when the customer changes the variant inside the popup', async () => {
    await renderBrowse()
    tapCard('Cappucinno')

    const smallRadio = Array.from(container.querySelectorAll('[role="radio"]')).find(
      (el) => el.getAttribute('value') === 'Small'
    )
    click(smallRadio, 'Small radio in the popup')
    confirmInPopup()

    const line = addItem.mock.calls[0][0]
    expect(line.selected_variants).toEqual({ Size: 'Small' })
    expect(line.base_price).toBe(35)
    expect(line.subtotal).toBe(35)
  })
})
