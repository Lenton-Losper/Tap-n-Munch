/**
 * Variant groups: one implementation, two renderers.
 *
 * This logic used to live entirely inside app/menu/[restaurantId]/browse/page.tsx, which was
 * safe only for as long as exactly one surface could originate a variant selection. It no
 * longer is: every item now opens ItemDetailModal, so the modal has to resolve, price and name
 * a variant selection in EXACTLY the way the browse page's quick-add did, or a customer's
 * variant is dropped between the two. Two copies of these rules would be two answers to
 * "what does this item cost", so they are lifted here and both surfaces import them.
 *
 * Nothing about the rules themselves changed in the lift -- normalizeVariantGroups still drops
 * a group with no recognised `type`, and the legacy `variants` column still synthesises a
 * required "Size" group when it does. Those are the behaviours
 * __tests__/browse-required-variant-group-orderability.test.tsx pinned against production data.
 */

export type ItemVariant = {
  size: string
  label: string
  price: number
}

export type VariantGroup = {
  name: string
  required: boolean
  type: 'text' | 'price'
  options: Array<string | { label: string; price: number }>
}

type RawVariantGroup = {
  name?: unknown
  required?: unknown
  type?: unknown
  options?: unknown
}

/** Loose on purpose: menu items arrive from the API as plain JSON rows. */
type VariantItem = Record<string, any>

export function getItemVariants(item: VariantItem): ItemVariant[] {
  return Array.isArray((item as { variants?: ItemVariant[] }).variants)
    ? ((item as { variants?: ItemVariant[] }).variants || []).filter(
        (variant) =>
          variant &&
          typeof variant.size === 'string' &&
          typeof variant.label === 'string' &&
          Number.isFinite(Number(variant.price))
      )
    : []
}

export function normalizeVariantGroups(groups: unknown): VariantGroup[] {
  if (!Array.isArray(groups)) return []
  return groups
    .map((group) => {
      const raw = (group || {}) as RawVariantGroup
      const groupName = String(raw.name || '').trim()
      const groupType = raw.type === 'price' ? 'price' : raw.type === 'text' ? 'text' : null
      const rawOptions = Array.isArray(raw.options) ? raw.options : []
      if (!groupName || !groupType || rawOptions.length === 0) return null

      const options = rawOptions
        .map((opt) => {
          if (typeof opt === 'string') return opt
          if (!opt || typeof opt !== 'object') return null
          const optionLabel = String(
            (opt as { label?: unknown; name?: unknown }).label ||
              (opt as { name?: unknown }).name ||
              ''
          ).trim()
          if (!optionLabel) return null
          if (groupType === 'text') return optionLabel
          const priceValue = Number((opt as { price?: unknown }).price)
          if (!Number.isFinite(priceValue)) return null
          return { label: optionLabel, price: priceValue }
        })
        .filter(Boolean) as Array<string | { label: string; price: number }>

      if (options.length === 0) return null
      return {
        name: groupName,
        required: Boolean(raw.required),
        type: groupType,
        options,
      } as VariantGroup
    })
    .filter(Boolean) as VariantGroup[]
}

export function getVariantGroups(item: VariantItem): VariantGroup[] {
  const itemWithVariants = item as { variantGroups?: unknown; variant_groups?: unknown }
  const groups = normalizeVariantGroups(itemWithVariants.variantGroups)
  if (groups.length > 0) return groups
  const snakeCaseGroups = normalizeVariantGroups(itemWithVariants.variant_groups)
  if (snakeCaseGroups.length > 0) return snakeCaseGroups

  const legacyVariants = getItemVariants(item)
  if (legacyVariants.length > 0) {
    return [
      {
        name: 'Size',
        required: true,
        type: 'price',
        options: legacyVariants.map((v) => ({ label: v.label, price: Number(v.price) })),
      },
    ]
  }
  return []
}

export function getVariantOptionLabel(option: string | { label: string; price: number }): string {
  return typeof option === 'string' ? option : String(option.label || '')
}

export function getDefaultGroupSelection(item: VariantItem): Record<string, string> {
  const result: Record<string, string> = {}
  for (const group of getVariantGroups(item)) {
    const first = group.options[0]
    if (typeof first === 'string') {
      result[group.name] = first
    } else if (first && typeof first === 'object') {
      result[group.name] = String(first.label || '')
    }
  }
  return result
}

/**
 * The price a selection resolves to. A 'price' option REPLACES the base price rather than
 * modifying it (that is how the menu editor writes them), which is why an unresolved variant
 * does not merely lose a modifier -- it silently reverts a N$45 Large to its N$20 base.
 */
export function getItemDisplayPrice(item: VariantItem, selection: Record<string, string>): number {
  const variantGroups = getVariantGroups(item)
  for (const group of variantGroups) {
    if (group.type !== 'price') continue
    for (const option of group.options) {
      if (typeof option === 'string') continue
      if (String(option.label || '') === String(selection[group.name] || '')) {
        return Number(option.price)
      }
    }
  }
  return item.base_price
}

export function isRequiredVariantMissing(
  item: VariantItem,
  selection: Record<string, string>
): boolean {
  return getVariantGroups(item).some((group) => {
    if (!group.required) return false
    const selected = String(selection[group.name] || '').trim()
    return !selected
  })
}

/**
 * "Americano - Large", or "Americano - Large / Oat" for two groups. Kept here rather than at
 * either call site because it is the label the customer then sees in the cart, on the kitchen
 * ticket and on the receipt -- if the modal and the browse page built it differently, the same
 * order would read two ways depending on which one added the line.
 */
export function buildVariantDisplayName(
  itemName: string,
  selection: Record<string, string>
): string {
  const variantParts = Object.values(selection).filter(Boolean)
  return variantParts.length > 0 ? `${itemName} - ${variantParts.join(' / ')}` : itemName
}
