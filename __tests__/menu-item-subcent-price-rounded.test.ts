/**
 * A sub-cent price submitted DIRECTLY to the admin API must be stored rounded.
 *
 * WHY THIS IS THE PATH THAT MATTERS. The menu form sends `step="0.01"`, which is a browser hint
 * and not a server constraint. `app/api/admin/menu/items/route.ts` spreads the raw request body
 * into `buildMenuItemDbPayload`, and `menu_items.base_price` is `numeric` with NO scale
 * (baseline.sql:387) while sizes and addons are unconstrained jsonb. So the only thing standing
 * between a client and a sub-cent price is this builder.
 *
 * WHAT A SUB-CENT PRICE DOES. Unit prices are DISPLAYED rounded but lines are computed from the
 * raw value (calculate-order-pricing.ts:116 vs :120), so 10.005 at quantity 4 prints
 *
 *     4 x N$10.01 ......... N$40.02
 *
 * and the customer multiplies to 40.04. The total is internally consistent -- what is charged is
 * the raw computation -- so this is not an over- or under-charge. It breaks the one arithmetic
 * check a customer can perform on a document we ask them to check.
 *
 * Ruled: round at WRITE (Q1:A). Rounding before multiplying would change what is CHARGED to fix
 * a DISPLAY problem; rounding only the printed line leaves the arithmetic inconsistent, just less
 * visibly.
 *
 * Asserted against the SHIPPED builder, imported rather than restated. The route is covered by
 * reading and tsc -- it cannot be loaded under ts-jest because it imports the admin auth chain.
 */
import { buildMenuItemDbPayload } from '../lib/menu-item-db-payload'

describe('sub-cent prices are rounded at write', () => {
  it('rounds base_price submitted with sub-cent precision', () => {
    // The exact figure from the finding: 4 x 10.005 printed 40.02 against a computed 40.04.
    expect(buildMenuItemDbPayload({ base_price: 10.005 }).base_price).toBe(10.01)
  })

  it('rounds a base_price arriving as a STRING, which is what raw JSON gives', () => {
    expect(buildMenuItemDbPayload({ base_price: '10.004' }).base_price).toBe(10)
  })

  it('leaves an already-clean price exactly alone', () => {
    // Two-sided: without this, "rounds" would also pass if it mangled every price.
    expect(buildMenuItemDbPayload({ base_price: 95 }).base_price).toBe(95)
    expect(buildMenuItemDbPayload({ base_price: 78.35 }).base_price).toBe(78.35)
  })

  it('rounds a size price_modifier — the same defect through a different door', () => {
    const payload = buildMenuItemDbPayload({
      sizes: [
        { name: 'Regular', price_modifier: 0 },
        { name: 'Large', price_modifier: 12.006 },
      ],
    })

    expect(payload.sizes).toEqual([
      { name: 'Regular', price_modifier: 0 },
      { name: 'Large', price_modifier: 12.01 },
    ])
  })

  it('rounds an addon price, and preserves every other key on the entry', () => {
    const payload = buildMenuItemDbPayload({
      addons: [{ name: 'Bacon', price: 20.001, sku: 'BAC-1', available: true }],
    })

    expect(payload.addons).toEqual([
      { name: 'Bacon', price: 20, sku: 'BAC-1', available: true },
    ])
  })

  it('does not invent a price where the entry has none', () => {
    const payload = buildMenuItemDbPayload({ addons: [{ name: 'Napkin' }] })

    expect(payload.addons).toEqual([{ name: 'Napkin' }])
    expect('price' in (payload.addons as Array<Record<string, unknown>>)[0]).toBe(false)
  })

  it('passes a malformed list through rather than coercing it', () => {
    // This builder is not the place to decide what a broken size list means, and turning one
    // into [] here would silently delete a merchant's sizes.
    expect(buildMenuItemDbPayload({ sizes: 'not-an-array' }).sizes).toBe('not-an-array')
    expect(buildMenuItemDbPayload({ addons: [null] }).addons).toEqual([null])
  })

  it('passes a non-finite price through unchanged rather than storing NaN', () => {
    // A caller already holding a bad number gets the same bad number, not a second failure mode.
    expect(Number.isNaN(buildMenuItemDbPayload({ base_price: 'abc' }).base_price)).toBe(true)
  })

  it('OMISSION still means no-op — the #106 guard is not weakened', () => {
    // buildMenuItemDbPayload writes a column only when its key is present. That is what makes
    // the menu form's partial updates safe, and rounding must not have introduced a default.
    const payload = buildMenuItemDbPayload({ name: 'Flat White' })

    expect('base_price' in payload).toBe(false)
    expect('sizes' in payload).toBe(false)
    expect('addons' in payload).toBe(false)
  })
})
