/**
 * Sprint 2026-09-28, contract C6 — the terminal sold variant items at base_price, often N$0.
 *
 * The waiter terminal had no variant support: every variant item went up with no selection, and
 * `priceCatalogLine` priced it at `Number(base_price) || 0`. A variant-only item's base_price is
 * the schema default 0, so the till recorded a N$0 sale and nothing refused it.
 *
 * `requireCompleteVariantSelection` (set only by the two terminal routes) closes that: a required
 * group left unanswered, an unknown group or an unknown option is refused; an answered line is
 * priced from the catalog and persisted with the server's canonical selection and a name that
 * carries the variant.
 *
 * THE QR HALF IS AS IMPORTANT AS THE TERMINAL HALF. The customer channel and every repricer call
 * calculateOrderPricing without the flag and must behave exactly as before, including pricing a
 * line whose required group is empty at base. Those cases are pinned at the bottom.
 *
 * calculateOrderPricing runs for real; only Supabase is faked.
 */
import { calculateOrderPricing, UnmatchedMenuItemError } from '@/lib/orders/calculate-order-pricing'
import { resolvedVariantGroupsForWire } from '@/lib/menu/variant-groups'
import { withResolvedVariantGroups } from '@/lib/supabase/menu'
import { orderLineDisplayName, orderLineMoney } from '@/lib/orders/line-display'

jest.mock('@/lib/supabase/client', () => ({ supabase: {} }))
jest.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => ({}) }))

/** Variant-only: base_price is the schema default 0. The exact shape that sold for N$0. */
const LATTE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Latte',
  base_price: 0,
  sizes: [],
  addons: [{ name: 'Extra shot', price: 5 }],
  variants: null,
  variant_groups: [
    {
      name: 'Size',
      required: true,
      type: 'price',
      options: [
        { label: 'Small', price: 30 },
        { label: 'Large', price: 40 },
      ],
    },
    { name: 'Milk', required: false, type: 'text', options: ['Full cream', 'Oat'] },
  ],
  tax_rate_id: null,
  status: 'available',
}

/** Legacy column only, base_price NULL: getVariantGroups synthesises a required 'Size' group. */
const CAPPU_LEGACY = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Cappuccino',
  base_price: null,
  sizes: [],
  addons: [],
  variants: [
    { size: 'S', label: 'Small', price: 35 },
    { size: 'L', label: 'Large', price: 45 },
  ],
  variant_groups: [],
  tax_rate_id: null,
  status: 'available',
}

/** Same legacy shape with a real base, for the QR "priced at base as before" case. */
const CAPPU_LEGACY_BASE45 = { ...CAPPU_LEGACY, id: '33333333-3333-4333-8333-333333333333', base_price: 45 }

const WATER = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Water',
  base_price: 20,
  sizes: [],
  addons: [],
  variants: null,
  variant_groups: [],
  tax_rate_id: null,
  status: 'available',
}

let catalog: Array<Record<string, unknown>> = []

function makeClient() {
  return {
    from(table: string) {
      const data = table === 'menu_items' ? catalog : []
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        in: (_c: string, ids: string[]) =>
          Promise.resolve({ data: catalog.filter((r) => ids.includes(String(r.id))), error: null }),
        then: (res: (v: unknown) => unknown) => res({ data, error: null }),
      }
      return b
    },
  }
}
const client = () => makeClient() as unknown as Parameters<typeof calculateOrderPricing>[0]
const R = 'rest-1'

const terminal = (items: unknown[]) =>
  calculateOrderPricing(client(), R, items, { requireCompleteVariantSelection: true })
const qr = (items: unknown[]) => calculateOrderPricing(client(), R, items)

async function refusal(p: Promise<unknown>): Promise<UnmatchedMenuItemError> {
  try {
    await p
  } catch (err) {
    if (err instanceof UnmatchedMenuItemError) return err
    throw err
  }
  throw new Error('expected a refusal, got a priced order')
}

beforeEach(() => {
  catalog = [LATTE, CAPPU_LEGACY, CAPPU_LEGACY_BASE45, WATER]
})

describe('terminal (requireCompleteVariantSelection)', () => {
  it('prices a normal variant from the catalog and persists name, canonical selection and resolution', async () => {
    const out = await terminal([
      { menuItemId: LATTE.id, name: 'Latte', quantity: 2, selectedVariants: { Size: 'Large' } },
    ])
    const line = out.items[0]
    expect(line.unitPrice).toBe(40)
    expect(line.total).toBe(80)
    expect(out.total).toBe(80)
    expect(line.name).toBe('Latte - Large')
    expect(line.displayName).toBe('Latte - Large')
    expect(line.selectedVariants).toEqual({ Size: 'Large' })
    expect(line.variantResolution).toEqual([{ group: 'Size', label: 'Large', price: 40 }])
  })

  it('multiple groups: the price group replaces base, the text group costs nothing, add-ons add; canonical group order', async () => {
    const out = await terminal([
      {
        menuItemId: LATTE.id,
        name: 'Latte',
        quantity: 1,
        // Sent in the "wrong" order on purpose: the stored name follows the SERVER's group order.
        selectedVariants: { Milk: 'Oat', Size: 'Small' },
        addons: [{ name: 'Extra shot', price: 0 }],
      },
    ])
    const line = out.items[0]
    expect(line.unitPrice).toBe(35)
    expect(line.name).toBe('Latte - Small / Oat')
    expect(Object.keys(line.selectedVariants as object)).toEqual(['Size', 'Milk'])
    expect(line.variantResolution).toEqual([
      { group: 'Size', label: 'Small', price: 30 },
      { group: 'Milk', label: 'Oat', price: null },
    ])
  })

  it('refuses a missing required group with MENU_ITEM_VARIANT_REQUIRED naming item and group', async () => {
    const err = await refusal(terminal([{ menuItemId: LATTE.id, name: 'Latte', quantity: 1 }]))
    expect(err.code).toBe('MENU_ITEM_VARIANT_REQUIRED')
    expect(err.items).toEqual([{ menuItemId: LATTE.id, name: 'Latte', groups: ['Size'] }])
    expect(err.message).toContain('Latte')
    expect(err.message).toContain('Size')
  })

  it('an empty-string answer is not an answer', async () => {
    const err = await refusal(
      terminal([{ menuItemId: LATTE.id, quantity: 1, selectedVariants: { Size: '  ' } }]),
    )
    expect(err.code).toBe('MENU_ITEM_VARIANT_REQUIRED')
  })

  it("refuses the legacy column's synthesised required Size group when unanswered", async () => {
    const err = await refusal(terminal([{ menuItemId: CAPPU_LEGACY.id, quantity: 1 }]))
    expect(err.code).toBe('MENU_ITEM_VARIANT_REQUIRED')
    expect(err.items[0].groups).toEqual(['Size'])
  })

  it('refuses an unknown option in a price group', async () => {
    const err = await refusal(
      terminal([{ menuItemId: LATTE.id, quantity: 1, selectedVariants: { Size: 'Medium' } }]),
    )
    expect(err.code).toBe('MENU_ITEM_UNPRICEABLE_SELECTION')
    expect(err.items).toEqual([{ menuItemId: LATTE.id, name: 'Latte', groups: ['Size'] }])
  })

  it('refuses an unknown option in a text group', async () => {
    const err = await refusal(
      terminal([
        { menuItemId: LATTE.id, quantity: 1, selectedVariants: { Size: 'Small', Milk: 'Soy' } },
      ]),
    )
    expect(err.code).toBe('MENU_ITEM_UNPRICEABLE_SELECTION')
    expect(err.items[0].groups).toEqual(['Milk'])
  })

  it('refuses an unknown group name', async () => {
    const err = await refusal(
      terminal([
        { menuItemId: LATTE.id, quantity: 1, selectedVariants: { Size: 'Small', Temperature: 'Iced' } },
      ]),
    )
    expect(err.code).toBe('MENU_ITEM_UNPRICEABLE_SELECTION')
    expect(err.items[0].groups).toEqual(['Temperature'])
  })

  it('names every offender at once, missing-required first', async () => {
    const err = await refusal(
      terminal([
        { menuItemId: LATTE.id, quantity: 1 },
        { menuItemId: CAPPU_LEGACY.id, quantity: 1, selectedVariants: { Size: 'Venti' } },
      ]),
    )
    expect(err.code).toBe('MENU_ITEM_VARIANT_REQUIRED')
    expect(err.items.map((i) => i.name)).toEqual(['Latte'])
  })

  it('ignores every client money field; a stale `price` is restated from the server', async () => {
    const out = await terminal([
      {
        menuItemId: LATTE.id,
        name: 'Latte',
        quantity: 1,
        selectedVariants: { Size: 'Large' },
        price: 1,
        unitPrice: 1,
        basePrice: 1,
        subtotal: 1,
        total: 1,
      },
    ])
    expect(out.items[0].unitPrice).toBe(40)
    expect(out.items[0].price).toBe(40)
    expect(out.total).toBe(40)
  })

  it('charges the CURRENT catalog price when it changed after the terminal loaded its menu', async () => {
    catalog = [
      {
        ...LATTE,
        variant_groups: [
          { ...LATTE.variant_groups[0], options: [{ label: 'Small', price: 30 }, { label: 'Large', price: 44 }] },
        ],
      },
    ]
    const out = await terminal([
      { menuItemId: LATTE.id, quantity: 1, selectedVariants: { Size: 'Large' }, price: 40 },
    ])
    expect(out.items[0].unitPrice).toBe(44)
    expect(out.total).toBe(44)
  })

  it('zero or NULL base_price with a valid variant prices at the variant, never 0', async () => {
    const out = await terminal([
      { menuItemId: LATTE.id, quantity: 1, selectedVariants: { Size: 'Small' } },
      { menuItemId: CAPPU_LEGACY.id, quantity: 1, selectedVariants: { Size: 'Small' } },
    ])
    expect(out.items.map((i) => i.unitPrice)).toEqual([30, 35])
    expect(out.total).toBe(65)
  })

  it('a plain item is untouched: no rename, no variant fields', async () => {
    const out = await terminal([{ menuItemId: WATER.id, name: 'Water', quantity: 1 }])
    expect(out.items[0].unitPrice).toBe(20)
    expect(out.items[0].name).toBe('Water')
    expect(out.items[0]).not.toHaveProperty('variantResolution')
  })
})

describe('QR / customer channel (flag absent) — exactly as before', () => {
  it('an absent selection on a required group still prices at base and is not refused', async () => {
    const out = await qr([
      { menuItemId: CAPPU_LEGACY_BASE45.id, name: 'Cappuccino', quantity: 1 },
      { menuItemId: LATTE.id, name: 'Latte', quantity: 1, selectedVariants: {} },
    ])
    expect(out.items.map((i) => i.unitPrice)).toEqual([45, 0])
  })

  it('an empty-string selection on a required group still prices at base', async () => {
    const out = await qr([
      { menuItemId: CAPPU_LEGACY_BASE45.id, quantity: 1, selectedVariants: { Size: '' } },
    ])
    expect(out.items[0].unitPrice).toBe(45)
  })

  it('unknown group names and unknown text options are still ignored', async () => {
    const out = await qr([
      {
        menuItemId: LATTE.id,
        quantity: 1,
        selectedVariants: { Size: 'Large', Milk: 'Soy', Temperature: 'Iced' },
      },
    ])
    expect(out.items[0].unitPrice).toBe(40)
  })

  it('does not rename lines or add variant fields; the cart name is stored as sent', async () => {
    const out = await qr([
      { menuItemId: LATTE.id, name: 'Latte - Large', displayName: 'Latte - Large', quantity: 1, selectedVariants: { Size: 'Large' }, price: 40 },
    ])
    const line = out.items[0]
    expect(line.name).toBe('Latte - Large')
    expect(line).not.toHaveProperty('variantResolution')
    expect(line.price).toBe(40)
  })

  it('the F6 refusal body is unchanged: no `groups` key', async () => {
    const err = await refusal(
      qr([{ menuItemId: LATTE.id, quantity: 1, selectedVariants: { Size: 'Medium' } }]),
    )
    expect(err.code).toBe('MENU_ITEM_UNPRICEABLE_SELECTION')
    expect(err.items).toEqual([{ menuItemId: LATTE.id, name: 'Latte' }])
  })
})

describe('menu payload: resolved_variant_groups', () => {
  it('publishes exactly what the pricer resolves, text options with price null', () => {
    expect(resolvedVariantGroupsForWire(LATTE)).toEqual([
      {
        name: 'Size',
        required: true,
        type: 'price',
        options: [
          { label: 'Small', price: 30 },
          { label: 'Large', price: 40 },
        ],
      },
      {
        name: 'Milk',
        required: false,
        type: 'text',
        options: [
          { label: 'Full cream', price: null },
          { label: 'Oat', price: null },
        ],
      },
    ])
    expect(resolvedVariantGroupsForWire(CAPPU_LEGACY)).toEqual([
      {
        name: 'Size',
        required: true,
        type: 'price',
        options: [
          { label: 'Small', price: 35 },
          { label: 'Large', price: 45 },
        ],
      },
    ])
    expect(resolvedVariantGroupsForWire(WATER)).toEqual([])
  })

  it('recomputes it onto a cached payload that predates the field (and overrides a stale one)', () => {
    const cached = {
      sub1: { subcategory: { id: 'sub1' }, items: [{ ...LATTE }, { ...WATER, resolved_variant_groups: [{ stale: true }] }] },
    }
    const out = withResolvedVariantGroups(cached) as typeof cached & {
      sub1: { items: Array<{ resolved_variant_groups: unknown[] }> }
    }
    expect(out.sub1.items[0].resolved_variant_groups).toHaveLength(2)
    expect(out.sub1.items[1].resolved_variant_groups).toEqual([])
    expect(out.sub1.subcategory).toEqual({ id: 'sub1' })
  })
})

describe('dashboard line display', () => {
  it('reads camelCase displayName, which is what stored lines carry', () => {
    expect(orderLineDisplayName({ name: 'Latte', displayName: 'Latte - Large' })).toBe('Latte - Large')
    expect(orderLineDisplayName({ display_name: 'Snake', displayName: 'Camel' })).toBe('Snake')
    expect(orderLineDisplayName({ name: 'Water' })).toBe('Water')
    expect(orderLineDisplayName({}, 'Unknown Item')).toBe('Unknown Item')
  })

  it('renders server money only', () => {
    expect(orderLineMoney({ unitPrice: 40, total: 80 })).toEqual({ unitPrice: 40, total: 80 })
    expect(orderLineMoney({ price: 40 } as never)).toBeNull()
  })
})
