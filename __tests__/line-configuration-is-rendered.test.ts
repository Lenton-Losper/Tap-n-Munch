/**
 * #298 -- every customer-facing line render shows what the customer configured.
 *
 * #297 proved that two "Beef Burger" lines at N$130 and N$107 were one item in two
 * configurations: 95 + `Extra patty` 35, and 95 + `Cheese` 12. The prices were correct. Every
 * surface but the cart rendered the item NAME alone, so it read as FlashTap charging two prices
 * for the same burger.
 *
 * The census below is by NAME, not by what a type happens to reach — the mistake #293 made and
 * #295 had to correct. A type-driven audit answers "who consumes this type"; this answers "who
 * renders a line".
 */
import fs from 'fs'
import path from 'path'
import { lineConfigurationSummary } from '@/lib/orders/line-configuration'

/** Normalised to LF: this repo checks out CRLF on Windows. */
const read = (...p: string[]) =>
  fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n')

/** Assertions are about CODE, not the comments explaining it. */
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('#298 lineConfigurationSummary', () => {
  it('the exact pair from #297 becomes distinguishable', () => {
    const extraPatty = { size: null, addons: [{ name: 'Extra patty', price: 35 }], selectedVariants: {} }
    const cheese = { size: null, addons: [{ name: 'Cheese', price: 12 }], selectedVariants: {} }
    expect(lineConfigurationSummary(extraPatty)).toBe('Extra patty')
    expect(lineConfigurationSummary(cheese)).toBe('Cheese')
    expect(lineConfigurationSummary(extraPatty)).not.toBe(lineConfigurationSummary(cheese))
  })

  it('a plain line says nothing at all', () => {
    // Empty string, not a placeholder: a word on every plain item is noise.
    expect(lineConfigurationSummary({ size: null, addons: [], selectedVariants: {} })).toBe('')
    expect(lineConfigurationSummary({})).toBe('')
    expect(lineConfigurationSummary(null)).toBe('')
    expect(lineConfigurationSummary(undefined)).toBe('')
  })

  it('reads the STORED shape and the CART shape', () => {
    expect(lineConfigurationSummary({ size: 'Large', addons: [{ name: 'Cheese' }] })).toBe(
      'Large · Cheese',
    )
    expect(
      lineConfigurationSummary({
        selected_size: { name: 'Large', price_modifier: 5 },
        selected_addons: [{ name: 'Cheese', price: 12 }],
      }),
    ).toBe('Large · Cheese')
  })

  it('renders variant VALUES, not the group names that asked for them', () => {
    // {"Milk": "Oat"} reads as "Oat". The group is the question, the value is the answer.
    expect(lineConfigurationSummary({ selectedVariants: { Milk: 'Oat' } })).toBe('Oat')
    expect(
      lineConfigurationSummary({ selectedVariants: { Extras: ['Syrup', 'Cream'] } }),
    ).toBe('Syrup · Cream')
  })

  it('order is size, then variants, then add-ons', () => {
    expect(
      lineConfigurationSummary({
        size: 'Large',
        selectedVariants: { Milk: 'Oat' },
        addons: [{ name: 'Cheese' }],
      }),
    ).toBe('Large · Oat · Cheese')
  })

  it('de-duplicates a value that appears twice', () => {
    expect(
      lineConfigurationSummary({ size: 'Large', selectedVariants: { Size: 'Large' } }),
    ).toBe('Large')
  })

  it('survives junk without throwing', () => {
    for (const junk of [{ addons: 'nonsense' }, { addons: [null, 7, {}] }, { selectedVariants: [] }]) {
      expect(() => lineConfigurationSummary(junk as never)).not.toThrow()
      expect(lineConfigurationSummary(junk as never)).toBe('')
    }
  })
})

/**
 * The census. Each entry names a real customer-facing line render and asserts it consults the
 * shared rule. Adding a seventh surface means adding a row here, not inheriting silence.
 */
describe('#298 the census: every customer-facing line render', () => {
  const SURFACES: Array<[string, string[]]> = [
    ['order confirmation', ['components', 'receipt', 'order-summary.tsx']],
    ['tab receipt', ['app', 'menu', '[restaurantId]', 'receipt', 'page.tsx']],
    ['secure checkout', ['app', 'menu', '[restaurantId]', 'order-secure', 'page.tsx']],
    ['my orders', ['app', 'menu', '[restaurantId]', 'my-orders', 'page.tsx']],
    ['the order editor', ['components', 'order-edit-panel.tsx']],
    ['the cart', ['app', 'menu', '[restaurantId]', 'cart', 'page.tsx']],
  ]

  it.each(SURFACES)('%s renders the configuration', (_label, segments) => {
    const src = codeOnly(read(...segments))
    expect(src).toContain("from '@/lib/orders/line-configuration'")
    expect(src).toMatch(/lineConfigurationSummary\(/)
  })

  it('the shared tab CARRIES it from the server and renders it', () => {
    // The tab list is grouped server-side, so the payload has to include it or the client has
    // nothing to draw. Both halves, or the fix is inert on this surface.
    const grouping = codeOnly(read('lib', 'tabs', 'tab-order-groups.ts'))
    expect(grouping).toMatch(/configuration: lineConfigurationSummary\(item\)/)
    expect(grouping).toMatch(/configuration: string/)

    const tab = codeOnly(read('app', 'menu', '[restaurantId]', 'tab', 'page.tsx'))
    expect(tab).toMatch(/line\.configuration/)
  })

  it('the confirmation mapper carries size, addons and variants through', () => {
    // Without this the view has only `name` to render and the fix is inert there too.
    const page = codeOnly(
      read('app', 'menu', '[restaurantId]', 'order-confirmation', '[orderId]', 'page.tsx'),
    )
    for (const field of ['size?: unknown', 'addons?: unknown', 'selectedVariants?: unknown']) {
      expect(page).toContain(field)
    }
  })

  it('the cart does not print size or add-ons twice', () => {
    // It already draws them in its own signed-off labelled style. The shared rule is asked only
    // for the variants it was dropping.
    const cart = codeOnly(read('app', 'menu', '[restaurantId]', 'cart', 'page.tsx'))
    expect(cart).toMatch(/lineConfigurationSummary\(\{ selected_variants: item\.selected_variants \}\)/)
    expect(cart).toContain('Add-ons:')
    expect(cart).toContain('Size:')
  })
})
