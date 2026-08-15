/**
 * Runs in the default node environment: renderToStaticMarkup is a server render and needs
 * MessageChannel, which jsdom does not provide.
 *
 * Issue #130. `browse/page.tsx` quick-adds any item that has no addons — including the
 * variant-group drinks Riviera sells — and hardcodes `special_instructions: ''`. The item
 * modal is the only place the per-item field exists, and the cart's Edit button cannot stand
 * in for it: the modal renders no variant-group UI, so reopening a variant drink through it
 * drops `selected_variants` / `display_name` and recomputes the price from `base_price`.
 *
 * So the cart row itself has to carry the per-item note. These tests pin that, plus the
 * order-level label, which said only "Order Instructions (Optional)" and gave the customer
 * nothing to distinguish it from a note about one drink.
 */
import { renderToStaticMarkup } from 'react-dom/server'

const cartItems: any[] = []

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

jest.mock('@/contexts/cart-context', () => ({
  useCart: () => ({
    items: cartItems,
    updateItem: jest.fn(),
    removeItem: jest.fn(),
    clearCart: jest.fn(),
    getTotal: () => cartItems.reduce((sum, i) => sum + i.subtotal, 0),
    getItemCount: () => cartItems.length,
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

import CartPage from '@/app/menu/[restaurantId]/cart/page'

/** A drink as `browse/page.tsx` quick-adds it: variants resolved, instructions hardcoded ''. */
const quickAddedDrink = {
  menu_item_id: 'coffee-1',
  name: 'Americano',
  display_name: 'Americano - Large',
  quantity: 1,
  base_price: 30,
  selected_size: { name: 'Large', price_modifier: 0 },
  selected_addons: [],
  selected_variants: { Size: 'Large' },
  special_instructions: '',
  subtotal: 30,
}

const drinkWithNote = {
  ...quickAddedDrink,
  menu_item_id: 'coffee-2',
  display_name: 'Americano - Small',
  special_instructions: 'no sugar',
  selected_variants: { Size: 'Small' },
}

function renderCart(items: any[]): string {
  cartItems.length = 0
  cartItems.push(...items)
  return renderToStaticMarkup(<CartPage />)
}

describe('cart: per-item instructions (#130)', () => {
  it('offers a note control on a quick-added row that has no instructions yet', () => {
    const html = renderCart([quickAddedDrink])
    // The customer who wants "no sugar" on one of two coffees must be able to say so
    // against that coffee, not only in the order-level box.
    expect(html).toMatch(/Add a note/i)
  })

  it('names the item in the note affordance so two identical drinks stay distinguishable', () => {
    const html = renderCart([quickAddedDrink, drinkWithNote])
    expect(html).toContain('Americano - Large')
    expect(html).toMatch(/aria-label="[^"]*Americano - Large[^"]*"/)
  })

  it('opens an editable textarea prefilled with a note the item already carries', () => {
    const html = renderCart([drinkWithNote])
    expect(html).toMatch(/<textarea[^>]*id="item-note-0"/)
    expect(html).toContain('no sugar')
  })

  it('does not route the customer through the item modal to leave a note', () => {
    // Reopening a variant drink in the modal drops selected_variants and reprices it,
    // so "just press Edit" is not a workaround.
    const html = renderCart([quickAddedDrink])
    // Was `not.toMatch(/Customize Item/)`. That header has been removed, so the old assertion
    // would have passed against a cart that DID render the modal — a negative check that can no
    // longer fail is worse than no check. The dialog role is what actually marks it open.
    expect(html).not.toMatch(/role="dialog"/)
  })

  it('says the order-level box applies to the whole order', () => {
    const html = renderCart([quickAddedDrink])
    expect(html).toMatch(/whole order/i)
  })
})
