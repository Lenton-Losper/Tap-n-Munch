/**
 * #307 — the four rulings of 2026-08-17, each with the failure it prevents.
 *
 *   1. aggregate for display when the SERVER proves identity, configuration and authoritative unit
 *      price are identical; aggregation SUMS stored totals and never recomputes
 *   2. when prices differ, group and show each lot separately with a total; never hide it
 *   3. the cap validates the RESULTING logical-item quantity, not the delta
 *   4. the hard per-line server ceiling stays
 *   5. price lots must NOT reset the ceiling
 */
import {
  capIdentity,
  displayIdentity,
  authoritativeUnitPrice,
  quantityOfLogicalItem,
} from '@/lib/orders/logical-item-identity'
import { aggregateOrderLines } from '@/lib/orders/aggregate-order-lines'
import {
  validateResultingQuantities,
  validateLineQuantity,
  MAX_LINE_QUANTITY,
} from '@/lib/orders/quantity-limits'

const line = (over: Record<string, unknown> = {}) => ({
  menuItemId: 'item-1',
  name: 'Pork Star',
  displayName: 'Pork Star',
  size: null,
  addons: [],
  selectedVariants: {},
  specialInstructions: '',
  quantity: 1,
  unitPrice: 240,
  subtotal: 208.7,
  tax: 31.3,
  total: 240,
  ...over,
})

describe('identity — what is the same logical item', () => {
  it('ignores price for the CAP, or two price lots each get a fresh ceiling', () => {
    // Ruling 5, stated as an equality. This single assertion is the difference between a ceiling
    // and a ceiling per lot.
    expect(capIdentity(line({ unitPrice: 240 }))).toBe(capIdentity(line({ unitPrice: 199 })))
  })

  it('includes price in the DISPLAY, or two prices are averaged behind one row', () => {
    expect(displayIdentity(line({ unitPrice: 240 }))).not.toBe(displayIdentity(line({ unitPrice: 199 })))
  })

  it('treats configuration as identity: size, variants, add-ons, instructions', () => {
    const base = line()
    expect(capIdentity(base)).not.toBe(capIdentity(line({ size: 'Large' })))
    expect(capIdentity(base)).not.toBe(capIdentity(line({ selectedVariants: { spice: 'hot' } })))
    expect(capIdentity(base)).not.toBe(capIdentity(line({ addons: [{ name: 'cheese' }] })))
    // RULED: two differently-worded notes are two preparations, made separately by the kitchen.
    expect(capIdentity(base)).not.toBe(capIdentity(line({ specialInstructions: 'no onions' })))
  })

  it('does not split on ordering or whitespace that means nothing', () => {
    expect(capIdentity(line({ addons: [{ name: 'oat' }, { name: 'shot' }] }))).toBe(
      capIdentity(line({ addons: [{ name: 'shot' }, { name: 'oat' }] })),
    )
    expect(capIdentity(line({ selectedVariants: { a: '1', b: '2' } }))).toBe(
      capIdentity(line({ selectedVariants: { b: '2', a: '1' } })),
    )
    expect(capIdentity(line({ specialInstructions: ' no sugar ' }))).toBe(
      capIdentity(line({ specialInstructions: 'no sugar' })),
    )
  })

  it('does NOT collapse case in instructions — #133 ruled that discards a distinction', () => {
    expect(capIdentity(line({ specialInstructions: 'No nuts' }))).not.toBe(
      capIdentity(line({ specialInstructions: 'no nuts' })),
    )
  })

  it('reads the stored and the cart shape alike', () => {
    expect(capIdentity({ menuItemId: 'x', size: 'Large', addons: [{ name: 'a' }] })).toBe(
      capIdentity({ menu_item_id: 'x', selected_size: { name: 'Large' }, selected_addons: [{ name: 'a' }] }),
    )
  })

  it('takes the authoritative price from the server fields only', () => {
    expect(authoritativeUnitPrice(line({ unitPrice: 240 }))).toBe(240)
    expect(authoritativeUnitPrice({ basePrice: 199 })).toBe(199)
    expect(authoritativeUnitPrice({})).toBeNull()
  })
})

describe('aggregation — ruling 1: sum, never recompute', () => {
  it('merges lots that agree on identity, configuration and price', () => {
    const groups = aggregateOrderLines([line(), line()])
    expect(groups).toHaveLength(1)
    expect(groups[0].rows).toHaveLength(1)
    expect(groups[0].quantity).toBe(2)
    expect(groups[0].hasMixedPrices).toBe(false)
    expect(groups[0].rows[0].lots).toHaveLength(2) // storage lots preserved
  })

  /**
   * THE ADDITION TO THE RULING, and the assertion that enforces it.
   *
   * The lots' stored totals are deliberately made INCONSISTENT with quantity x unitPrice. A summing
   * implementation returns 250; a recomputing one returns 480. Only the summed figure is what the
   * customer was actually charged.
   */
  it('SUMS the stored totals — a recomputed figure would be a different number', () => {
    const groups = aggregateOrderLines([
      line({ quantity: 1, unitPrice: 240, subtotal: 100, tax: 10, total: 110 }),
      line({ quantity: 1, unitPrice: 240, subtotal: 130, tax: 10, total: 140 }),
    ])
    expect(groups[0].total).toBe(250) // 110 + 140
    expect(groups[0].subtotal).toBe(230)
    expect(groups[0].tax).toBe(20)
    expect(groups[0].total).not.toBe(2 * 240) // what recomputation would have produced
  })

  it('sums in cents, so three thirds do not drift a cent', () => {
    const g = aggregateOrderLines([
      line({ total: 8.33, subtotal: 8.33, tax: 0 }),
      line({ total: 8.33, subtotal: 8.33, tax: 0 }),
      line({ total: 8.34, subtotal: 8.34, tax: 0 }),
    ])
    expect(g[0].total).toBe(25)
  })
})

describe('aggregation — ruling 2: a price difference is shown, never hidden', () => {
  it('keeps differing prices as separate rows under one product group', () => {
    const groups = aggregateOrderLines([
      line({ unitPrice: 240, total: 240 }),
      line({ unitPrice: 199, total: 199 }),
    ])
    expect(groups).toHaveLength(1) // one product
    expect(groups[0].rows).toHaveLength(2) // two lots, shown separately
    expect(groups[0].hasMixedPrices).toBe(true)
    expect(groups[0].rows.map((r) => r.unitPrice).sort()).toEqual([199, 240])
    expect(groups[0].total).toBe(439) // and a total across them
  })

  it('never averages: no row carries a price no lot was charged', () => {
    const groups = aggregateOrderLines([line({ unitPrice: 240 }), line({ unitPrice: 200 })])
    for (const row of groups[0].rows) {
      expect([240, 200]).toContain(row.unitPrice)
    }
    expect(groups[0].rows.map((r) => r.unitPrice)).not.toContain(220) // the average
  })
})

describe('the cap — rulings 3, 4 and 5', () => {
  it('RULING 3: caps the resulting quantity, not the delta', () => {
    const existing = [line({ quantity: 12 })]
    // 12 + 12 = 24. Each is individually legal; the sum is not. This is the measured defect.
    const r = validateResultingQuantities(existing, [line({ quantity: 12 })])
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.refusal.resulting).toBe(24)
    expect(r.refusal.existing).toBe(12)
  })

  it('RULING 3: the refusal states the maximum AND how many more they may add', () => {
    const r = validateResultingQuantities([line({ quantity: 18 })], [line({ quantity: 5 })])
    if (r.ok) throw new Error('expected a refusal')
    expect(r.refusal.maximum).toBe(MAX_LINE_QUANTITY)
    expect(r.refusal.remaining).toBe(2)
    expect(r.refusal.itemName).toBe('Pork Star')
  })

  it('RULING 5: price lots do NOT reset the ceiling', () => {
    // Two lots at different prices. If price were part of cap identity each would see a fresh 20.
    const existing = [line({ quantity: 12, unitPrice: 240 })]
    const r = validateResultingQuantities(existing, [line({ quantity: 12, unitPrice: 199 })])
    expect(r.ok).toBe(false)
  })

  it('sums several additions of the same item within ONE save', () => {
    // Otherwise the split-across-calls defect reappears inside a single request.
    const r = validateResultingQuantities([], [line({ quantity: 11 }), line({ quantity: 11 })])
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.refusal.resulting).toBe(22)
  })

  it('allows what fits, and different configurations keep their own ceilings', () => {
    expect(validateResultingQuantities([line({ quantity: 18 })], [line({ quantity: 2 })]).ok).toBe(true)
    expect(
      validateResultingQuantities([line({ quantity: 20 })], [line({ quantity: 20, size: 'Large' })]).ok,
    ).toBe(true)
  })

  it('RULING 4: the hard per-line ceiling still refuses on its own', () => {
    // Unchanged by any of the above, and still the thing that stops a single malformed line.
    expect(validateLineQuantity(MAX_LINE_QUANTITY + 1).ok).toBe(false)
    expect(validateLineQuantity(2.5).ok).toBe(false)
    expect(validateLineQuantity(0).ok).toBe(false)
    expect(validateLineQuantity(MAX_LINE_QUANTITY).ok).toBe(true)
  })
})

describe('quantityOfLogicalItem', () => {
  it('sums across every lot of the same logical item, whatever the price', () => {
    const id = capIdentity(line())
    expect(
      quantityOfLogicalItem(
        [line({ quantity: 3, unitPrice: 240 }), line({ quantity: 4, unitPrice: 199 }), line({ quantity: 5, size: 'Large' })],
        id,
      ),
    ).toBe(7)
  })
})
