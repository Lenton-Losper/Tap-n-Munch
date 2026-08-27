import { sanitizeVariantGroupsForWrite } from '@/lib/menu/variant-groups'

/**
 * Round a price to whole cents on the way IN.
 *
 * A sub-cent price is not a rounding nuisance, it is a receipt that does not add up. Unit prices
 * are DISPLAYED rounded but lines are computed from the raw value
 * (calculate-order-pricing.ts:116 vs :120), so a unit price of 10.005 at quantity 4 prints
 *
 *     4 x N$10.01 ......... N$40.02
 *
 * and the customer multiplies to 40.04. The total is internally consistent -- what is charged is
 * the raw computation -- so nobody is over- or under-charged. What breaks is the one arithmetic
 * check a customer can actually perform on a document we ask them to check.
 *
 * Fixed HERE rather than in the pricing code, deliberately (ruled). Rounding before multiplying
 * would change what is CHARGED in order to fix a DISPLAY problem, which is the wrong trade;
 * rounding only the printed line leaves the arithmetic inconsistent, just less visibly. Sub-cent
 * prices should not exist, so they are stopped at the one place every write passes through.
 *
 * It is reachable, not theoretical: `menu_items.base_price` is `numeric` with NO scale
 * (baseline.sql:387), sizes and addons are unconstrained jsonb, and
 * app/api/admin/menu/items/route.ts spreads the raw request body straight into this builder. The
 * form's `step="0.01"` is a browser hint, not a server constraint.
 *
 * Non-finite input is passed through unchanged rather than becoming NaN -- a caller already
 * holding a bad number gets the same bad number, not a second, different failure mode. The
 * column stays `numeric` with no scale for now; a CHECK or a scale is a migration and is queued
 * on #213.
 */
function roundPrice(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return n
  return Math.round(n * 100) / 100
}

/**
 * Sizes and add-ons carry prices too, in unconstrained jsonb, and they feed the same line
 * arithmetic as the base price. Rounding only `base_price` would leave the identical defect
 * reachable through a size modifier or an add-on.
 *
 * Only the price field of each entry is touched; every other key is passed through untouched,
 * and a non-array or a non-object entry is returned as-is rather than coerced -- this builder is
 * not the place to decide what a malformed size list means.
 */
function roundPricedList(list: unknown, priceKey: string): unknown {
  if (!Array.isArray(list)) return list
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
    const row = entry as Record<string, unknown>
    if (row[priceKey] === undefined || row[priceKey] === null) return row
    return { ...row, [priceKey]: roundPrice(row[priceKey]) }
  })
}

/** Map UI / Firestore-shaped fields to Supabase menu_items columns only. */
export function buildMenuItemDbPayload(data: Record<string, any>): Record<string, any> {
  const payload: Record<string, any> = {}

  if (data.name !== undefined) payload.name = String(data.name).trim()
  if (data.description !== undefined) {
    payload.description = data.description ? String(data.description) : null
  }
  if (data.base_price !== undefined) payload.base_price = roundPrice(data.base_price)
  if (data.image_url !== undefined) {
    payload.image_url = data.image_url ? String(data.image_url) : null
  }
  if (data.category_id !== undefined) payload.category_id = data.category_id || null
  if (data.subcategory_id !== undefined) payload.subcategory_id = data.subcategory_id || null
  if (data.sub_category_id !== undefined) {
    payload.subcategory_id = data.sub_category_id || null
  }

  if (data.status !== undefined) {
    payload.status = String(data.status)
  }

  if (data.variants !== undefined) payload.variants = data.variants

  /**
   * #229. Both spellings used to be written through verbatim, so `variant_groups` was the one
   * jsonb column with no shape guarantee at all: app/api/admin/menu/items/route.ts spreads the
   * raw request body straight into this builder (see the roundPrice note above, which makes the
   * identical reachability argument for base_price), so ANY body could install a group the
   * customer menu is structurally unable to render -- exactly what production's five FNB
   * ChowNow rows are.
   *
   * Canonicalised HERE for the same reason the rounding is: it is the one place every write
   * passes through, so the editor and the API cannot end up disagreeing about what a stored
   * group looks like. sanitizeVariantGroupsForWrite fills in a missing `type` and reads an
   * option's label as `label || name`; it never converts a `price_modifier` delta into a
   * `price` absolute, so no stored row's PRICING changes as a result of this call.
   */
  if (data.variant_groups !== undefined) {
    payload.variant_groups = sanitizeVariantGroupsForWrite(data.variant_groups).groups
  }
  if (data.variantGroups !== undefined) {
    payload.variant_groups = sanitizeVariantGroupsForWrite(data.variantGroups).groups
  }

  if (data.is_popular !== undefined) payload.is_popular = Boolean(data.is_popular)

  const imageFit = data.image_fit ?? data.imageFit
  if (imageFit !== undefined) payload.image_fit = String(imageFit)

  const imagePosition = data.image_position ?? data.imagePosition
  if (imagePosition !== undefined) payload.image_position = String(imagePosition)

  if (data.allow_special_instructions !== undefined) {
    payload.allow_special_instructions = Boolean(data.allow_special_instructions)
  }

  if (data.has_sizes !== undefined) payload.has_sizes = Boolean(data.has_sizes)
  if (data.sizes !== undefined) payload.sizes = roundPricedList(data.sizes, 'price_modifier')

  if (data.has_addons !== undefined) payload.has_addons = Boolean(data.has_addons)
  if (data.addons !== undefined) payload.addons = roundPricedList(data.addons, 'price')

  if (data.track_inventory !== undefined) {
    payload.track_inventory = Boolean(data.track_inventory)
  }

  if (data.tax_rate_id !== undefined) {
    payload.tax_rate_id = data.tax_rate_id || null
  }

  return payload
}
