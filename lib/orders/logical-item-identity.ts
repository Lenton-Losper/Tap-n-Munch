/**
 * When are two order lines the SAME LOGICAL ITEM?
 *
 * There are THREE answers. Each neighbouring pair differs by exactly one field, and conflating any
 * two is a defect in both directions. Ruled 2026-08-17, extended 2026-08-18.
 *
 *   RE-ACCEPTANCE id  the configuration, WITHOUT the note.         "is this new content?"
 *   CAP identity      that, plus the note.       PRICE EXCLUDED.   "how many of this preparation?"
 *   DISPLAY identity  that, plus the price.      PRICE INCLUDED.   "may these share one row?"
 *
 * WHY PRICE IS OUT OF THE CAP. If price were part of cap identity, two price lots of the same
 * burger would each see a fresh ceiling: 12 + 12 both "pass" a cap of 20 while the customer holds
 * 24. That is the ceiling being reset by a lot boundary, which is the bug the cap exists to
 * prevent wearing a different hat.
 *
 * WHY PRICE IS IN THE DISPLAY. Merging lots that were charged differently would hide the
 * difference behind a single figure. A customer must never be shown one row that silently averages
 * two prices. Different price => separate rows, grouped under the product, each with its own
 * figure.
 *
 * WHAT IS PART OF IDENTITY, measured from the stored line rather than assumed. Real stored lines
 * carry: menuItemId, name, displayName, size, addons, selectedVariants, specialInstructions,
 * quantity, unitPrice, basePrice, price, priceSource, subtotal, tax, total, taxRateId,
 * taxRatePercentage, taxInclusive, route_to.
 *
 *   menuItemId            IN both     the product
 *   size                  IN both     changes what is made, and the price
 *   selectedVariants      IN both     same
 *   addons                IN both     same
 *   specialInstructions   IN cap and display, OUT of re-acceptance.
 *                                     RULED 2026-08-17: two differently-worded notes are two
 *                                     preparations. The kitchen makes them separately, so they get
 *                                     separate ceilings. Trimmed but NOT lower-cased -- #133
 *                                     established that collapsing "No nuts" into "no nuts"
 *                                     discards a distinction a customer deliberately wrote.
 *                                     RULED 2026-08-18: the SAME field is out of the re-acceptance
 *                                     key, because rewording a note on food already accepted asks
 *                                     the kitchen for nothing new. See `reacceptanceIdentity`.
 *   authoritative price   IN display, OUT of cap    see above
 *   displayName / name    OUT of both for the cap; #133 keeps it for the CART because the cart
 *                         merges what renders identically. Here a rename must not reset a ceiling.
 *   taxRateId, taxInclusive, priceSource, route_to   OUT    fiscal and routing metadata, not a
 *                         choice the customer made
 *
 * RELATIONSHIP TO THE EXISTING IDENTITIES. `lib/cart/cart-line-identity.ts` (#133) answers "one
 * card in the cart" and deliberately includes `base_price`; that is right there and wrong here, so
 * this is a sibling rather than a reuse. The sorting and trimming rules are duplicated
 * DELIBERATELY and identically -- see the note on `normalizeAddons`.
 * `lib/orders/line-configuration.ts` (#299) renders a configuration for humans; this one compares
 * it. Both read the same dual shape.
 */

/** Stored lines use `size`/`addons`/`selectedVariants`; cart lines use `selected_*`. Both occur. */
export type ComparableLine = {
  menuItemId?: unknown
  menu_item_id?: unknown
  size?: unknown
  selected_size?: unknown
  addons?: unknown
  selected_addons?: unknown
  selectedVariants?: unknown
  selected_variants?: unknown
  specialInstructions?: unknown
  special_instructions?: unknown
  unitPrice?: unknown
  basePrice?: unknown
  base_price?: unknown
  quantity?: unknown
}

const str = (v: unknown): string => (v == null ? '' : String(v))

/** A size may be a bare name or an object carrying a price modifier. Only the name identifies it. */
function sizeName(line: ComparableLine): string {
  const raw = line.size ?? line.selected_size
  if (raw == null) return ''
  if (typeof raw === 'object') return str((raw as { name?: unknown }).name).trim()
  return str(raw).trim()
}

/**
 * Add-on names, sorted. Sorted because {oat, shot} and {shot, oat} are the same choice and must
 * not become two ceilings. Price is NOT included: an add-on whose price moved is still the same
 * add-on, and price belongs to the display identity via the line's own unit price.
 */
function normalizeAddons(line: ComparableLine): string[] {
  const raw = Array.isArray(line.addons)
    ? line.addons
    : Array.isArray(line.selected_addons)
      ? line.selected_addons
      : []
  return raw
    .map((a) => (a && typeof a === 'object' ? str((a as { name?: unknown }).name) : str(a)).trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

/** Variant entries sorted by key, because object key order is not meaningful. */
function normalizeVariants(line: ComparableLine): Array<[string, string]> {
  const raw = (line.selectedVariants ?? line.selected_variants) as unknown
  if (!raw || typeof raw !== 'object') return []
  return Object.entries(raw as Record<string, unknown>)
    .map(([k, v]) => [String(k).trim(), str(v).trim()] as [string, string])
    .filter(([k]) => k.length > 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
}

function instructions(line: ComparableLine): string {
  return str(line.specialInstructions ?? line.special_instructions).trim()
}

/**
 * The parts every identity is built from, normalised ONCE.
 *
 * All three exported identities are derived from this single tuple rather than each assembling
 * their own. That is the anti-drift measure: if a future field changes how it is sorted or
 * trimmed, it changes here and all three move together. An identity that normalised its own
 * fields could silently diverge from a sibling and the divergence would show up as a ceiling that
 * resets, or a re-acceptance that fires on nothing.
 */
function identityParts(line: ComparableLine) {
  return {
    product: str(line.menuItemId ?? line.menu_item_id).trim(),
    size: sizeName(line),
    variants: normalizeVariants(line),
    addons: normalizeAddons(line),
    instructions: instructions(line),
  }
}

/**
 * THE CAP IDENTITY. Everything the customer chose, and no price.
 *
 * Two lines with equal cap identity count toward ONE ceiling, however many lots they arrived in
 * and whatever they were charged.
 */
export function capIdentity(line: ComparableLine): string {
  const p = identityParts(line)
  return JSON.stringify([p.product, p.size, p.variants, p.addons, p.instructions])
}

/**
 * THE RE-ACCEPTANCE IDENTITY. The cap identity MINUS `specialInstructions`.
 *
 * Ruled 2026-08-18. The cap and re-acceptance ask different questions and the answer differs by
 * exactly this one field:
 *
 *   CAP           "how many of this PREPARATION?"     A note makes it a different preparation --
 *                                                     the kitchen makes them separately, so they
 *                                                     get separate ceilings. Note IN.
 *   RE-ACCEPTANCE "was the kitchen asked for something
 *                  NEW?"                              Rewording a note on food already accepted is
 *                                                     not new content. Note OUT.
 *
 * The note-only exemption predates this ruling; it is not a new concession. Keeping the note in
 * this key would send every "actually, no onions" back to a staff member for re-acceptance, which
 * is the behaviour the exemption exists to prevent.
 *
 * Deliberately NOT a superset or subset relationship anyone should rely on implicitly: this is a
 * third sibling of `capIdentity` and `displayIdentity`, built from the same `identityParts` so the
 * three cannot drift apart on sorting or trimming.
 */
export function reacceptanceIdentity(line: ComparableLine): string {
  const p = identityParts(line)
  return JSON.stringify([p.product, p.size, p.variants, p.addons])
}

/**
 * The authoritative unit price for a stored line: what the SERVER priced it at.
 *
 * `unitPrice` is what the pricing pass wrote. `basePrice` is the fallback for lines predating it.
 * A client-supplied figure is never consulted here -- and nothing in this module multiplies it.
 */
export function authoritativeUnitPrice(line: ComparableLine): number | null {
  for (const candidate of [line.unitPrice, line.basePrice, line.base_price]) {
    const n = Number(candidate)
    if (Number.isFinite(n)) return Math.round(n * 100) / 100
  }
  return null
}

/**
 * THE DISPLAY IDENTITY. The cap identity plus the authoritative unit price.
 *
 * Equal display identity is the ONLY condition under which two lots may be shown as one row.
 * Unequal price means the rows stay separate and grouped, never averaged.
 */
export function displayIdentity(line: ComparableLine): string {
  return JSON.stringify([capIdentity(line), authoritativeUnitPrice(line)])
}

/** Quantity as a whole number, defaulting to 1 the way the stored lines already do. */
export function lineQuantity(line: ComparableLine): number {
  const n = Number(line.quantity)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
}

/**
 * How many of this logical item the order already holds, summed across every lot.
 *
 * This is the number the cap must be applied to. Applying it to a single addition instead is how
 * 12 + 12 passed a ceiling of 20.
 */
export function quantityOfLogicalItem(lines: readonly ComparableLine[], identity: string): number {
  return (Array.isArray(lines) ? lines : [])
    .filter((line) => capIdentity(line) === identity)
    .reduce((sum, line) => sum + lineQuantity(line), 0)
}
