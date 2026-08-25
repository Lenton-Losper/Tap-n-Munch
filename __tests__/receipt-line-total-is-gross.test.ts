/**
 * #250 / #165 — THE RECEIPT'S LINE TOTAL IS THE GROSS FIGURE.
 *
 * Ruled by the owner 2026-08-16, closing #165 as a duplicate of #250: *"make the receipt's
 * `line_total` gross."* #250 established which of the two documents was already right — the TAX
 * INVOICE stores `line_total: round2(quantity * unit_price)`, the gross amount
 * (`lib/documents/create-document.ts:73`), and keeps the ex-VAT split beside it as
 * `line_subtotal` / `line_tax`. The receipt was the odd one out.
 *
 * THE CUSTOMER HARM, printed from the Finatic-UAT P5 on 2026-08-05 and carried onto #250:
 *
 *     Chicken burger
 *       1 x N$25.00                    N$21.74
 *     Coke
 *       1 x N$15.56                    N$13.53
 *
 * A gross unit price beside an ex-VAT line total. It reads as an arithmetic error, on paper, to
 * someone who has just paid.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `__tests__/issue-receipt.test.ts`. Every case in that file
 * uses the CART shape, which has no `total` key — so all of them pass both before and after this
 * change, by falling through to `subtotal`. They cannot see this defect, and keeping them green is
 * itself a requirement (they pin the always-0.00 regression). This file supplies the shape they do
 * not: a SERVER-PRICED line, which is what `calculate-order-pricing` actually writes to
 * `orders.items` and therefore what a real receipt is built from.
 */
import { toLineItem } from '../lib/receipts/issueReceipt'

/**
 * Exactly what `lib/orders/calculate-order-pricing.ts:192-198` returns per line, for a N$25.00
 * menu item under an INCLUSIVE 15% rate:
 *
 *   subtotal: applied.subtotal   21.74  <- ex-VAT
 *   tax:      applied.tax         3.26
 *   total:    applied.total      25.00  <- gross, and what the customer paid
 *   unitPrice: round2(unitPrice) 25.00  <- gross menu price
 */
function serverPricedLine(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Chicken burger',
    quantity: 1,
    unitPrice: 25,
    subtotal: 21.74,
    tax: 3.26,
    total: 25,
    taxRatePercentage: 15,
    taxInclusive: true,
    ...overrides,
  }
}

describe('#250: a receipt line total is gross', () => {
  it('takes the GROSS total, not the ex-VAT subtotal, for a server-priced line', () => {
    const item = toLineItem(serverPricedLine())

    // The defect: this was 21.74, beside a unit_price of 25.00.
    expect(item.line_total).toBe(25)
    expect(item.unit_price).toBe(25)
  })

  it('makes unit_price x quantity agree with line_total — the arithmetic the customer checks', () => {
    const item = toLineItem(serverPricedLine({ quantity: 2, unitPrice: 25, subtotal: 43.48, tax: 6.52, total: 50 }))

    expect(item.line_total).toBe(50)
    expect(item.unit_price * item.quantity).toBe(item.line_total)
  })

  it('reproduces the second printed line from the P5 receipt', () => {
    // Coke at N$15.56 gross, 15% inclusive -> 13.53 ex-VAT. The receipt printed 13.53.
    const item = toLineItem(serverPricedLine({ name: 'Coke', unitPrice: 15.56, subtotal: 13.53, tax: 2.03, total: 15.56 }))

    expect(item.line_total).toBe(15.56)
  })

  /**
   * THE FALLBACK MUST SURVIVE. A cart-shaped line has no `total`, and there `subtotal` is the
   * already quantity-and-addon-inclusive charge — gross already. Deleting the `subtotal` fallback
   * instead of demoting it would regress every one of these to 0, which is the always-0.00 bug
   * `__tests__/issue-receipt.test.ts` exists to pin.
   */
  it('CONTROL: a cart-shaped line with no `total` still reads its gross subtotal', () => {
    const item = toLineItem({ name: 'Burger', quantity: 2, basePrice: 50, subtotal: 115 })

    expect(item.line_total).toBe(115)
    expect(item.unit_price).toBe(50)
  })

  /**
   * Guards the ordering specifically. If someone restores `subtotal` to the front of the chain,
   * the two keys disagree here and this fails while the cart cases above stay green — which is
   * the signature that tells the two shapes apart.
   */
  it('prefers `total` over `subtotal` when a line carries BOTH', () => {
    const item = toLineItem({ name: 'Both', quantity: 1, subtotal: 21.74, total: 25 })

    expect(item.line_total).toBe(25)
  })
})
