/**
 * @jest-environment jsdom
 *
 * The per-line quantity cap on the ADD path.
 *
 * MAX_LINE_QUANTITY is enforced by the server for customer channels
 * (app/api/orders/route.ts:57-62, via validateOrderQuantities). Every UI path that can build a
 * cart line therefore has to stop the customer reaching a quantity the server will refuse --
 * otherwise the refusal arrives at Place Order, after the customer has finished choosing, and
 * names a limit no screen ever showed them.
 *
 * The EDIT path already does this, and lib/cart/cart-lines.ts states why it belongs in the
 * shared function rather than in each caller (#126, applyCartLineEdit):
 *
 *   "a shared function does not trust its callers to have applied it, and a caller added
 *    later inherits the cap instead of having to remember it"
 *
 * The ADD path does not. `CartProvider.addItem` takes the caller's quantity and stores it
 * verbatim. The cap lives entirely in the two callers' own invariants -- ItemDetailModal's +
 * control stops at MAX_LINE_QUANTITY, and browse/page.tsx's quick-add hardcodes 1 -- so a
 * third caller, or a change to either of those two, silently reintroduces an over-cap line.
 *
 * That is not hypothetical. On `main` (21d5133) `addItem` was given line merging by #133:
 *
 *     quantity: existing.quantity + item.quantity     // contexts/cart-context.tsx:85
 *
 * with no cap, so 21 taps of quick-add build one 21-quantity line that the UI displays
 * happily and the server refuses at submit. #133 was written as though #126's cap ruling did
 * not exist -- and main carries BOTH files, so the ruling and the violation sit side by side
 * in the same tree.
 *
 * These tests pin the INVARIANT ("no line in the cart exceeds the cap"), not the mechanism,
 * so they stay meaningful when that merge is cherry-picked onto this branch: a merge added to
 * `addItem` without honouring the cap turns this suite red rather than shipping.
 *
 * On THIS branch the hole is latent, not live: no current caller passes a quantity above the
 * cap. The trigger is any caller that does -- which #133's merge makes routine.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('@/lib/session', () => ({
  getCurrentSession: () => 'sess_test',
  getOrCreateSession: () => 'sess_test',
  getSessionInfo: () => ({ table: '4', restaurant: 'riviera' }),
}))

import { CartProvider, useCart, type CartItem } from '@/contexts/cart-context'
import { capCartLine } from '@/lib/cart/cart-lines'
import { MAX_LINE_QUANTITY } from '@/lib/orders/quantity-limits'

/** A line as browse/page.tsx and ItemDetailModal build them: N$20 a unit. */
function line(quantity: number, overrides: Partial<CartItem> = {}): CartItem {
  return {
    menu_item_id: 'item-1',
    name: 'Americano',
    quantity,
    base_price: 20,
    selected_size: null,
    selected_addons: [],
    special_instructions: '',
    subtotal: 20 * quantity,
    ...overrides,
  }
}

/**
 * Drives the real CartProvider. `addItem` is only reachable through the context, so the
 * invariant is asserted where the callers actually stand rather than against an internal.
 */
function mountCart() {
  let api: ReturnType<typeof useCart> | null = null

  function Probe() {
    api = useCart()
    return null
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = null

  act(() => {
    root = createRoot(container)
    root.render(
      <CartProvider>
        <Probe />
      </CartProvider>,
    )
  })

  return {
    add(item: CartItem) {
      let result: { clamped: boolean } | undefined
      act(() => {
        result = api!.addItem(item)
      })
      return result
    },
    get items() {
      return api!.items
    },
    unmount() {
      act(() => {
        root!.unmount()
      })
      container.remove()
    },
  }
}

describe('CartProvider.addItem — the per-line cap', () => {
  let cart: ReturnType<typeof mountCart>

  beforeEach(() => {
    ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
    localStorage.clear()
    cart = mountCart()
  })

  afterEach(() => {
    cart.unmount()
    localStorage.clear()
  })

  // Positive controls. A suite that only asserted the cap would pass just as happily against
  // an addItem that dropped every line on the floor.
  it('adds an ordinary line unchanged', () => {
    cart.add(line(3))
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].quantity).toBe(3)
    expect(cart.items[0].subtotal).toBe(60)
  })

  it('leaves a line at exactly the maximum alone', () => {
    cart.add(line(MAX_LINE_QUANTITY))
    expect(cart.items[0].quantity).toBe(MAX_LINE_QUANTITY)
    expect(cart.items[0].subtotal).toBe(20 * MAX_LINE_QUANTITY)
  })

  it('keeps two genuinely different lines separate', () => {
    cart.add(line(2))
    cart.add(line(2, { menu_item_id: 'item-2', name: 'Latte' }))
    expect(cart.items).toHaveLength(2)
  })

  // The defect.
  it('never stores a line above the per-line maximum the server will accept', () => {
    cart.add(line(MAX_LINE_QUANTITY + 5))

    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].quantity).toBe(MAX_LINE_QUANTITY)
  })

  it('reprices a capped line so the subtotal cannot charge for units that are not there', () => {
    cart.add(line(MAX_LINE_QUANTITY + 5))

    // 25 units at N$20 came in as N$500; 20 units must read N$400, not N$500.
    expect(cart.items[0].subtotal).toBe(20 * MAX_LINE_QUANTITY)
  })

  it('caps every line independently, and does not clamp a total across lines', () => {
    // Two separate lines of 15 are legitimately 30 units: the cap is per line, and the server
    // validates each line on its own terms (#126 -- clamping the SUM silently destroyed
    // paid-for units, and that is explicitly not what this cap does).
    cart.add(line(15))
    cart.add(line(15, { menu_item_id: 'item-2', name: 'Latte' }))

    expect(cart.items.map((i) => i.quantity)).toEqual([15, 15])
  })

  it('tells the caller whether it had to cap, so the customer can be told', () => {
    expect(cart.add(line(MAX_LINE_QUANTITY))).toEqual({ clamped: false })
    expect(cart.add(line(MAX_LINE_QUANTITY + 1))).toEqual({ clamped: true })
  })
})

describe('capCartLine — the cap itself', () => {
  it('passes an under-cap line through untouched, by identity', () => {
    const under = line(4)
    const result = capCartLine(under)

    // Same object, not a copy: "did not need capping" should not churn the line.
    expect(result.line).toBe(under)
    expect(result.clamped).toBe(false)
  })

  it('caps and reprices from the line own unit price, not from base_price', () => {
    // A variant line carries a variant-resolved unit price that base_price does not describe
    // (#126). Repricing from base_price here would undo that.
    const variantLine = line(MAX_LINE_QUANTITY + 5, {
      base_price: 20,
      display_name: 'Still Water - 1L',
      selected_variants: { Size: '1L' },
      subtotal: 30 * (MAX_LINE_QUANTITY + 5), // N$30 a unit, not N$20
    })

    const { line: capped, clamped } = capCartLine(variantLine)

    expect(clamped).toBe(true)
    expect(capped.quantity).toBe(MAX_LINE_QUANTITY)
    expect(capped.subtotal).toBe(30 * MAX_LINE_QUANTITY)
    expect(capped.selected_variants).toEqual({ Size: '1L' })
    expect(capped.display_name).toBe('Still Water - 1L')
  })

  it('rounds a capped subtotal to cents', () => {
    const awkward = line(MAX_LINE_QUANTITY + 3, { subtotal: 33.33 * (MAX_LINE_QUANTITY + 3) })
    expect(capCartLine(awkward).line.subtotal).toBe(666.6)
  })

  it('only ever caps downward', () => {
    expect(capCartLine(line(1)).line.quantity).toBe(1)
    expect(capCartLine(line(MAX_LINE_QUANTITY)).line.quantity).toBe(MAX_LINE_QUANTITY)
  })
})
