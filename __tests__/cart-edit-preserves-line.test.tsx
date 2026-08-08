/**
 * @jest-environment jsdom
 *
 * Issue #126. The cart row's Edit button is the only way to change a line's quantity, and it
 * opened ItemDetailModal with nothing seeded from the line: quantity reset to 1, size back to
 * the cheapest option, add-ons cleared, the note dropped, and a variant drink repriced from
 * `base_price`. "Cappuccino - Large x3 -- N$105" came back as "Cappuccino x1 -- N$20".
 *
 * The modal renders no variant-group UI (see cart-per-item-instructions.test.tsx), so a
 * variant line's `selected_variants` / `display_name` / variant-resolved price can only be
 * round-tripped, never re-derived -- these tests pin that too.
 *
 * Last section: an edit can make line A identical to line B. Those two lines must not sit in
 * the cart as visual duplicates, which is the state #133 removed from the add path.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('@/components/menu/food-item-image', () => ({
  FoodItemImage: () => null,
}))

// --- mocks for the cart page, which the last describe drives end to end ---

jest.mock('next/navigation', () => ({
  useParams: () => ({ restaurantId: 'riviera' }),
  useSearchParams: () => new URLSearchParams('table=4'),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}))

jest.mock('next/image', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children }: any) => <span>{children}</span>,
}))

jest.mock('@/contexts/restaurant-context', () => ({
  useRestaurant: () => ({
    restaurant: { id: 'riviera', name: 'Riviera', currency: 'N$' },
    settings: {},
    currency: 'N$',
    paymentMethods: ['cash'],
    kioskPaymentMethods: ['cash'],
    permissions: {},
    loading: false,
  }),
}))

jest.mock('@/contexts/tab-context', () => ({
  useTab: () => ({
    isInTab: true,
    tabId: 'tab-1',
    sessionId: 'sess-1',
    tabStatus: 'open',
    refreshTab: jest.fn(),
  }),
}))

jest.mock('@/hooks/useClearCartOnTableChange', () => ({
  useClearCartOnTableChange: () => undefined,
}))
jest.mock('@/hooks/useTabSessionEndedRedirect', () => ({
  useTabSessionEndedRedirect: () => ({ redirecting: false }),
}))
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }))
jest.mock('@/lib/supabase/menu', () => ({ getSupabaseMenuItemById: jest.fn() }))
jest.mock('@/lib/guest-orders/client', () => ({
  fetchGuestOrdersBySession: jest.fn(async () => ({ count: 0, orders: [] })),
}))
jest.mock('@/lib/session', () => ({
  getOrCreateSession: () => 'sess-1',
  getCurrentSession: () => 'sess-1',
}))
jest.mock('@/lib/idempotency', () => ({
  clearCartIdempotencyKey: jest.fn(),
  getOrCreateCartIdempotencyKey: () => 'idem-1',
}))
jest.mock('@/lib/tab-storage', () => ({
  clearTabSession: jest.fn(),
  readStoredTabId: () => '',
}))
jest.mock('@/lib/fetch-with-session', () => ({ fetchWithSession: jest.fn() }))
jest.mock('@/lib/handle-session-expired', () => ({ handleSessionExpired: jest.fn() }))
jest.mock('@/lib/kiosk', () => ({
  isKioskMode: () => false,
  getKioskName: () => '',
  kioskSuccessPath: () => '/',
}))

import { ItemDetailModal } from '@/components/menu/item-detail-modal'
import { applyCartLineEdit, sameCartLine } from '@/lib/cart/cart-lines'
import { CartProvider, type CartItem } from '@/contexts/cart-context'
import { getSupabaseMenuItemById } from '@/lib/supabase/menu'
import CartPage from '@/app/menu/[restaurantId]/cart/page'
import { MAX_LINE_QUANTITY } from '@/lib/orders/quantity-limits'

/** A menu item with sizes and add-ons -- the shape the modal was written for. */
const CAPPUCCINO = {
  id: 'cappuccino',
  name: 'Cappuccino',
  description: '',
  base_price: 20,
  has_sizes: true,
  sizes: [
    { name: 'Regular', price_modifier: 0 },
    { name: 'Large', price_modifier: 15 },
  ],
  has_addons: true,
  addons: [
    { name: 'Extra shot', price: 5 },
    { name: 'Oat milk', price: 8 },
  ],
  allow_special_instructions: true,
  image_url: null,
}

/** The line the customer is looking at when they press Edit: Large, x3, one add-on, a note. */
const EXISTING_LINE: CartItem = {
  menu_item_id: 'cappuccino',
  name: 'Cappuccino',
  quantity: 3,
  base_price: 20,
  selected_size: { name: 'Large', price_modifier: 15 },
  selected_addons: [{ name: 'Extra shot', price: 5 }],
  special_instructions: 'extra hot please',
  subtotal: 120,
}

/** A variant-group drink as browse/page.tsx quick-adds it: price already variant-resolved. */
const VARIANT_LINE: CartItem = {
  menu_item_id: 'americano',
  name: 'Americano',
  display_name: 'Americano - Large',
  quantity: 2,
  base_price: 35,
  selected_size: { name: 'Large', price_modifier: 0 },
  selected_addons: [],
  selected_variants: { Size: 'Large' },
  special_instructions: 'no sugar',
  subtotal: 70,
}

const AMERICANO = {
  id: 'americano',
  name: 'Americano',
  description: '',
  base_price: 20,
  has_sizes: false,
  sizes: [],
  has_addons: true,
  addons: [{ name: 'Oat milk', price: 8 }],
  allow_special_instructions: true,
  image_url: null,
  variantGroups: [
    { name: 'Size', required: true, type: 'price', options: [{ label: 'Small', price: 20 }, { label: 'Large', price: 35 }] },
  ],
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Renders the modal in edit mode and returns whatever Add to Cart hands back. */
function addToCartFrom(item: unknown, editingLine: CartItem | null): CartItem {
  const onAddToCart = jest.fn()
  act(() => {
    root.render(
      <ItemDetailModal
        item={item as never}
        editingLine={editingLine}
        restaurant={{ currency: 'N$' }}
        onClose={() => {}}
        onAddToCart={onAddToCart}
      />,
    )
  })

  const button = Array.from(container.querySelectorAll('button')).find((el) =>
    /add to cart/i.test(el.textContent || ''),
  )
  if (!button) throw new Error('Add to Cart button not rendered')
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  expect(onAddToCart).toHaveBeenCalledTimes(1)
  return onAddToCart.mock.calls[0][0] as CartItem
}

describe('editing a cart line (#126)', () => {
  it('re-adds the line unchanged when the customer opens Edit and confirms without touching anything', () => {
    const result = addToCartFrom(CAPPUCCINO, EXISTING_LINE)

    expect(result.quantity).toBe(3)
    expect(result.selected_size).toEqual({ name: 'Large', price_modifier: 15 })
    expect(result.selected_addons).toEqual([{ name: 'Extra shot', price: 5 }])
    expect(result.special_instructions).toBe('extra hot please')
    // (20 base + 15 size + 5 addon) * 3 -- what the row already said.
    expect(result.subtotal).toBe(120)
  })

  it('shows the existing quantity and the size the line was ordered with', () => {
    act(() => {
      root.render(
        <ItemDetailModal
          item={CAPPUCCINO as never}
          editingLine={EXISTING_LINE}
          restaurant={{ currency: 'N$' }}
          onClose={() => {}}
          onAddToCart={() => {}}
        />,
      )
    })

    const quantityText = container.querySelector('span.w-8')?.textContent
    expect(quantityText).toBe('3')

    const checkedRadio = container.querySelector('[role="radio"][aria-checked="true"]')
    expect(checkedRadio?.getAttribute('value')).toBe('Large')

    const textarea = container.querySelector('textarea')
    expect((textarea as HTMLTextAreaElement | null)?.value).toBe('extra hot please')
  })

  it('keeps a variant drink whole: its variants, display name and variant-resolved price', () => {
    const result = addToCartFrom(AMERICANO, VARIANT_LINE)

    expect(result.selected_variants).toEqual({ Size: 'Large' })
    expect(result.display_name).toBe('Americano - Large')
    // The modal cannot re-resolve a variant price, so it must not fall back to
    // item.base_price (20) -- that is the N$20 in the report.
    expect(result.base_price).toBe(35)
    expect(result.subtotal).toBe(70)
    expect(result.special_instructions).toBe('no sugar')
  })

  it('still behaves like a fresh add when no line is being edited', () => {
    const result = addToCartFrom(CAPPUCCINO, null)

    expect(result.quantity).toBe(1)
    expect(result.selected_size).toEqual({ name: 'Regular', price_modifier: 0 })
    expect(result.selected_addons).toEqual([])
    expect(result.special_instructions).toBe('')
    expect(result.subtotal).toBe(20)
  })
})

describe('an edit that collides with another line (#126 / #133)', () => {
  const lineA: CartItem = { ...EXISTING_LINE, quantity: 3, subtotal: 120 }
  const lineB: CartItem = {
    ...EXISTING_LINE,
    quantity: 2,
    selected_size: { name: 'Regular', price_modifier: 0 },
    subtotal: 50,
  }

  it('treats item + variant + size + add-ons + note as one line identity', () => {
    expect(sameCartLine(lineA, { ...lineA, quantity: 9, subtotal: 1 })).toBe(true)
    expect(sameCartLine(lineA, lineB)).toBe(false)
    expect(sameCartLine(lineA, { ...lineA, special_instructions: 'no foam' })).toBe(false)
    expect(sameCartLine(VARIANT_LINE, { ...VARIANT_LINE, selected_variants: { Size: 'Small' } })).toBe(false)
  })

  it('merges into the existing line instead of leaving two identical rows', () => {
    // Customer edits line B (Regular x2) up to Large -- now identical to line A.
    const editedB: CartItem = { ...lineB, selected_size: { name: 'Large', price_modifier: 15 }, subtotal: 80 }
    const result = applyCartLineEdit([lineA, lineB], 1, editedB)

    expect(result.items).toHaveLength(1)
    expect(result.items[0].quantity).toBe(5)
    expect(result.items[0].subtotal).toBe(200) // 40 per unit
    expect(result.merged).toBe(true)
    expect(result.clamped).toBe(false)
  })

  it('leaves the other lines alone when the edit collides with nothing', () => {
    const editedA: CartItem = { ...lineA, quantity: 4, subtotal: 160 }
    const result = applyCartLineEdit([lineA, lineB], 0, editedA)

    expect(result.items).toEqual([editedA, lineB])
    expect(result.merged).toBe(false)
  })

  it('caps a merge at the per-line maximum and says so rather than silently overshooting', () => {
    const big: CartItem = { ...lineA, quantity: 18, subtotal: 720 }
    const edited: CartItem = { ...lineA, quantity: 5, subtotal: 200 }
    const result = applyCartLineEdit([big, { ...lineB }], 0, edited)

    // Nothing collides here (big IS the line being edited); the collision case:
    const collide = applyCartLineEdit([big, edited], 1, { ...edited })
    expect(result.merged).toBe(false)
    expect(collide.items).toHaveLength(1)
    expect(collide.items[0].quantity).toBe(MAX_LINE_QUANTITY)
    expect(collide.clamped).toBe(true)
  })
})

describe('the cart row itself (#126, end to end through the page)', () => {
  /** Renders the real cart page over a real CartProvider hydrated with these lines. */
  async function renderCartWith(lines: CartItem[]) {
    localStorage.setItem('cart', JSON.stringify(lines))
    localStorage.setItem('cart_session_id', 'sess-1')
    await act(async () => {
      root.render(
        <CartProvider>
          <CartPage />
        </CartProvider>,
      )
    })
  }

  function buttonMatching(pattern: RegExp): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find((el) =>
      pattern.test(el.textContent || ''),
    )
    if (!button) throw new Error(`no button matching ${pattern}`)
    return button as HTMLButtonElement
  }

  beforeEach(() => {
    localStorage.clear()
    ;(getSupabaseMenuItemById as jest.Mock).mockReset()
    ;(getSupabaseMenuItemById as jest.Mock).mockResolvedValue(CAPPUCCINO)
  })

  it('opens Edit on the line the customer pressed, already showing its quantity and size', async () => {
    await renderCartWith([EXISTING_LINE])

    await act(async () => {
      buttonMatching(/^\s*Edit/).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Customize Item')
    expect(container.querySelector('span.w-8')?.textContent).toBe('3')
    expect(
      container.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('value'),
    ).toBe('Large')
  })

  it('leaves the line exactly as it was when Edit is confirmed untouched', async () => {
    await renderCartWith([EXISTING_LINE])

    await act(async () => {
      buttonMatching(/^\s*Edit/).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonMatching(/Add to Cart/i).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const stored = JSON.parse(localStorage.getItem('cart') || '[]') as CartItem[]
    expect(stored).toHaveLength(1)
    expect(stored[0].quantity).toBe(3)
    expect(stored[0].selected_size).toEqual({ name: 'Large', price_modifier: 15 })
    expect(stored[0].special_instructions).toBe('extra hot please')
    expect(stored[0].subtotal).toBe(120)
    // What the customer reads on the row.
    expect(container.textContent).toContain('120.00')
    expect(container.textContent).toContain('×3')
  })
})
