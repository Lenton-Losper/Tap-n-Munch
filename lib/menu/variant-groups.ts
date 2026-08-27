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

/** A price-typed option a selection actually landed on. */
export type ResolvedVariantPrice = {
  /** The group the option belongs to -- 'Size' on today's rows, but never assumed to be. */
  groupName: string
  /** The option label, i.e. exactly what the customer tapped. */
  label: string
  /** ABSOLUTE, not a modifier. See getItemDisplayPrice. */
  price: number
}

/**
 * THE one place a variant selection turns into money (#117).
 *
 * This used to be inlined in `getItemDisplayPrice` and nowhere else, which meant only the
 * BROWSER could answer "what does this selection cost". `lib/orders/calculate-order-pricing.ts`
 * never read `variants`/`variant_groups` at all, so the server repriced every line from
 * `base_price` + additive `sizes` and threw the customer's variant away -- and because these
 * rows carry `sizes: []`, the charge landed on `base_price` whatever was picked. Measured
 * against production 2026-08-27: FNB ChowNow / Riviera `Cappucinno`, base 45, options
 * Large 45 / Small 35 -- a customer choosing Small was billed 4500 cents against the 3500 shown.
 *
 * It returns the MATCH rather than the price so a caller can tell "the selection resolved to an
 * option that happens to cost base_price" from "nothing matched". `getItemDisplayPrice` could
 * not: both came back as `item.base_price`, so no caller could ever notice a dropped selection.
 *
 * First price-typed match wins, exactly as before -- this is a refactor of the existing rule,
 * not a new one.
 */
export function findSelectedVariantPrice(
  item: VariantItem,
  selection: Record<string, string>
): ResolvedVariantPrice | null {
  for (const group of getVariantGroups(item)) {
    if (group.type !== 'price') continue
    for (const option of group.options) {
      if (typeof option === 'string') continue
      const label = String(option.label || '')
      if (label === String(selection[group.name] || '')) {
        return { groupName: group.name, label, price: Number(option.price) }
      }
    }
  }
  return null
}

/**
 * The same resolution keyed on the option LABEL alone, for a line that carries a bare size
 * string and no selection map.
 *
 * That shape is not hypothetical: `item-detail-modal` mirrors a priced variant choice into
 * `selected_size`, the cart sends it as `size`, and a line hydrated out of localStorage from an
 * older build can carry the size and nothing else. Consulted ONLY after a real `menu_items.sizes`
 * entry has failed to match, so an item with genuine additive sizes is unaffected.
 */
export function findVariantPriceByOptionLabel(
  item: VariantItem,
  label: string
): ResolvedVariantPrice | null {
  const wanted = String(label || '').trim()
  if (!wanted) return null
  for (const group of getVariantGroups(item)) {
    if (group.type !== 'price') continue
    for (const option of group.options) {
      if (typeof option === 'string') continue
      const optionLabel = String(option.label || '')
      if (optionLabel === wanted) {
        return { groupName: group.name, label: optionLabel, price: Number(option.price) }
      }
    }
  }
  return null
}

/**
 * Price-typed groups the selection answered with something that is NOT one of their options.
 *
 * This is the instrument for #117, and it exists because the old one was an accident: the pricer
 * warned "requested size not found" only when the group happened to be called `Size`, because the
 * only thing that reached the server was `selected_size` and the modal hardcoded that key. A
 * group named `Volume` diverged with nothing logged at all.
 *
 * Judged PER GROUP, so a second price group left unpriced by the first-match rule above is not
 * reported as unmatched -- it was matched, it just did not win.
 */
export function findUnpricedVariantSelections(
  item: VariantItem,
  selection: Record<string, string>
): Array<{ groupName: string; label: string }> {
  const unpriced: Array<{ groupName: string; label: string }> = []
  for (const group of getVariantGroups(item)) {
    if (group.type !== 'price') continue
    const chosen = String(selection[group.name] || '').trim()
    if (!chosen) continue
    const matched = group.options.some(
      (option) => typeof option !== 'string' && String(option.label || '') === chosen
    )
    if (!matched) unpriced.push({ groupName: group.name, label: chosen })
  }
  return unpriced
}

/**
 * The price a selection resolves to. A 'price' option REPLACES the base price rather than
 * modifying it (that is how the menu editor writes them), which is why an unresolved variant
 * does not merely lose a modifier -- it silently reverts a N$45 Large to its N$20 base.
 */
export function getItemDisplayPrice(item: VariantItem, selection: Record<string, string>): number {
  const matched = findSelectedVariantPrice(item, selection)
  return matched ? matched.price : item.base_price
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

/* ------------------------------------------------------------------------------------------
 * WRITE SIDE (#229)
 *
 * Everything above this line READS a stored group. Everything below decides what may be
 * STORED, and it is deliberately stricter, because the ruling on #229 was: the correction goes
 * in whatever writes these groups, not in a reader taught to tolerate the gap.
 *
 * The gap: production's five `variant_groups` rows (FNB ChowNow coffees) carry
 *
 *     { id:'size', name:'Size', required:true,
 *       options:[{ id:'250ml', name:'250ml', price_modifier:0 }, ...] }
 *
 * -- no `type`, and option prices expressed as a DELTA (`price_modifier`) where every reader
 * here expects an ABSOLUTE (`price`). normalizeVariantGroups drops them twice over, so what
 * customers actually see is the legacy `menu_items.variants` column instead.
 *
 * THE ONE THING THIS MUST NOT DO. `price_modifier` and `price` are different kinds of number.
 * Copying one into the other would price a `price_modifier: 0` default size at N$0.00 against
 * N$45 today; deriving `base_price + modifier` would be arithmetic on money performed by a
 * shape converter. Both are ruled out. A group whose pricing basis is a delta is therefore
 * NOT converted here and NOT dropped either -- it is preserved byte-for-byte and NAMED in
 * `unconvertible`, so the caller can say so out loud instead of losing it silently.
 *
 * Silent loss is not hypothetical: before this existed, the editor's own sanitiser mapped an
 * option object to `String(opt.label || '')`, and a production option has `name`, not `label`.
 * Every option came out empty, the group came out empty, and the group was discarded. On an
 * item carrying one good group beside one legacy group, saving ANY unrelated field wrote back
 * only the good one and destroyed the other, with no error and nothing on screen.
 */

export type VariantGroupWriteResult = {
  /** Exactly what belongs in the `variant_groups` column. */
  groups: unknown[]
  /**
   * Names of groups passed through untouched because their pricing basis could not be
   * established from the group alone. These are stored, but they are NOT canonical, so every
   * reader will keep ignoring them until a human supplies absolute prices.
   */
  unconvertible: string[]
}

function writeOptionLabel(option: unknown): string {
  if (typeof option === 'string') return option.trim()
  if (!option || typeof option !== 'object') return ''
  const raw = option as { label?: unknown; name?: unknown }
  return String(raw.label ?? raw.name ?? '').trim()
}

/** The option's ABSOLUTE price, or null when it does not carry one. Never derived. */
function writeOptionAbsolutePrice(option: unknown): number | null {
  if (!option || typeof option !== 'object') return null
  const price = Number((option as { price?: unknown }).price)
  return Number.isFinite(price) ? price : null
}

/** True when the option prices itself as a DELTA and gives no absolute to use instead. */
function writeOptionIsDeltaPriced(option: unknown): boolean {
  if (!option || typeof option !== 'object') return false
  if (writeOptionAbsolutePrice(option) !== null) return false
  const modifier = Number((option as { price_modifier?: unknown }).price_modifier)
  return Number.isFinite(modifier)
}

/**
 * Canonicalise variant groups on the way INTO the database.
 *
 * - A missing `type` is INFERRED, never left absent: 'price' when the options carry absolute
 *   prices, otherwise 'text'. This is the half of #229 that is safe to automate, because
 *   neither branch invents a number.
 * - An option label is read as `label || name`, matching the reader.
 * - A group is dropped ONLY when it has no name or no options -- a group with no name cannot
 *   be keyed by a selection map, so it could never be rendered, priced or enforced anyway.
 * - A group whose options are delta-priced, or which canonicalises to zero usable options, is
 *   preserved verbatim and named in `unconvertible`. See the block comment above for why.
 */
export function sanitizeVariantGroupsForWrite(groups: unknown): VariantGroupWriteResult {
  if (!Array.isArray(groups)) return { groups: [], unconvertible: [] }

  const stored: unknown[] = []
  const unconvertible: string[] = []

  for (const group of groups) {
    const raw = (group || {}) as RawVariantGroup
    const groupName = String(raw.name ?? '').trim()
    const rawOptions = Array.isArray(raw.options) ? raw.options : []
    if (!groupName || rawOptions.length === 0) continue

    // The delta guard runs before anything else and outranks a declared `type`: a group whose
    // options carry money in the other unit is not this function's to reinterpret, however it
    // labels itself.
    if (rawOptions.some(writeOptionIsDeltaPriced)) {
      stored.push(group)
      unconvertible.push(groupName)
      continue
    }

    const declaredType = raw.type === 'price' ? 'price' : raw.type === 'text' ? 'text' : null
    const hasAbsolutePrice = rawOptions.some((opt) => writeOptionAbsolutePrice(opt) !== null)
    const type: 'price' | 'text' = declaredType ?? (hasAbsolutePrice ? 'price' : 'text')

    const options: Array<string | { label: string; price: number }> =
      type === 'price'
        ? rawOptions
            .map((opt) => ({ label: writeOptionLabel(opt), price: writeOptionAbsolutePrice(opt) }))
            .filter((opt) => opt.label !== '' && opt.price !== null && opt.price > 0)
            .map((opt) => ({ label: opt.label, price: opt.price as number }))
        : rawOptions.map(writeOptionLabel).filter((label) => label !== '')

    if (options.length === 0) {
      stored.push(group)
      unconvertible.push(groupName)
      continue
    }

    stored.push({ name: groupName, required: Boolean(raw.required), type, options })
  }

  return { groups: stored, unconvertible }
}

/**
 * SERVER-SIDE ENFORCEMENT PREDICATE (#228). NOT YET WIRED -- see the issue and the handover.
 *
 * Reads the RAW stored `variant_groups`, deliberately NOT the reader-tolerant
 * `getVariantGroups()` view. That is the entire point of the issue: today the only enforcement
 * anywhere iterates `getVariantGroups()`, so a group normalisation drops is unenforceable by
 * construction. A rule a customer's browser can nullify by failing to render something is not
 * a rule.
 *
 * A required group with no options is SKIPPED rather than reported. There is nothing a
 * customer could select to satisfy it, so reporting it would refuse the order permanently
 * rather than ask for anything.
 *
 * @returns the names of required groups the selection leaves unanswered; empty means satisfied.
 */
export function findMissingRequiredVariantGroups(
  storedGroups: unknown,
  selection: unknown
): string[] {
  if (!Array.isArray(storedGroups)) return []
  const chosen =
    selection && typeof selection === 'object' && !Array.isArray(selection)
      ? (selection as Record<string, unknown>)
      : {}

  const missing: string[] = []
  for (const group of storedGroups) {
    const raw = (group || {}) as RawVariantGroup
    if (!raw.required) continue
    const groupName = String(raw.name ?? '').trim()
    if (!groupName) continue
    if (!Array.isArray(raw.options) || raw.options.length === 0) continue
    if (String(chosen[groupName] ?? '').trim() === '') missing.push(groupName)
  }
  return missing
}
