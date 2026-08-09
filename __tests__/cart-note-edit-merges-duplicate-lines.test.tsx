/**
 * @jest-environment jsdom
 *
 * Residual of #133 / #126 — the second way an edit can produce two rows the customer cannot
 * tell apart.
 *
 * #126 made the modal edit path fold collisions: cart/page.tsx sends the edited line through
 * applyCartLineEdit() and replaces the whole list. But the per-item note added by #130 is
 * edited straight on the cart row, and that control called `updateItem(index, ...)` directly
 * -- writing one slot of the array and consulting nothing else.
 *
 * The note IS part of a line's identity (lib/cart/cart-lines.ts keys on item, variants, size,
 * add-ons and note), so retyping one row's note until it matches another row's note produces
 * exactly the duplicate state #133 exists to prevent, by the one edit path that never went
 * through the merge.
 *
 * Timing matters here in a way it does not for the modal. The modal has an explicit "Add to
 * Cart" commit; a textarea fires onChange per keystroke. Folding per keystroke would delete
 * the row the customer is typing into the moment the text happens to match -- so the fold is
 * on commit (blur), and the last test below pins that.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('@/components/menu/food-item-image', () => ({
  FoodItemImage: () => null,
}))

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

/** Stable across renders so "did the customer get told?" is actually assertable. */
const mockToast = jest.fn()
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mockToast }) }))

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

import { CartProvider, type CartItem } from '@/contexts/cart-context'
import CartPage from '@/app/menu/[restaurantId]/cart/page'

/** Two lines that differ ONLY by their note, so the note decides whether they are one row. */
const NOTED_LINE: CartItem = {
  menu_item_id: 'cappuccino',
  name: 'Cappuccino',
  quantity: 1,
  base_price: 20,
  selected_size: { name: 'Large', price_modifier: 15 },
  selected_addons: [{ name: 'Extra shot', price: 5 }],
  special_instructions: 'extra hot',
  subtotal: 40,
}

const UNNOTED_LINE: CartItem = {
  ...NOTED_LINE,
  quantity: 2,
  special_instructions: '',
  subtotal: 80,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  localStorage.clear()
  mockToast.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

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

function noteBox(index: number): HTMLTextAreaElement {
  const el = container.querySelector(`#item-note-${index}`)
  if (!el) throw new Error(`no note textarea for row ${index}`)
  return el as HTMLTextAreaElement
}

/** Reveals the collapsed "Add a note" control on a row that has no note yet. */
async function openNoteBox(itemLabel: string) {
  const button = Array.from(container.querySelectorAll('button')).find((el) =>
    new RegExp(`Add a note for ${itemLabel}`, 'i').test(el.getAttribute('aria-label') || ''),
  )
  if (!button) throw new Error(`no "Add a note" control for ${itemLabel}`)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** Types into a controlled textarea the way a customer does: one onChange per character. */
async function typeInto(textarea: HTMLTextAreaElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )!.set!
  for (let i = 1; i <= text.length; i++) {
    await act(async () => {
      setValue.call(textarea, text.slice(0, i))
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
}

/** React maps onBlur to the bubbling focusout event. */
async function commit(textarea: HTMLTextAreaElement) {
  await act(async () => {
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

const storedCart = () => JSON.parse(localStorage.getItem('cart') || '[]') as CartItem[]
const renderedRows = () => container.querySelectorAll('textarea[id^="item-note-"]').length

describe('editing a cart row note into a duplicate (#133 residual)', () => {
  it('folds the two rows into one when the note is committed', async () => {
    await renderCartWith([NOTED_LINE, UNNOTED_LINE])

    // Row 1 has no note yet, so its textarea is collapsed behind "Add a note".
    await openNoteBox('Cappuccino')
    await typeInto(noteBox(1), 'extra hot')
    await commit(noteBox(1))

    const cart = storedCart()
    expect(cart).toHaveLength(1)
    expect(cart[0].quantity).toBe(3)
    // 40 a unit -- what both rows already charged.
    expect(cart[0].subtotal).toBe(120)
    expect(cart[0].special_instructions).toBe('extra hot')
  })

  it('shows the customer one row, and says why', async () => {
    await renderCartWith([NOTED_LINE, UNNOTED_LINE])

    await openNoteBox('Cappuccino')
    await typeInto(noteBox(1), 'extra hot')
    await commit(noteBox(1))

    expect(renderedRows()).toBe(1)
    expect(container.textContent).toContain('×3')
    expect(container.textContent).toContain('120.00')
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(/combined/i) }),
    )
  })

  it('folds equally when the note is cleared to match a row that has none', async () => {
    // The other direction: erasing "extra hot" makes row 0 identical to row 1.
    await renderCartWith([NOTED_LINE, UNNOTED_LINE])

    const box = noteBox(0)
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!
      setValue.call(box, '')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await commit(box)

    const cart = storedCart()
    expect(cart).toHaveLength(1)
    expect(cart[0].quantity).toBe(3)
    expect(cart[0].special_instructions).toBe('')
  })

  // CONTROL — must hold before and after. A fold that fired on anything would pass the
  // tests above; this is what stops "merge everything" masquerading as the fix.
  it('leaves two rows when the committed note matches nothing', async () => {
    await renderCartWith([NOTED_LINE, UNNOTED_LINE])

    await openNoteBox('Cappuccino')
    await typeInto(noteBox(1), 'oat milk')
    await commit(noteBox(1))

    const cart = storedCart()
    expect(cart).toHaveLength(2)
    expect(cart[0].special_instructions).toBe('extra hot')
    expect(cart[1].special_instructions).toBe('oat milk')
    expect(cart[1].quantity).toBe(2)
    expect(mockToast).not.toHaveBeenCalled()
  })

  // CONTROL — a different size still separates two lines, note or no note. Pins that the
  // fold uses the real line identity and has not been loosened to "same item id".
  it('keeps a different size apart even when the notes are made to match', async () => {
    const regular: CartItem = {
      ...UNNOTED_LINE,
      selected_size: { name: 'Regular', price_modifier: 0 },
      subtotal: 50,
    }
    await renderCartWith([NOTED_LINE, regular])

    await openNoteBox('Cappuccino')
    await typeInto(noteBox(1), 'extra hot')
    await commit(noteBox(1))

    expect(storedCart()).toHaveLength(2)
  })

  // Pins the commit-on-blur decision, not the bug. Merging per keystroke would unmount the
  // textarea mid-word and drop the customer's focus the instant the text happened to match.
  it('does not fold while the customer is still typing', async () => {
    await renderCartWith([NOTED_LINE, UNNOTED_LINE])

    await openNoteBox('Cappuccino')
    await typeInto(noteBox(1), 'extra hot')

    // Text already matches row 0 exactly, but no commit has happened.
    expect(renderedRows()).toBe(2)
    expect(noteBox(1).value).toBe('extra hot')
    expect(storedCart()).toHaveLength(2)
  })
})
