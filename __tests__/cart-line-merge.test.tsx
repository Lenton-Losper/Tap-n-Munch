/**
 * @jest-environment jsdom
 *
 * Issue #133 — `addItem` always appended, so tapping + twice on the same drink produced two
 * separate "Cappuccino - Large ×1" cards with no way to combine them.
 *
 * Asserted through the real CartProvider and, for the merge itself, against the MOUNTED cart
 * page: the defect the customer reports is "two cards on my cart", so the count of rendered
 * cards is the thing that has to change, not just the length of an array.
 *
 * The negative cases matter as much as the positive one. A line is the same line only when it
 * would RENDER identically — same item, same size, same variants, same add-ons, same note, same
 * unit price. Merging on menu_item_id alone would fold a Large into a Small and silently change
 * what the customer is charged.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useEffect } from 'react'
import { MAX_LINE_QUANTITY } from '@/lib/orders/quantity-limits'

jest.mock('@/lib/session', () => ({
  getCurrentSession: () => 'sess-1',
  getOrCreateSession: () => 'sess-1',
}))

jest.mock('next/navigation', () => ({
  useParams: () => ({ restaurantId: 'riviera' }),
  useSearchParams: () => new URLSearchParams('table=4'),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
}))

jest.mock('next/image', () => ({
  __esModule: true,
  default: (props: any) => {
    const { src, alt } = props
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={typeof src === 'string' ? src : ''} alt={alt} />
  },
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
    isInTab: false,
    tabId: '',
    sessionId: 'sess-1',
    tabStatus: null,
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
jest.mock('@/lib/guest-orders/client', () => ({ fetchGuestOrdersBySession: jest.fn() }))
jest.mock('@/lib/idempotency', () => ({
  clearCartIdempotencyKey: jest.fn(),
  getOrCreateCartIdempotencyKey: () => 'idem-1',
}))
jest.mock('@/lib/tab-storage', () => ({ clearTabSession: jest.fn(), readStoredTabId: () => '' }))
jest.mock('@/lib/fetch-with-session', () => ({ fetchWithSession: jest.fn() }))
jest.mock('@/lib/handle-session-expired', () => ({ handleSessionExpired: jest.fn() }))
jest.mock('@/lib/kiosk', () => ({
  isKioskMode: () => false,
  getKioskName: () => '',
  kioskSuccessPath: () => '/',
}))

import { CartProvider, useCart, type CartItem } from '@/contexts/cart-context'
import CartPage from '@/app/menu/[restaurantId]/cart/page'

function cappuccino(over: Partial<CartItem> = {}): CartItem {
  return {
    menu_item_id: 'coffee-1',
    name: 'Cappuccino',
    display_name: 'Cappuccino - Large',
    quantity: 1,
    base_price: 30,
    selected_size: { name: 'Large', price_modifier: 5 },
    selected_addons: [],
    selected_variants: { Size: 'Large' },
    special_instructions: '',
    subtotal: 35,
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let cart: ReturnType<typeof useCart> | null = null

/** Publishes the live context value so a test can drive addItem the way a tap does. */
function CartProbe() {
  const value = useCart()
  useEffect(() => {
    cart = value
  })
  cart = value
  return null
}

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  window.localStorage.clear()
  cart = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

/** Mounts the probe alone — for the identity assertions, which are about cart state. */
async function mountProbe() {
  await act(async () => {
    root.render(
      <CartProvider>
        <CartProbe />
      </CartProvider>,
    )
  })
}

/** Mounts the real cart page — for the assertion about what the customer sees. */
async function mountCartPage() {
  await act(async () => {
    root.render(
      <CartProvider>
        <CartProbe />
        <CartPage />
      </CartProvider>,
    )
  })
}

async function add(item: CartItem) {
  await act(async () => {
    cart!.addItem(item)
  })
}

/** One rendered card per cart line: the cart page maps items one-to-one onto these headings. */
function renderedLineLabels(): string[] {
  return Array.from(container.querySelectorAll('h3')).map((h) => h.textContent || '')
}

describe('cart line merging (#133)', () => {
  it('shows ONE card at ×2 when the same drink is added twice', async () => {
    await mountCartPage()
    await add(cappuccino())
    await add(cappuccino())

    expect(renderedLineLabels().filter((l) => l === 'Cappuccino - Large')).toHaveLength(1)
    expect(container.textContent).toContain('(×2)')
    expect(cart!.items).toHaveLength(1)
    expect(cart!.items[0].quantity).toBe(2)
    expect(cart!.items[0].subtotal).toBe(70)
    expect(cart!.getItemCount()).toBe(2)
    expect(cart!.getTotal()).toBe(70)
  })

  it('keeps two DIFFERENT sizes as separate lines', async () => {
    await mountProbe()
    await add(cappuccino())
    await add(
      cappuccino({
        display_name: 'Cappuccino - Small',
        selected_size: { name: 'Small', price_modifier: 0 },
        selected_variants: { Size: 'Small' },
        subtotal: 30,
      }),
    )

    expect(cart!.items).toHaveLength(2)
    expect(cart!.items.map((i) => i.quantity)).toEqual([1, 1])
  })

  it('keeps two different per-item notes as separate lines', async () => {
    await mountProbe()
    await add(cappuccino({ special_instructions: 'no sugar' }))
    await add(cappuccino({ special_instructions: 'extra hot' }))

    expect(cart!.items).toHaveLength(2)
  })

  it('merges the same note written with stray whitespace', async () => {
    await mountProbe()
    await add(cappuccino({ special_instructions: 'no sugar' }))
    await add(cappuccino({ special_instructions: '  no sugar ' }))

    expect(cart!.items).toHaveLength(1)
    expect(cart!.items[0].quantity).toBe(2)
  })

  it('keeps different add-on sets separate but merges the same set in any order', async () => {
    await mountProbe()
    const oat = { name: 'Oat milk', price: 5 }
    const shot = { name: 'Extra shot', price: 8 }

    await add(cappuccino({ selected_addons: [oat, shot], subtotal: 48 }))
    await add(cappuccino({ selected_addons: [shot, oat], subtotal: 48 }))
    await add(cappuccino({ selected_addons: [oat], subtotal: 40 }))

    expect(cart!.items).toHaveLength(2)
    expect(cart!.items[0].quantity).toBe(2)
    expect(cart!.items[0].subtotal).toBe(96)
    expect(cart!.items[1].quantity).toBe(1)
  })

  it('keeps lines with different unit prices separate', async () => {
    await mountProbe()
    await add(cappuccino())
    await add(cappuccino({ base_price: 34, subtotal: 39 }))

    expect(cart!.items).toHaveLength(2)
  })

  it('never merges a line past the per-line quantity the server accepts', async () => {
    await mountProbe()
    await add(cappuccino({ quantity: MAX_LINE_QUANTITY, subtotal: 35 * MAX_LINE_QUANTITY }))
    await add(cappuccino())

    // A merged line of MAX+1 would make the whole order 400 at app/api/orders. Appending keeps
    // it orderable, which is exactly what happens today.
    expect(cart!.items).toHaveLength(2)
    expect(cart!.items[0].quantity).toBe(MAX_LINE_QUANTITY)
    expect(cart!.items[1].quantity).toBe(1)

    // A third add has somewhere to go: the second line still has room.
    await add(cappuccino())
    expect(cart!.items).toHaveLength(2)
    expect(cart!.items[1].quantity).toBe(2)
  })

  it('adds money without floating-point residue', async () => {
    await mountProbe()
    await add(cappuccino({ base_price: 0.1, subtotal: 0.1 }))
    await add(cappuccino({ base_price: 0.1, subtotal: 0.2, quantity: 2 }))

    expect(cart!.items).toHaveLength(1)
    expect(cart!.items[0].subtotal).toBe(0.3)
  })
})
