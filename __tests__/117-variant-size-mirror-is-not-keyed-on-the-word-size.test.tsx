/**
 * @jest-environment jsdom
 *
 * #117, THE SILENT HALF. `components/menu/item-detail-modal.tsx` hardcoded `selectedVariants.Size`
 * when mirroring the customer's priced variant choice into the legacy `selected_size` field.
 *
 * WHY THAT LOOKED CORRECT FOR SO LONG. Every production row that has a variant group today gets
 * it SYNTHESISED by `getVariantGroups()` out of the legacy `menu_items.variants` column, and that
 * synthesiser hardcodes the name `Size`. So the key always matched, `selected_size` was always
 * populated, and the pricer's "requested size not found, ignoring" warning always fired. That
 * warning is the only reason the mispricing in #117 was ever noticed by anyone.
 *
 * A group named anything else — which is what a venue writing `variant_groups` gets, and what a
 * menu still under construction can produce at any time — left `selected_size` null. Null size,
 * nothing to mismatch, nothing logged: the same wrong bill with the one signal removed. Fixing the
 * pricer alone would have closed the loud case and left this one, with the warning gone.
 *
 * WHAT THE MIRROR IS ACTUALLY FOR, i.e. why a null here is not cosmetic:
 *
 *   - `components/orders-dashboard.tsx:223` (`requestItemLabel`) builds the staff "Waiting for
 *     Review" line label from `item.size` and the add-ons ALONE — it never looks at
 *     `selectedVariants`. A null size means the person deciding whether to make a 250ml or a
 *     500ml is shown neither.
 *   - `lib/orders/calculate-order-pricing.ts` resolves a line that carries a size and no
 *     selection map through the option label. A null size leaves that line on `base_price`.
 *     Asserted below, in cents, against the real pricer.
 *
 * These drive the SHIPPED modal through the DOM and read what it hands `onAddToCart`. Nothing
 * here restates its rules.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

jest.mock('@/components/menu/food-item-image', () => ({
  FoodItemImage: () => null,
}))

import { ItemDetailModal } from '@/components/menu/item-detail-modal'
import { calculateOrderPricing } from '@/lib/orders/calculate-order-pricing'
import type { CartItem } from '@/contexts/cart-context'

/**
 * A price group named something other than `Size`. This is a legal `variant_groups` value that
 * `normalizeVariantGroups` accepts as-is, so the browse card, the modal and the cart already
 * render and price it — the customer sees N$48.00 on the 500ml button.
 */
const COLD_BREW = {
  id: 'cold-brew',
  name: 'Cold Brew',
  description: '',
  base_price: 30,
  has_sizes: false,
  sizes: [],
  has_addons: false,
  addons: [],
  allow_special_instructions: true,
  image_url: null,
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

/**
 * The FNB ChowNow / Riviera `Cappucinno` row, verbatim from production 2026-08-27. Its group is
 * synthesised and therefore called `Size` — this is the row the old expression was written for,
 * and it must keep behaving identically.
 */
const CAPPUCINNO = {
  id: '7e70e5cf-a9f2-4da5-b8c8-403dd0b6d019',
  name: 'Cappucinno',
  description: '',
  base_price: 45,
  has_sizes: false,
  sizes: [],
  has_addons: false,
  addons: [],
  allow_special_instructions: true,
  image_url: null,
  variants: [
    { size: 'L', label: 'Large', price: 45 },
    { size: 'S', label: 'Small', price: 35 },
  ],
  variant_groups: [],
  tax_rate_id: 'rate-1',
  status: 'available',
}

/** An item with no variant groups at all: the mirror must stay null and invent nothing. */
const STILL_WATER = {
  id: 'water',
  name: 'Still Water',
  description: '',
  base_price: 15,
  has_sizes: false,
  sizes: [],
  has_addons: false,
  addons: [],
  allow_special_instructions: true,
  image_url: null,
  variants: [],
  variant_groups: [],
  tax_rate_id: 'rate-1',
  status: 'available',
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Opens the modal on a NEW line, optionally picks a variant option, then presses Add to Cart. */
function addToCart(item: unknown, pick?: { group: string; label: string }): CartItem {
  const onAddToCart = jest.fn()
  act(() => {
    root.render(
      <ItemDetailModal
        item={item as never}
        editingLine={null}
        restaurant={{ currency: 'N$' }}
        onClose={() => {}}
        onAddToCart={onAddToCart}
      />,
    )
  })

  if (pick) {
    // The option controls are `variant-<group>-<index>`; find the one whose label is wanted.
    const control = Array.from(container.querySelectorAll('[id^="variant-"]')).find((el) => {
      const label = container.querySelector(`label[for="${el.id}"]`)
      return (
        el.id.startsWith(`variant-${pick.group}-`) &&
        (label?.textContent || '').includes(pick.label)
      )
    })
    if (!control) throw new Error(`no control for ${pick.group} / ${pick.label}`)
    act(() => {
      control.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  const button = Array.from(container.querySelectorAll('button')).find((el) =>
    /add to cart/i.test(el.textContent || ''),
  )
  if (!button) throw new Error('Add to Cart button not rendered')
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  expect(onAddToCart).toHaveBeenCalledTimes(1)
  return onAddToCart.mock.calls[0][0] as CartItem
}

describe('#117 — the size mirror carries whatever the group is called', () => {
  it('a group named "Volume" reaches selected_size, where the hardcoded key left null', () => {
    const line = addToCart(COLD_BREW, { group: 'Volume', label: '500ml' })

    expect(line.selected_variants).toEqual({ Volume: '500ml' })
    // The defect: this was null, because the modal asked for `selectedVariants.Size`.
    expect(line.selected_size).toEqual({ name: '500ml', price_modifier: 0 })
  })

  it('the default option is mirrored too, without the customer touching anything', () => {
    const line = addToCart(COLD_BREW)
    expect(line.selected_size).toEqual({ name: '250ml', price_modifier: 0 })
  })

  it('a group that IS called Size behaves exactly as before — every production row', () => {
    const line = addToCart(CAPPUCINNO, { group: 'Size', label: 'Small' })

    expect(line.selected_variants).toEqual({ Size: 'Small' })
    expect(line.selected_size).toEqual({ name: 'Small', price_modifier: 0 })
    // And the price the customer sees is the option's, not base_price.
    expect(line.base_price).toBe(35)
  })

  it('an item with no variant groups still mirrors nothing', () => {
    const line = addToCart(STILL_WATER)
    expect(line.selected_size).toBeNull()
    expect(line.selected_variants).toBeUndefined()
  })
})

/*
 * The money consequence, through the real pricer.
 *
 * The cart posts `size: item.selected_size?.name || null` beside the selection map. A line that
 * carries ONLY the size — one hydrated out of localStorage from an older build, or any surface
 * that forwards a size without the map — is resolved by the pricer through the option label. That
 * resolution has nothing to work with when the mirror is null.
 */
const TAX_RATES = [{ id: 'rate-1', name: 'VAT', percentage: 15, is_inclusive: true, is_default: true }]

function pricingClient(row: Record<string, unknown>) {
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
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => Promise.resolve({ data: [row], error: null }),
      }
      return b
    },
  } as unknown as Parameters<typeof calculateOrderPricing>[0]
}

describe('#117 — a null mirror costs money on the size-only path', () => {
  it('the Volume line, posted with its size and no map, is charged 4800 not 3000', async () => {
    const line = addToCart(COLD_BREW, { group: 'Volume', label: '500ml' })

    const result = await calculateOrderPricing(pricingClient(COLD_BREW), 'restaurant-1', [
      {
        menuItemId: line.menu_item_id,
        quantity: line.quantity,
        // Exactly what the cart builds, minus the selection map.
        size: line.selected_size?.name || null,
        addons: [],
      },
    ])

    expect(Math.round(result.total * 100)).toBe(4800)
    // What a null mirror falls back to, and what the customer would have been charged silently.
    expect(Math.round(COLD_BREW.base_price * 100)).toBe(3000)
  })
})
