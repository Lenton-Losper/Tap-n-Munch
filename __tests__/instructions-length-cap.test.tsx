/**
 * Runs in the default node environment: renderToStaticMarkup is a server render and needs
 * MessageChannel, which jsdom does not provide.
 *
 * Issue #129. Nothing capped instruction text anywhere: no maxLength on the order-level
 * textarea, none on the per-item one, and the column is `text`. Rendering is safe -- every
 * consumer puts the value in JSX and React escapes it, and there is no dangerouslySetInnerHTML
 * in app/, components/ or lib/ -- so the exposure is a layout and print blowout, not XSS.
 *
 * These tests cover the client caps only. The server-side half is deliberately absent: see the
 * batch report. app/api/orders/route.ts is the order-creation path, and a silent slice there
 * would truncate the customer's own words (an allergy note is the obvious case) without telling
 * anyone.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { ItemDetailModal } from '@/components/menu/item-detail-modal'
import { MAX_INSTRUCTIONS_LENGTH } from '@/lib/orders/instruction-limits'

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
jest.mock('@/lib/tab-storage', () => ({ clearTabSession: jest.fn(), readStoredTabId: () => '' }))
jest.mock('@/lib/fetch-with-session', () => ({ fetchWithSession: jest.fn() }))
jest.mock('@/lib/handle-session-expired', () => ({ handleSessionExpired: jest.fn() }))
jest.mock('@/lib/kiosk', () => ({
  isKioskMode: () => false,
  getKioskName: () => '',
  kioskSuccessPath: () => '/',
}))

import CartPage from '@/app/menu/[restaurantId]/cart/page'

const drinkWithNote = {
  menu_item_id: 'coffee-1',
  name: 'Americano',
  display_name: 'Americano - Large',
  quantity: 1,
  base_price: 30,
  selected_size: null,
  selected_addons: [],
  selected_variants: { Size: 'Large' },
  special_instructions: 'no sugar',
  subtotal: 30,
}

function renderCart(items: any[]): string {
  cartItems.length = 0
  cartItems.push(...items)
  return renderToStaticMarkup(<CartPage />)
}

// This React version emits the attribute as written in JSX (maxLength), not lowercased.
function maxLengthsIn(html: string): string[] {
  return Array.from(html.matchAll(/<textarea[^>]*?maxlength="(\d+)"/gi)).map((m) => m[1])
}

function textareaCount(html: string): number {
  return (html.match(/<textarea/g) || []).length
}

describe('instruction length caps (#129)', () => {
  it('caps the order-level instructions box', () => {
    const html = renderCart([drinkWithNote])
    expect(html).toMatch(
      new RegExp(`<textarea[^>]*id="instructions"[^>]*maxlength="${MAX_INSTRUCTIONS_LENGTH}"`, "i"),
    )
  })

  it('caps the per-item note on the cart row', () => {
    const html = renderCart([drinkWithNote])
    expect(html).toMatch(
      new RegExp(`<textarea[^>]*id="item-note-0"[^>]*maxlength="${MAX_INSTRUCTIONS_LENGTH}"`, "i"),
    )
  })

  it('leaves no uncapped textarea on the cart page', () => {
    const html = renderCart([drinkWithNote, { ...drinkWithNote, special_instructions: 'oat milk' }])
    expect(maxLengthsIn(html)).toHaveLength(textareaCount(html))
    expect(new Set(maxLengthsIn(html))).toEqual(new Set([String(MAX_INSTRUCTIONS_LENGTH)]))
  })

  it('caps the special instructions field in the item modal', () => {
    const item = {
      id: 'coffee-1',
      name: 'Americano',
      base_price: 30,
      has_sizes: false,
      sizes: [],
      has_addons: false,
      addons: [],
      allow_special_instructions: true,
      image_url: null,
    }
    const html = renderToStaticMarkup(
      <ItemDetailModal
        item={item as never}
        restaurant={{ currency: 'N$' }}
        onClose={() => undefined}
        onAddToCart={() => undefined}
      />,
    )
    expect(html).toMatch(
      new RegExp(`<textarea[^>]*id="instructions"[^>]*maxlength="${MAX_INSTRUCTIONS_LENGTH}"`, "i"),
    )
  })
})
