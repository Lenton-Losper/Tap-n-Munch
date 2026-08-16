/**
 * #295 -- EVERY customer-facing per-line price shows what the customer pays.
 *
 * #293 fixed the shared Tab and stopped there. The rename it relied on enumerated consumers of
 * ONE type (`TabGroupLine`), so the compiler pointed at two render sites and no further -- and
 * the order-confirmation screen, which reaches its lines through a different type entirely, kept
 * showing "1x Chicken burger NAD 21.74" above "TOTAL 25.00" with N$25 on the menu.
 *
 * A type-driven audit answers "who uses this type", not "who renders a line price". This file
 * asserts the second question directly, by name, so a new surface has to be classified rather
 * than quietly inheriting the wrong figure.
 *
 * THE CENSUS -- every per-line money render in a customer surface, and what each shows:
 *
 *   components/receipt/order-summary.tsx      order confirmation   chargedLineAmount  FIXED here
 *   app/menu/[id]/receipt/page.tsx            tab receipt          chargedLineAmount  FIXED here
 *   app/menu/[id]/tab/page.tsx  x2            shared tab           line.total         #293
 *   app/menu/[id]/cart/page.tsx               cart                 item.subtotal      CORRECT
 *   app/menu/[id]/order-secure/page.tsx       secure checkout      item.subtotal      CORRECT
 *   app/menu/[id]/my-orders/page.tsx          my orders            -- no line price at all
 *
 * The two marked CORRECT are client-side cart lines, whose `subtotal` is menu price x quantity
 * and is already tax-inclusive -- they never touch a stored order row. Asserted below, because
 * "correct for a different reason" is exactly the kind of thing that stops being true quietly.
 */
import fs from 'fs'
import path from 'path'
import { chargedLineAmount, type ReceiptLineItem } from '@/components/receipt/receipt-types'

/** Normalised to LF: this repo checks out CRLF on Windows. */
const read = (...p: string[]) =>
  fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n')

describe('#295 chargedLineAmount', () => {
  const inclusive: ReceiptLineItem = {
    name: 'Chicken burger',
    quantity: 1,
    subtotal: 21.74,
    tax: 3.26,
    total: 25,
  }

  it('returns what the customer pays, not the ex-VAT base', () => {
    expect(chargedLineAmount(inclusive)).toBe(25)
    // The exact figure the click test found on screen.
    expect(chargedLineAmount(inclusive)).not.toBe(21.74)
  })

  it('an exclusive-rate line is also its total', () => {
    expect(chargedLineAmount({ name: 'Water', quantity: 1, subtotal: 20, tax: 3, total: 23 })).toBe(23)
  })

  it('an old row with no total is reconstructed from subtotal + tax', () => {
    // Falling back to `subtotal` alone would leave exactly the oldest orders wrong.
    expect(chargedLineAmount({ name: 'Old', quantity: 1, subtotal: 82.61, tax: 12.39 })).toBe(95)
  })

  it('a row with neither total nor tax falls back to the subtotal, not to zero', () => {
    expect(chargedLineAmount({ name: 'Ancient', quantity: 1, subtotal: 40 })).toBe(40)
  })

  it('a zero or nonsense total does not win over a usable subtotal', () => {
    expect(chargedLineAmount({ name: 'X', quantity: 1, subtotal: 20, tax: 3, total: 0 })).toBe(23)
    expect(chargedLineAmount({ name: 'X', quantity: 1, subtotal: 20, tax: 3, total: NaN })).toBe(23)
  })
})

describe('#295 the render sites', () => {
  it('order confirmation renders the charged amount', () => {
    const summary = read('components', 'receipt', 'order-summary.tsx')
    expect(summary).toContain('formatCurrency(chargedLineAmount(item), currency)')
    expect(summary).not.toContain('formatCurrency(item.subtotal, currency)')
  })

  it('the Subtotal ROW still sums the ex-tax bases, because that is what Subtotal means', () => {
    // The line and the Subtotal row answer different questions. Making both inclusive would be a
    // different defect: a "Subtotal" that already contains VAT, sitting above a "VAT" line.
    const summary = read('components', 'receipt', 'order-summary.tsx')
    expect(summary).toContain('items.reduce((sum, item) => sum + (Number(item.subtotal) || 0), 0)')
  })

  it('the confirmation mapper carries total and tax through to the view', () => {
    // Without this the view has nothing but `subtotal` to render, and the fix above is inert.
    const page = read('app', 'menu', '[restaurantId]', 'order-confirmation', '[orderId]', 'page.tsx')
    expect(page).toMatch(/total\?: number/)
    expect(page).toMatch(/tax\?: number/)
  })

  it('the tab receipt renders the charged amount', () => {
    const receipt = read('app', 'menu', '[restaurantId]', 'receipt', 'page.tsx')
    expect(receipt).toContain('chargedLineAmount(item).toFixed(2)')
    expect(receipt).not.toContain('{((item?.subtotal || 0)).toFixed(2)}')
  })

  it('the shared tab still renders line.total (#293 stays fixed)', () => {
    const tab = read('app', 'menu', '[restaurantId]', 'tab', 'page.tsx')
    expect((tab.match(/\{line\.total\.toFixed\(2\)\}/g) ?? []).length).toBe(2)
    expect(tab).not.toContain('{line.subtotal.toFixed(2)}')
  })

  it('cart and order-secure keep using their own already-inclusive line subtotal', () => {
    // These are CART lines, not stored order rows: subtotal is menu price x quantity, and the
    // menu price is tax-inclusive. Repointing them at a `total` they do not have would render
    // zero. Asserted so the reason survives the next sweep.
    const cart = read('app', 'menu', '[restaurantId]', 'cart', 'page.tsx')
    const secure = read('app', 'menu', '[restaurantId]', 'order-secure', 'page.tsx')
    expect(cart).toContain('{item.subtotal.toFixed(2)}')
    expect(secure).toContain('{(Number(item.subtotal) || 0).toFixed(2)}')
  })

  it('my-orders still renders no per-line price at all', () => {
    const mine = read('app', 'menu', '[restaurantId]', 'my-orders', 'page.tsx')
    expect(mine).not.toMatch(/item\??\.(subtotal|total)/)
  })
})
