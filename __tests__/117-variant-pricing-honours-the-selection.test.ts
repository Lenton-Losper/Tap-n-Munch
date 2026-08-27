/**
 * #117 — the server pricer ignored variant pricing, and charged base_price whatever was picked.
 *
 * MEASURED AGAINST PRODUCTION 2026-08-27. The rows below are copied verbatim out of
 * `menu_items`; the `sizes: []` on every one of them is the whole mechanism, because
 * `priceCatalogLine` used to price from `base_price` + `sizes[].price_modifier` alone and there
 * was nothing in `sizes` to modify. What the customer picked was carried in the LEGACY
 * `variants` column, which the select never read.
 *
 * It went BOTH WAYS, and the overcharge is the one that matters:
 *
 *   Cappucinno      base 4500  Large 4500 / Small 3500        picking Small -> billed 4500  (+1000)
 *   Red Cappuccino  base 4500  250ml 3500 / 350ml 4500 / 500ml 5000   picking 250ml -> 4500 (+1000)
 *   Coke 600ml      base 2000  300ml 1600 / 600ml 2000        picking 300ml -> billed 2000  (+400)
 *   Caffe Latte     base 3500  250ml 3500 / 350ml 4500 / 500ml 5000   picking 500ml -> 3500  (-1500)
 *
 * Riviera opens QR-primary carrying the Cappucinno row, which is the overcharge shape.
 *
 * ASSERTED IN CENTS, and asserted as a DIVERGENCE rather than as "the number is right": #159
 * showed two orders with completely correct data still admitted by a gate that checked nothing.
 * Every case below states what the customer was SHOWN, what they were CHARGED before, and pins
 * the gap to zero.
 *
 * These drive the shipped `calculateOrderPricing` end to end. Nothing here restates its
 * arithmetic -- the expected figures are the option prices off the production rows.
 */
import { calculateOrderPricing } from '@/lib/orders/calculate-order-pricing'

/** 15% inclusive, so the charged total equals unit * quantity and the cents are the unit price. */
const TAX_RATES = [
  { id: 'rate-1', name: 'VAT', percentage: 15, is_inclusive: true, is_default: true },
]

let selectedColumns = ''

/** PostgREST returns only what was selected. So does this. */
function project(row: Record<string, unknown>, cols: string): Record<string, unknown> {
  const wanted = cols
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  const out: Record<string, unknown> = {}
  for (const col of wanted) {
    if (col in row) out[col] = row[col]
  }
  return out
}

/**
 * PROJECTS the selected columns rather than handing back the whole fixture, which is what binds
 * these tests to the `.select(...)` itself. Drop `variants` from the query and every case below
 * goes red on the real divergence -- verified by doing exactly that.
 */
function makeClient(rows: Array<Record<string, unknown>>) {
  return {
    from(table: string) {
      if (table === 'tax_rates') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          order: () => Promise.resolve({ data: TAX_RATES, error: null }),
          then: (res: (v: unknown) => void) => res({ data: TAX_RATES, error: null }),
        }
        return b
      }
      if (table !== 'menu_items') throw new Error(`unexpected table ${table}`)
      const b: Record<string, unknown> = {
        select: (cols: string) => {
          selectedColumns = cols
          return b
        },
        eq: () => b,
        in: (_col: string, ids: string[]) =>
          Promise.resolve({
            data: rows
              .filter((r) => ids.includes(String(r.id)))
              .map((r) => project(r, selectedColumns)),
            error: null,
          }),
      }
      return b
    },
  }
}

const asClient = (c: unknown) => c as Parameters<typeof calculateOrderPricing>[0]

const cents = (n: number) => Math.round(n * 100)

// ---------------------------------------------------------------------------------------------
// Production rows, 2026-08-27. Verbatim.
// ---------------------------------------------------------------------------------------------

/** Riviera + FNB ChowNow both carry this exact shape. Riviera's is the launch exposure. */
const CAPPUCINNO = {
  id: '7e70e5cf-a9f2-4da5-b8c8-403dd0b6d019',
  name: 'Cappucinno',
  base_price: 45,
  sizes: [],
  addons: [],
  variants: [
    { size: 'L', label: 'Large', price: 45 },
    { size: 'S', label: 'Small', price: 35 },
  ],
  variant_groups: [],
  tax_rate_id: 'rate-1',
  status: 'available',
}

const CAFFE_LATTE = {
  id: '9b366863-b787-4598-bb0d-1a3e95371003',
  name: 'Caffè Latte',
  base_price: 35,
  sizes: [],
  addons: [],
  variants: [
    { size: 'S', label: '250ml', price: 35 },
    { size: 'M', label: '350ml', price: 45 },
    { size: 'L', label: '500ml', price: 50 },
  ],
  /*
   * BOTH columns populated, and they disagree: this group says 250/350/500 off a base of 35 with
   * price_modifier deltas, the legacy column says 35/45/50 absolute. It carries no `type` and
   * prices its options as `price_modifier`, so `normalizeVariantGroups` drops it and the customer
   * is shown the LEGACY column. Pinned below, because pricing from this one instead would be
   * #200/#228 activating itself through the back door.
   */
  variant_groups: [
    {
      id: 'size',
      name: 'Size',
      required: true,
      options: [
        { id: '250ml', name: '250ml', price_modifier: 0 },
        { id: '350ml', name: '350ml', price_modifier: 10 },
        { id: '500ml', name: '500ml', price_modifier: 15 },
      ],
    },
  ],
  tax_rate_id: 'rate-1',
  status: 'active',
}

const COKE_600 = {
  id: 'a1122658-b899-4f07-a2fd-73dd448e467d',
  name: 'Coke 600ml',
  base_price: 20,
  sizes: [],
  addons: [],
  variants: [
    { size: 'S', label: '300ml', price: 16 },
    { size: 'M', label: '600ml', price: 20 },
  ],
  variant_groups: [],
  tax_rate_id: 'rate-1',
  status: 'active',
}

/** No variants at all, real additive sizes and add-ons: the shape that must not move. */
const BURGER = {
  id: 'burger',
  name: 'Beef Burger',
  base_price: 95,
  sizes: [
    { name: 'Regular', price_modifier: 0 },
    { name: 'Double', price_modifier: 40 },
  ],
  addons: [{ name: 'Cheese', price: 12 }],
  variants: [],
  variant_groups: [],
  tax_rate_id: 'rate-1',
  status: 'available',
}

/**
 * A well-formed `variant_groups` row whose group is NOT called `Size`.
 *
 * This is the shape a venue building a menu today can write, and the customer's screen already
 * renders and prices it -- `getVariantGroups` normalises it and `getItemDisplayPrice` puts the
 * option price in the cart. Only the server was blind to it, and blind in SILENCE: nothing on a
 * `Volume` group ever reached `selected_size`, so not even the old "requested size not found"
 * warning fired.
 */
const RIVIERA_VOLUME_ITEM = {
  id: 'volume-item',
  name: 'Cold Brew',
  base_price: 30,
  sizes: [],
  addons: [],
  variants: [],
  variant_groups: [
    {
      name: 'Volume',
      required: true,
      type: 'price',
      options: [
        { label: '250ml', price: 30 },
        { label: '500ml', price: 48 },
      ],
    },
  ],
  tax_rate_id: 'rate-1',
  status: 'available',
}

/** The line shape the cart actually posts (app/menu/[restaurantId]/cart/page.tsx). */
function cartLine(
  menuItemId: string,
  opts: {
    quantity?: number
    selectedVariants?: Record<string, string>
    size?: string | null
    addons?: Array<{ name: string; price: number }>
  } = {},
) {
  return {
    menuItemId,
    quantity: opts.quantity ?? 1,
    selectedVariants: opts.selectedVariants ?? {},
    size: opts.size ?? null,
    addons: opts.addons ?? [],
    specialInstructions: '',
  }
}

async function priceOne(
  rows: Array<Record<string, unknown>>,
  line: ReturnType<typeof cartLine>,
) {
  return calculateOrderPricing(asClient(makeClient(rows)), 'restaurant-1', [line])
}

describe('#117 — the charge is the option the customer tapped, in cents', () => {
  it('OVERCHARGE, Riviera Cappucinno: Small was shown 3500 and billed 4500', async () => {
    const shown = 3500 // the Small option's own price, off the production row
    const chargedBeforeTheFix = cents(CAPPUCINNO.base_price) // 4500

    const result = await priceOne(
      [CAPPUCINNO],
      cartLine(CAPPUCINNO.id, { selectedVariants: { Size: 'Small' }, size: 'Small' }),
    )

    expect(cents(result.total)).toBe(shown)
    // Stated as the divergence, because "it equals 3500" alone would also pass on a row whose
    // base_price happened to be 35.
    expect(cents(result.total) - shown).toBe(0)
    expect(chargedBeforeTheFix - shown).toBe(1000) // what the customer was overbilled by
  })

  it('UNDERCHARGE, Caffè Latte 500ml: shown 5000, billed 3500', async () => {
    const shown = 5000
    const chargedBeforeTheFix = cents(CAFFE_LATTE.base_price) // 3500

    const result = await priceOne(
      [CAFFE_LATTE],
      cartLine(CAFFE_LATTE.id, { selectedVariants: { Size: '500ml' }, size: '500ml' }),
    )

    expect(cents(result.total)).toBe(shown)
    expect(shown - chargedBeforeTheFix).toBe(1500)
  })

  it('OVERCHARGE, Coke 600ml at 300ml: shown 1600, billed 2000', async () => {
    const result = await priceOne(
      [COKE_600],
      cartLine(COKE_600.id, { selectedVariants: { Size: '300ml' }, size: '300ml' }),
    )
    expect(cents(result.total)).toBe(1600)
    expect(cents(COKE_600.base_price) - 1600).toBe(400)
  })

  it('the option that HAPPENS to equal base_price still prices from the option', async () => {
    // Cappucinno Large is 4500 and base_price is 4500. Before the fix this was charged correctly
    // BY COINCIDENCE, which is why four of production's five sized lines looked fine and one did
    // not. Pinned so a regression cannot hide behind the coincidence.
    const result = await priceOne(
      [CAPPUCINNO],
      cartLine(CAPPUCINNO.id, { selectedVariants: { Size: 'Large' }, size: 'Large' }),
    )
    expect(cents(result.total)).toBe(4500)
  })

  it('quantity multiplies the OPTION price, not base_price', async () => {
    const result = await priceOne(
      [CAPPUCINNO],
      cartLine(CAPPUCINNO.id, { quantity: 3, selectedVariants: { Size: 'Small' }, size: 'Small' }),
    )
    expect(cents(result.total)).toBe(3500 * 3)
    expect(cents(result.items[0].unitPrice)).toBe(3500)
  })

  it('add-ons are ADDED to the resolved option, never to base_price', async () => {
    // The ordering rule: a variant REPLACES, an add-on ADDS. Composing them the other way round
    // produces a figure the customer was never shown.
    const withAddon = {
      ...CAPPUCINNO,
      addons: [{ name: 'Oat milk', price: 8 }],
    }
    const result = await priceOne(
      [withAddon],
      cartLine(CAPPUCINNO.id, {
        selectedVariants: { Size: 'Small' },
        size: 'Small',
        addons: [{ name: 'Oat milk', price: 8 }],
      }),
    )
    expect(cents(result.total)).toBe(3500 + 800)
  })
})

describe('#117 — the silent path: a group that is not called Size', () => {
  it('a Volume group prices from the option, with nothing keyed on the word "Size"', async () => {
    const result = await priceOne(
      [RIVIERA_VOLUME_ITEM],
      cartLine(RIVIERA_VOLUME_ITEM.id, {
        selectedVariants: { Volume: '500ml' },
        size: '500ml',
      }),
    )
    expect(cents(result.total)).toBe(4800)
    expect(cents(RIVIERA_VOLUME_ITEM.base_price)).toBe(3000) // what it silently billed before
  })

  it('a selection naming an option the catalog does not have is REPORTED, not swallowed', async () => {
    // The instrument, and it fires on the group's own name. The old warning needed the group to
    // be called `Size` to exist at all, so this case produced no signal whatsoever.
    const result = await priceOne(
      [RIVIERA_VOLUME_ITEM],
      cartLine(RIVIERA_VOLUME_ITEM.id, { selectedVariants: { Volume: '750ml' } }),
    )
    expect(cents(result.total)).toBe(3000) // falls back to base, as it must
    expect(result.warnings.join(' | ')).toContain('"Volume" option "750ml"')
  })
})

describe('#117 — what must NOT move', () => {
  it('an item with real additive sizes prices base + modifier exactly as before', async () => {
    const result = await priceOne(
      [BURGER],
      cartLine(BURGER.id, { size: 'Double', addons: [{ name: 'Cheese', price: 12 }] }),
    )
    expect(cents(result.total)).toBe(cents(95 + 40 + 12))
    expect(result.warnings).toEqual([])
  })

  it('a plain line with no size and no variants is untouched', async () => {
    const result = await priceOne([BURGER], cartLine(BURGER.id))
    expect(cents(result.total)).toBe(9500)
  })

  it('a MALFORMED variant_groups row stays inert — this does not activate #200', async () => {
    // Caffè Latte carries a `variant_groups` group with no `type` and `price_modifier` options.
    // The customer is shown the LEGACY column, so the server must price from that too. If this
    // ever returns 3500 for 350ml (35 base + 0 modifier for the group's own 250ml default) or
    // starts honouring the group's deltas, the stored-shape question #229 owns has been answered
    // by accident.
    const result = await priceOne(
      [CAFFE_LATTE],
      cartLine(CAFFE_LATTE.id, { selectedVariants: { Size: '350ml' }, size: '350ml' }),
    )
    expect(cents(result.total)).toBe(4500) // the LEGACY 350ml price, not 35 + 10
  })

  it('a correctly priced sized line no longer reports a phantom size fault', async () => {
    // The modal mirrors the variant choice into selected_size, so `size` arrives naming something
    // that is not in `sizes`. Warning about it reported every correctly priced drink as broken.
    const result = await priceOne(
      [CAPPUCINNO],
      cartLine(CAPPUCINNO.id, { selectedVariants: { Size: 'Small' }, size: 'Small' }),
    )
    expect(result.warnings).toEqual([])
  })

  it('a genuinely unknown size is still reported', async () => {
    const result = await priceOne([BURGER], cartLine(BURGER.id, { size: 'Triple' }))
    expect(result.warnings.join(' | ')).toContain('requested size "Triple" not found')
  })
})

describe('#117 — a line carrying only a size string still prices the option', () => {
  it('the older-client shape (no selectedVariants) resolves through the option label', async () => {
    // A cart line hydrated out of localStorage from a build before selected_variants existed
    // carries `selected_size` and nothing else. It is the same customer and the same choice.
    const result = await priceOne([CAPPUCINNO], cartLine(CAPPUCINNO.id, { size: 'Small' }))
    expect(cents(result.total)).toBe(3500)
  })

  it('a real menu size WINS over a coincidentally equal variant label', async () => {
    // Ordering guard: the additive path is tried first, so an item with genuine sizes cannot be
    // hijacked by a variant option that happens to share a label.
    const both = {
      ...BURGER,
      variants: [{ size: 'L', label: 'Double', price: 5 }],
    }
    const result = await priceOne([both], cartLine(BURGER.id, { size: 'Double' }))
    expect(cents(result.total)).toBe(cents(95 + 40)) // not 500
  })
})
