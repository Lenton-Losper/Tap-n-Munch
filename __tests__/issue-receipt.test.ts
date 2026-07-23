import { toLineItem } from '../lib/receipts/issueReceipt'

describe('toLineItem', () => {
  it('reads the real cart item shape (basePrice + subtotal) -- regression for the always-0.00 receipt bug', () => {
    // Exact shape confirmed from production order.items (pos + kiosk channels):
    // basePrice (camelCase) is the per-unit price, subtotal is the already
    // quantity/addon-inclusive line charge. Neither matches unit_price/base_price.
    const item = toLineItem({
      name: 'Rice',
      quantity: 1,
      route_to: 'kitchen',
      subtotal: 25,
      basePrice: 25,
      menuItemId: 'b539d464-7323-41bd-8a10-7a4c507cb6d5',
    })
    expect(item).toEqual({ name: 'Rice', quantity: 1, unit_price: 25, line_total: 25, modifiers: [] })
  })

  it('prefers subtotal (addon/size-inclusive) over quantity * basePrice for line_total', () => {
    const item = toLineItem({
      name: 'Burger',
      quantity: 2,
      basePrice: 50,
      subtotal: 115, // 2 * 50 base + a priced addon, as the cart computes it
    })
    expect(item.unit_price).toBe(50)
    expect(item.line_total).toBe(115)
  })

  it('falls back to quantity * unit_price when no subtotal/lineTotal field is present', () => {
    const item = toLineItem({ name: 'Coke', quantity: 3, unit_price: 15 })
    expect(item).toEqual({ name: 'Coke', quantity: 3, unit_price: 15, line_total: 45, modifiers: [] })
  })

  it('derives unit_price from line_total/quantity when only a total is given', () => {
    const item = toLineItem({ name: 'Combo', quantity: 2, subtotal: 50 })
    expect(item.unit_price).toBe(25)
    expect(item.line_total).toBe(50)
  })

  it('still defaults safely to 0 when neither price field is present or numeric', () => {
    const item = toLineItem({ name: 'Mystery' })
    expect(item).toEqual({ name: 'Mystery', quantity: 1, unit_price: 0, line_total: 0, modifiers: [] })
  })

  it('defaults missing/invalid name and non-positive quantity', () => {
    const item = toLineItem({ quantity: -1, basePrice: 10, subtotal: 10 })
    expect(item.name).toBe('Unknown item')
    expect(item.quantity).toBe(1)
  })
})

  it('extracts size and addon modifiers', () => {
    const item = toLineItem({
      name: 'Burger',
      quantity: 1,
      basePrice: 50,
      subtotal: 60,
      selected_size: { name: 'Large' },
      selected_addons: [{ name: 'Bacon' }, { name: 'Cheese' }],
    })
    expect(item.modifiers).toEqual(['Large', 'Bacon', 'Cheese'])
  })

