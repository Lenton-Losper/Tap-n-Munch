/**
 * @jest-environment jsdom
 *
 * #200 residual lead — "FIVE variant groups are `required: true` while every order line carries
 * an EMPTY selection. Are those items ORDERABLE AT ALL?"
 *
 * Answered against the SHIPPED page, not a restatement of its rules: these tests render the real
 * app/menu/[restaurantId]/browse/page.tsx and feed it the EXACT menu_items JSON read read-only
 * from production (ref ihlmmpmolnpchzgwyhgh, 2026-08-11) for
 * e184dfe6-a077-4976-b9f3-286fd48d568b "Cappucinno" (FNB ChowNow).
 *
 * The production row carries BOTH shapes at once, and that is what makes it decisive:
 *
 *   variant_groups: [{ id:'size', name:'Size', required:true,
 *                      options:[{id:'250ml',name:'250ml',price_modifier:0}, ...] }]   <- NO `type`
 *   variants:       [{ size:'L', label:'Large', price:45 }, { size:'S', ... }]        <- legacy
 *
 * normalizeVariantGroups (now lib/menu/variant-groups.ts) rejects any group whose `type` is not
 * 'price'|'text', so the required group is DROPPED and the legacy `variants` fallback
 * synthesises the Size group instead. The two shapes carry DIFFERENT option labels
 * ("Large"/"Small" vs "250ml"/"350ml"/"500ml"), so whichever set renders names the code path
 * unambiguously.
 *
 * WHAT CHANGED SINCE THIS WAS WRITTEN. Every item now opens ItemDetailModal -- a silent add
 * left the customer with no confirmation, so they tapped again. The card's + button therefore
 * opens the popup and the popup's Add to Cart is what reaches the cart. #200's question is
 * unchanged and so are the answers below; only the number of taps between them moved, so these
 * tests drive the real modal rather than mocking it away. That the LINE still comes out whole
 * on the other side is the subject of __tests__/browse-every-item-opens-the-popup.test.tsx.
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
// ItemDetailModal is NOT mocked: it is now the only way a line reaches the cart from here.
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
// isInTab: true -- otherwise renderAddButton's first disabled clause fires for reasons that have
// nothing to do with variants, and the test would prove only that a tabless customer cannot order.
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

/** Verbatim from production menu_items, row e184dfe6-a077-4976-b9f3-286fd48d568b. */
const PROD_REQUIRED_GROUP = {
  id: 'size',
  name: 'Size',
  options: [
    { id: '250ml', name: '250ml', price_modifier: 0 },
    { id: '350ml', name: '350ml', price_modifier: 10 },
    { id: '500ml', name: '500ml', price_modifier: 15 },
  ],
  required: true,
}
const PROD_LEGACY_VARIANTS = [
  { size: 'L', label: 'Large', price: 45 },
  { size: 'S', label: 'Small', price: 35 },
]

function cappucinno(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e184dfe6-a077-4976-b9f3-286fd48d568b',
    name: 'Cappucinno',
    base_price: 45,
    status: 'active',
    has_sizes: false,
    has_addons: false,
    sizes: [],
    addons: [],
    variants: PROD_LEGACY_VARIANTS,
    variant_groups: [PROD_REQUIRED_GROUP],
    ...overrides,
  }
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
  item = cappucinno()
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

function addButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Add Cappucinno to cart"]')
  if (!button) throw new Error('Add button not rendered')
  return button
}

/**
 * The card's + opens the popup; the popup's Add to Cart is what calls addItem. No settle step:
 * the 1000ms sleep that used to sit in the silent add went with the silent add.
 */
async function clickAddAndSettle() {
  await act(async () => {
    addButton().click()
  })
  const confirm = Array.from(container.querySelectorAll('button')).find((el) =>
    /add to cart/i.test(el.textContent || '')
  )
  if (!confirm) throw new Error('popup Add to Cart not rendered')
  await act(async () => {
    confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('#200: are the five required-variant-group items orderable?', () => {
  it('renders the LEGACY variant labels, not the required group\'s options', async () => {
    await renderBrowse()
    const text = container.textContent || ''

    // The legacy `variants` column is what drives the selector...
    expect(text).toContain('Large')
    expect(text).toContain('Small')
    // ...and the required group's own options never reach the screen, because
    // normalizeVariantGroups drops a group with no `type` (browse/page.tsx:280,282).
    expect(text).not.toContain('350ml')
    expect(text).not.toContain('500ml')
  })

  it('IS orderable: the Add button is enabled and the line carries a non-empty selection', async () => {
    await renderBrowse()
    expect(addButton().disabled).toBe(false)

    await clickAddAndSettle()

    expect(addItem).toHaveBeenCalledTimes(1)
    const line = addItem.mock.calls[0][0]
    expect(line.menu_item_id).toBe('e184dfe6-a077-4976-b9f3-286fd48d568b')
    // getDefaultGroupSelection preselects the first legacy option, so a QR line for this item
    // can never leave with an empty selection -- which is why production's 11 empty lines are
    // all channel='pos' and its 4 QR lines all read {"Size":"Large"} / {"Size":"250ml"}.
    expect(line.selected_variants).toEqual({ Size: 'Large' })
    expect(line.display_name).toBe('Cappucinno - Large')
  })

  it('LATENT: with the legacy column empty, required:true stops enforcing anything', async () => {
    // Same production row, legacy `variants` cleared -- the shape any item would have if the
    // menu editor wrote only variant_groups. Nothing else changes.
    item = cappucinno({ variants: [] })
    await renderBrowse()

    // No selector at all: the required group is dropped and there is no fallback left.
    expect(container.textContent || '').not.toContain('Large')
    expect(container.textContent || '').not.toContain('350ml')

    // Still orderable. `required: true` blocks nothing, because isRequiredVariantMissing
    // (browse/page.tsx:364-369) iterates getVariantGroups(), which is now empty.
    expect(addButton().disabled).toBe(false)

    await clickAddAndSettle()
    expect(addItem).toHaveBeenCalledTimes(1)
    // THIS is the shape #200's lead described: a required group, and an empty selection. The
    // modal omits the key rather than writing `{}` where there is no group to resolve; either
    // way the line leaves with no variant on it and `required: true` stopped nothing.
    expect(addItem.mock.calls[0][0].selected_variants ?? {}).toEqual({})
  })
})
