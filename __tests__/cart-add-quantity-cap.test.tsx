/**
 * @jest-environment jsdom
 *
 * The per-line quantity cap on the ADD path — the incoming line's OWN quantity.
 *
 * MAX_LINE_QUANTITY is enforced by the server for customer channels
 * (app/api/orders/route.ts:57-62, via validateOrderQuantities), which rejects the WHOLE order
 * when any single line exceeds it. Every UI path that can build a line therefore has to stop
 * the customer reaching a quantity the server will refuse.
 *
 * TWO DISTINCT CASES, and they resolve in opposite directions. Both already have rulings:
 *
 *   a FOLD that would take a merged line past the cap  -> REFUSE, leave two lines
 *   a single line whose OWN quantity exceeds the cap   -> CLAMP down and reprice
 *
 * The first is #126 (lib/cart/cart-lines.ts, "THE CAP APPLIES PER LINE, NOT ACROSS MATCHING
 * LINES") and #133 (findMergeableLineIndex skips an over-cap candidate rather than clamping
 * the sum). Clamping a SUM silently destroys units the customer already had. That case is
 * correct in this tree and is pinned by cart-line-merge.test.tsx:249. The tests below re-assert
 * it only so that closing the second case cannot quietly break the first.
 *
 * The second is applyCartLineEdit's `clamped` path, which caps an over-cap edited line and
 * reprices it. The ADD path has no equivalent: `CartProvider.addItem` takes the caller's
 * quantity and stores it verbatim. `findMergeableLineIndex` guards the fold, not the incoming
 * line, so an over-cap line simply appends — capping is nobody's job on this path.
 *
 * Latent, not live: neither current caller can pass an over-cap quantity (ItemDetailModal's +
 * control stops at MAX_LINE_QUANTITY; browse/page.tsx's quick-add hardcodes 1). The trigger is
 * any caller that does. The cap belongs in the cart rather than in each caller's own
 * invariant — the argument lib/cart/cart-lines.ts already makes for the edit path:
 *
 *   "a shared function does not trust its callers to have applied it, and a caller added
 *    later inherits the cap instead of having to remember it"
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
 * Drives the real CartProvider. addItem is only reachable through the context, so the
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

describe('CartProvider.addItem — the incoming line own quantity', () => {
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

  it('still merges two identical adds (#133)', () => {
    cart.add(line(2))
    cart.add(line(2))
    expect(cart.items).toHaveLength(1)
    expect(cart.items[0].quantity).toBe(4)
  })

  // The gap.
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

  it('caps an over-cap add that arrives alongside a line it cannot fold into', () => {
    cart.add(line(5))
    cart.add(line(MAX_LINE_QUANTITY + 5))

    // 5 + 20 still exceeds the cap, so the fold is refused and the line appends -- but it
    // appends CAPPED, not at the 25 the caller asked for.
    expect(cart.items.map((i) => i.quantity)).toEqual([5, MAX_LINE_QUANTITY])
  })

  it('tells the caller whether it had to cap, so the customer can be told', () => {
    expect(cart.add(line(MAX_LINE_QUANTITY))).toEqual({ clamped: false })
    expect(cart.add(line(MAX_LINE_QUANTITY + 1))).toEqual({ clamped: true })
  })

  /*
   * The OTHER case, asserted here so that fixing the one above cannot break it. The fold
   * refusal is #133's and is already correct in this tree (findMergeableLineIndex skips an
   * over-cap candidate); cart-line-merge.test.tsx:249 is its home. Duplicated deliberately:
   * a change to addItem is exactly what would regress it.
   */
  it('still REFUSES a fold past the cap rather than clamping the sum (#126/#133)', () => {
    cart.add(line(MAX_LINE_QUANTITY))
    cart.add(line(1))

    expect(cart.items).toHaveLength(2)
    expect(cart.items.map((i) => i.quantity)).toEqual([MAX_LINE_QUANTITY, 1])
    // Neither line lost units: 20 + 1, not a single line clamped back to 20.
    expect(cart.items.reduce((n, i) => n + i.quantity, 0)).toBe(MAX_LINE_QUANTITY + 1)
  })

  it('still folds into a line that has room', () => {
    cart.add(line(MAX_LINE_QUANTITY))
    cart.add(line(1))
    cart.add(line(1))

    expect(cart.items).toHaveLength(2)
    expect(cart.items[1].quantity).toBe(2)
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
