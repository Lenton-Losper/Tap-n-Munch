import type { SupabaseClient } from '@supabase/supabase-js'
import { getTaxRatesForRestaurant, defaultTaxRate } from '@/lib/tax-rates/queries'
import type { TaxRateOption } from '@/lib/tax-rates/format'
import { round2, resolveTaxRate, applyTaxToAmount } from '@/lib/tax-rates/apply-tax'
import { isChargeableMenuStatus } from '@/lib/menu/menu-item-status'
import { listNames } from '@/lib/orders/list-names'
import {
  findSelectedVariantPrice,
  findUnpricedVariantSelections,
  findVariantPriceByOptionLabel,
} from '@/lib/menu/variant-groups'

type MenuItemPricingRow = {
  id: string
  /**
   * #273. Selected for the REFUSAL, not for pricing — nothing here computes with it. Without it
   * the only identifier available when a line is rejected was the UUID, and a customer was shown
   * "Menu item 7e70e5cf-… is not available for ordering": a database primary key they cannot act
   * on, and which does not even say which of their lines is the problem.
   */
  name?: string | null
  base_price: number
  sizes: Array<{ name?: string; price_modifier?: number }>
  addons: Array<{ name?: string; price?: number }>
  /**
   * #117. BOTH variant columns, and both for the same reason: they are what
   * `lib/menu/variant-groups.ts` reads to decide what the CUSTOMER was shown, and the server has
   * to price the same thing. Neither is interpreted here -- `getVariantGroups()` owns the
   * precedence between them (stored groups first, the legacy column only when those normalise to
   * nothing), so the two sides cannot drift into disagreeing about which one is in force.
   *
   * Read-only in every sense: nothing here writes, migrates or reshapes either column. #229's
   * question of what the stored shape SHOULD be is untouched by this.
   */
  variants?: unknown
  variant_groups?: unknown
  tax_rate_id: string | null
  status?: string | null
}

export type PricedOrderLineItem = Record<string, unknown> & {
  unitPrice: number
  quantity: number
  subtotal: number
  tax: number
  total: number
  taxRateId: string | null
  taxRatePercentage: number
  taxInclusive: boolean
  priceSource: 'catalog'
}

export type OrderPricingResult = {
  items: PricedOrderLineItem[]
  subtotal: number
  tax: number
  total: number
  /** Human-readable notices worth logging (unmatched size/addon names). */
  warnings: string[]
}

/**
 * Why a line could not be priced. A CODE, not prose — #273.
 *
 * Two verification scripts substring-matched the old message text
 * (`verify-restaurant-tables-rls-{staging,production}.ts`), so rewording the refusal would have
 * silently changed what they assert: one treats the phrase as proof an order was BLOCKED, the
 * other as proof it was not. Both would have kept passing while checking nothing. Callers and
 * probes now match on the code, so copy can be rewritten freely afterwards — which is what let
 * the placeholders below be replaced with signed-off copy without touching a single probe.
 */
export type UnmatchedMenuItemCode =
  | 'MENU_ITEM_MISSING_ID'
  | 'MENU_ITEM_NOT_FOUND'
  | 'MENU_ITEM_NOT_ORDERABLE'
  /**
   * F6. The customer chose something this server cannot price, so the line would otherwise be
   * charged at a figure nobody quoted. See `unpriceableSelectionsFor` for exactly what counts.
   */
  | 'MENU_ITEM_UNPRICEABLE_SELECTION'

export type UnmatchedMenuItemLine = {
  menuItemId: string
  /** The item's own name where the row was found; the cart's label otherwise. */
  name: string
}

export class UnmatchedMenuItemError extends Error {
  readonly statusCode = 400
  readonly code: UnmatchedMenuItemCode
  /** Every offending line, so a client can highlight them all at once. */
  readonly items: UnmatchedMenuItemLine[]

  constructor(
    message: string,
    code: UnmatchedMenuItemCode = 'MENU_ITEM_NOT_FOUND',
    items: UnmatchedMenuItemLine[] = [],
  ) {
    super(message)
    this.name = 'UnmatchedMenuItemError'
    this.code = code
    this.items = items
  }
}

function extractMenuItemId(item: Record<string, unknown>): string {
  return String(item.menuItemId ?? item.menu_item_id ?? '').trim()
}

/** What the CART called this line. Last resort when the catalog row is gone entirely. */
function cartLineName(item: Record<string, unknown>): string {
  const raw = item.displayName ?? item.name
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'One of your items'
}

/**
 * #273. The two refusals for an item that cannot be priced, modelled on the out-of-stock message
 * they sit beside (`checkStockSufficiency`: "<names> is out of stock and cannot be ordered right
 * now."), so a customer meeting either one hears the same voice and the same list punctuation.
 *
 * The distinction they exist to draw: an item the restaurant has WITHDRAWN is not an item that
 * has run out. The reader of the old message took a deliberate deactivation for a stock problem,
 * which is what #273 was filed about. So these deliberately avoid "right now" and "try again" —
 * nothing here is coming back in five minutes.
 *
 * Signed off by the human 2026-08-15. Both keep their singular/plural pair: these name a LIST of
 * items, and "1 item are no longer on the menu" is exactly the sort of seam a customer reads as
 * the restaurant not knowing what it sold them.
 */
function copyNotOrderable(names: string[]): string {
  const list = listNames(names)
  return names.length === 1
    ? `${list} is no longer on the menu. Please remove it from your order.`
    : `${list} are no longer on the menu. Please remove them from your order.`
}

function copyNotFound(names: string[]): string {
  const list = listNames(names)
  return names.length === 1
    ? `We couldn't find ${list} on this menu. Please remove it from your order.`
    : `We couldn't find ${list} on this menu. Please remove them from your order.`
}

function extractQuantity(item: Record<string, unknown>): number {
  const quantity = Number(item.quantity)
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1
}

function extractSizeName(item: Record<string, unknown>): string | null {
  const direct = item.size
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const selected = item.selectedSize ?? item.selected_size
  if (selected && typeof selected === 'object' && 'name' in selected) {
    const name = (selected as { name?: unknown }).name
    if (typeof name === 'string' && name.trim()) return name.trim()
  }
  return null
}

/**
 * The customer's variant choices as `{ group: option }`.
 *
 * Both spellings occur and both are live: the cart posts `selectedVariants`
 * (app/menu/[restaurantId]/cart/page.tsx), a line read back out of `orders.items` keeps that,
 * and a browser cart line uses `selected_variants`. `lib/orders/line-configuration.ts` already
 * accepts both for exactly this reason.
 *
 * Values are narrowed to strings, taking the first entry of an array. Non-string values are
 * dropped rather than coerced: `String({})` would produce a label that can never match an option
 * and would then be reported as an unpriced selection, i.e. a fabricated fault.
 */
function extractVariantSelection(item: Record<string, unknown>): Record<string, string> {
  const raw = item.selectedVariants ?? item.selected_variants
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const selection: Record<string, string> = {}
  for (const [group, value] of Object.entries(raw as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value
    if (typeof first === 'string' && first.trim()) selection[group] = first.trim()
  }
  return selection
}

function extractAddonNames(item: Record<string, unknown>): string[] {
  const raw = item.addons ?? item.selectedAddons ?? item.selected_addons
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim()
      if (entry && typeof entry === 'object' && 'name' in entry) {
        const name = (entry as { name?: unknown }).name
        return typeof name === 'string' ? name.trim() : ''
      }
      return ''
    })
    .filter(Boolean)
}

/**
 * ==================================================================================================
 * F6 — A SELECTION THIS SERVER CANNOT PRICE IS A REFUSAL, NOT A WARNING
 * ==================================================================================================
 *
 * `priceCatalogLine` had three paths that pushed a string onto `warnings` and then charged the
 * customer anyway:
 *
 *   findUnpricedVariantSelections  ->  'requested "<group>" option "<label>" not found, pricing from base'
 *   an unmatched size              ->  'requested size "<name>" not found, ignoring'
 *   an unmatched addon             ->  'requested addon "<name>" not found, ignoring'
 *
 * "Pricing from base" and "ignoring" both mean: charge less than the thing the customer chose.
 * `warnings` is returned to the caller and, on every route, logged. Nobody reads a log at the till,
 * and the order completes at the wrong figure with a receipt that looks ordinary. The audit
 * measured the worst identified case at N$15 per unit across 5 variant-priced items.
 *
 * ==================================================================================================
 * WHAT COUNTS, AND WHAT DELIBERATELY DOES NOT
 * ==================================================================================================
 *
 * The rule is narrow on purpose: refuse only where the missing match COULD have changed the price.
 * Failing closed on everything would start rejecting orders over stray strings that cost nothing,
 * and an ordering flow that refuses good carts gets worked around rather than fixed.
 *
 *   a priced VARIANT group whose chosen option does not exist   REFUSE
 *       The group exists and carries prices, so the option had one and we do not know it. This is
 *       the N$15 case.
 *
 *   a size that matches nothing, where the item HAS sizes       REFUSE
 *       A real size list exists and the customer's choice is not in it, so a modifier was lost.
 *
 *   a size that matches nothing, where the item has NO sizes     warn only
 *       There was no modifier to lose. An older cart line carrying a stray `size` string, or a
 *       variant label mirrored into `selected_size`, both land here and both price correctly.
 *
 *   an addon that matches nothing                                warn only
 *       DELIBERATELY NOT A REFUSAL, and this is the one that is not obvious.
 *
 *       An add-on is optional and additive. Dropping one the catalog does not have charges for
 *       exactly what will be supplied, so the customer is not overcharged and the restaurant is
 *       not short for anything it delivered -- the customer simply does not get the extra. That
 *       is the safe direction on its own.
 *
 *       It is also the client-supplied-price attack surface: `create-order-reprices-terminal-leg`
 *       sends `{ name: 'Free caviar', price: -9999 }` precisely to prove a client figure never
 *       reaches the total. Dropping it already defeats that; refusing would let any client make an
 *       order un-placeable by naming a nonexistent extra.
 *
 *       The undercharge F6 is about is a REPLACEMENT price we failed to apply, not an addition we
 *       declined to make.
 *
 * A LABEL THE VARIANT RESOLUTION ALREADY CONSUMED IS NOT UNMATCHED. The item modal mirrors a
 * priced variant choice into `selected_size`, so treating that as a missing size would refuse
 * every correctly-priced sized drink -- the same false positive the warning below already
 * suppresses, and the reason this check reuses that condition rather than restating it.
 */
export type UnpriceableSelection = {
  kind: 'variant' | 'size' | 'addon'
  /** The group name for a variant; 'size' or 'addon' otherwise. */
  group: string
  /** What the customer chose that could not be priced. */
  label: string
}

export function unpriceableSelectionsFor(
  item: Record<string, unknown>,
  menuItem: MenuItemPricingRow,
): UnpriceableSelection[] {
  const out: UnpriceableSelection[] = []

  const variantSelection = extractVariantSelection(item)
  for (const unpriced of findUnpricedVariantSelections(menuItem, variantSelection)) {
    out.push({ kind: 'variant', group: unpriced.groupName, label: unpriced.label })
  }

  const sizes = menuItem.sizes || []
  const sizeName = extractSizeName(item)
  if (sizeName && sizes.length > 0) {
    const matchedSize = sizes.find((s) => s?.name === sizeName)
    if (!matchedSize) {
      // The variant resolution may legitimately have consumed this exact label -- see above.
      let matchedVariant = findSelectedVariantPrice(menuItem, variantSelection)
      if (!matchedVariant) matchedVariant = findVariantPriceByOptionLabel(menuItem, sizeName)
      if (!(matchedVariant && matchedVariant.label === sizeName)) {
        out.push({ kind: 'size', group: 'size', label: sizeName })
      }
    }
  }

  /**
   * ADD-ONS ARE NOT CHECKED HERE. See the docblock: an unmatched add-on is dropped with a warning,
   * which charges for exactly what will be supplied and also defeats the client-supplied-price
   * case. Refusing would let any client make an order un-placeable by naming a nonexistent extra.
   */
  return out
}

/**
 * #273's voice, for the one refusal a customer can genuinely act on by re-choosing. It names the
 * ITEM rather than the internal group name, because "Flat White" is a thing on the menu and
 * "price_group_2" is not.
 */
function copyUnpriceable(names: string[]): string {
  const list = listNames(names)
  return names.length === 1
    ? `The options you chose for ${list} are no longer available. Please choose again.`
    : `The options you chose for ${list} are no longer available. Please choose again.`
}

/**
 * Prices one line item against a resolved menu_items row: the variant option the customer chose
 * (an ABSOLUTE price, REPLACING base_price) or base_price where none was chosen, then matched
 * size/addon modifiers ADDED to it (only modifiers found by name in the catalog row ever
 * contribute -- unmatched names are dropped, never trusted from the client), then VAT per the
 * resolved rate. Inclusive rates keep the charged amount equal to unit*qty (today's behavior) and
 * back out the VAT portion for reporting; exclusive rates add VAT on top of unit*qty.
 *
 * THE ORDER IS THE WHOLE POINT (#117). A variant option is a REPLACEMENT and a size is a DELTA,
 * so the replacement has to land before the delta or the two compose into a number nobody was
 * ever shown. The client's own amount is still discarded: what is honoured is the catalog's
 * price for the option the client NAMED, which is not the same thing as trusting a figure it
 * sent.
 */
function priceCatalogLine(
  item: Record<string, unknown>,
  menuItem: MenuItemPricingRow,
  ratesById: Map<string, TaxRateOption>,
  fallbackDefault: TaxRateOption | null,
  warnings: string[],
): PricedOrderLineItem {
  const quantity = extractQuantity(item)
  let unitPrice = Number(menuItem.base_price) || 0

  const sizeName = extractSizeName(item)
  const matchedSize = sizeName ? (menuItem.sizes || []).find((s) => s?.name === sizeName) : undefined

  /*
   * #117. Resolved through the SAME lib/menu/variant-groups.ts the customer's screen used, so
   * the charge is the figure that was on the button rather than a second opinion about it.
   *
   * The selection map is preferred because it is keyed by GROUP NAME and therefore works whatever
   * the group is called. The bare size string is a fallback for a line that carries no map --
   * an older cart line out of localStorage, or any client that only sends `size` -- and it is
   * consulted only after a real `menu_items.sizes` entry has failed to match, so an item with
   * genuine additive sizes prices exactly as it did before this existed.
   */
  const variantSelection = extractVariantSelection(item)
  let matchedVariant = findSelectedVariantPrice(menuItem, variantSelection)
  if (!matchedVariant && sizeName && !matchedSize) {
    matchedVariant = findVariantPriceByOptionLabel(menuItem, sizeName)
  }
  if (matchedVariant && Number.isFinite(matchedVariant.price)) {
    unitPrice = matchedVariant.price
  }

  /*
   * The instrument, and it is deliberately NOT the size warning below.
   *
   * Before #117 the only signal that a variant had been dropped was "requested size ... not
   * found", which needed the group to be named `Size` to fire at all -- so the loud rows were the
   * ones that happened to be named right and everything else diverged in silence. This fires on
   * the group's own terms.
   */
  for (const unpriced of findUnpricedVariantSelections(menuItem, variantSelection)) {
    warnings.push(
      `menu item ${menuItem.id}: requested "${unpriced.groupName}" option "${unpriced.label}" not found, pricing from base`,
    )
  }

  if (sizeName) {
    if (matchedSize) {
      unitPrice += Number(matchedSize.price_modifier) || 0
    } else if (!(matchedVariant && matchedVariant.label === sizeName)) {
      // Suppressed when the variant resolution already consumed this exact label: the modal
      // MIRRORS a priced variant choice into selected_size, so warning here would report a
      // correctly priced line as a fault on every sized drink.
      warnings.push(`menu item ${menuItem.id}: requested size "${sizeName}" not found, ignoring`)
    }
  }

  for (const addonName of extractAddonNames(item)) {
    const matchedAddon = (menuItem.addons || []).find((a) => a?.name === addonName)
    if (matchedAddon) {
      unitPrice += Number(matchedAddon.price) || 0
    } else {
      warnings.push(`menu item ${menuItem.id}: requested addon "${addonName}" not found, ignoring`)
    }
  }

  const rate = resolveTaxRate(menuItem.tax_rate_id, ratesById, fallbackDefault)
  const applied = applyTaxToAmount(unitPrice * quantity, rate)

  return {
    ...item,
    unitPrice: round2(unitPrice),
    quantity,
    subtotal: applied.subtotal,
    tax: applied.tax,
    total: applied.total,
    taxRateId: rate?.id ?? null,
    taxRatePercentage: applied.taxRatePercentage,
    taxInclusive: applied.taxInclusive,
    priceSource: 'catalog',
  }
}

// #272: the allowlist that used to live here is now lib/menu/menu-item-status.ts, shared
// with the customer menu query so the two cannot drift apart again. Behaviour is unchanged
// on this side — 'available' | 'active' remain the only chargeable statuses.

/**
 * Authoritative order pricing: for each line item, prices from the restaurant's real
 * menu_items row (never the client) and resolves VAT (item's own tax_rate_id, else the
 * restaurant's default rate, else 0%), returning line-level and order-level subtotal/tax/total.
 * Unmatched or unavailable menu items are hard-rejected — never trust client amounts.
 */
export async function calculateOrderPricing(
  supabase: SupabaseClient,
  restaurantId: string,
  items: unknown[],
): Promise<OrderPricingResult> {
  const warnings: string[] = []
  const rawItems = (Array.isArray(items) ? items : []) as Record<string, unknown>[]

  if (rawItems.length === 0) {
    return { items: [], subtotal: 0, tax: 0, total: 0, warnings }
  }

  const menuItemIds = [...new Set(rawItems.map(extractMenuItemId).filter(Boolean))]

  const [{ data: menuItemRows, error: menuItemsError }, taxRates] = await Promise.all([
    menuItemIds.length > 0
      ? supabase
          .from('menu_items')
          // #117: `variants, variant_groups` are LOAD-BEARING here, not decoration. Drop either
          // and getVariantGroups() sees an item with no variants, every selection resolves to
          // nothing, and the line silently reprices to base_price -- which is the defect.
          .select('id, name, base_price, sizes, addons, variants, variant_groups, tax_rate_id, status')
          .eq('restaurant_id', restaurantId)
          .in('id', menuItemIds)
      : Promise.resolve({ data: [] as MenuItemPricingRow[], error: null }),
    getTaxRatesForRestaurant(supabase, restaurantId),
  ])

  if (menuItemsError) {
    throw menuItemsError
  }

  const menuItemsById = new Map<string, MenuItemPricingRow>(
    ((menuItemRows ?? []) as MenuItemPricingRow[]).map((row) => [String(row.id), row]),
  )
  const ratesById = new Map<string, TaxRateOption>(taxRates.map((rate) => [rate.id, rate]))
  const fallbackDefault = defaultTaxRate(taxRates)

  // One validation pass over every line BEFORE pricing any of it, so a refusal names all the
  // offending items at once. The previous version threw from inside the pricing map, which
  // stopped at the first bad line and made the customer discover a bad cart one refusal at a
  // time. checkStockSufficiency already collects all offenders for exactly this reason and says
  // so in its own comment; this is the same courtesy on the sibling refusal (#273).
  const missingId: UnmatchedMenuItemLine[] = []
  const notFound: UnmatchedMenuItemLine[] = []
  const notOrderable: UnmatchedMenuItemLine[] = []
  // F6. Lines whose chosen options this server cannot price, and the detail for the log -- the
  // customer sees the item names, an operator needs to know which option went missing.
  const unpriceable: UnmatchedMenuItemLine[] = []
  const unpriceableDetail: string[] = []

  for (const item of rawItems) {
    const menuItemId = extractMenuItemId(item)
    if (!menuItemId) {
      missingId.push({ menuItemId: '', name: cartLineName(item) })
      continue
    }
    const menuItem = menuItemsById.get(menuItemId)
    if (!menuItem) {
      // No row, so no catalog name — fall back to whatever the cart called it, which is still
      // vastly better than a UUID.
      notFound.push({ menuItemId, name: cartLineName(item) })
      continue
    }
    if (!isChargeableMenuStatus(menuItem.status)) {
      notOrderable.push({
        menuItemId,
        name: String(menuItem.name || '').trim() || cartLineName(item),
      })
      // An item that cannot be ordered at all is not also reported as mis-priced: one refusal
      // per line, and "no longer on the menu" is the one the customer can act on.
      continue
    }

    /**
     * F6. A SELECTION THIS SERVER CANNOT PRICE IS A REFUSAL.
     *
     * Collected in the same pass as the others so a bad cart is reported in one go, and BEFORE any
     * pricing happens, so nothing is half-computed. See `unpriceableSelectionsFor` for the exact
     * rule and for the cases that deliberately stay warnings.
     */
    const unpriceableHere = unpriceableSelectionsFor(item, menuItem)
    if (unpriceableHere.length > 0) {
      unpriceable.push({
        menuItemId,
        name: String(menuItem.name || '').trim() || cartLineName(item),
      })
      unpriceableDetail.push(
        ...unpriceableHere.map((s) => `${menuItemId}: ${s.kind} "${s.group}" option "${s.label}"`),
      )
    }
  }

  // Order matters: a malformed line is a client bug and a different conversation from an item
  // the restaurant has withdrawn, and "no longer on the menu" is the one a customer can act on.
  if (missingId.length > 0) {
    throw new UnmatchedMenuItemError(
      'Each line item needs a valid menuItemId',
      'MENU_ITEM_MISSING_ID',
      missingId,
    )
  }
  if (notOrderable.length > 0) {
    throw new UnmatchedMenuItemError(
      copyNotOrderable(notOrderable.map((line) => line.name)),
      'MENU_ITEM_NOT_ORDERABLE',
      notOrderable,
    )
  }
  if (notFound.length > 0) {
    throw new UnmatchedMenuItemError(
      copyNotFound(notFound.map((line) => line.name)),
      'MENU_ITEM_NOT_FOUND',
      notFound,
    )
  }
  /**
   * F6, LAST of the four. It is ordered after the other three because each of those describes the
   * ITEM being wrong, which is a bigger problem than the options on it and is what a customer
   * should be told about first. A line that is both withdrawn and mis-priced is reported as
   * withdrawn (see the `continue` above).
   *
   * FAILS CLOSED. The alternative -- what stood here -- was to price the line from base and push a
   * string onto `warnings`, which means charging the customer less than the thing they chose and
   * telling nobody who is in a position to notice.
   */
  if (unpriceable.length > 0) {
    console.error('[calculateOrderPricing] refusing lines that cannot be priced', {
      restaurantId,
      detail: unpriceableDetail,
    })
    throw new UnmatchedMenuItemError(
      copyUnpriceable(unpriceable.map((line) => line.name)),
      'MENU_ITEM_UNPRICEABLE_SELECTION',
      unpriceable,
    )
  }

  const pricedItems: PricedOrderLineItem[] = rawItems.map((item) => {
    const menuItemId = extractMenuItemId(item)
    // Re-read rather than carried through: the loop above established that every line resolves
    // to a chargeable row, so this cannot miss. Non-null asserted because the Map's type cannot
    // express what that loop proved — ESTABLISHED, not asserted to quiet the checker.
    const menuItem = menuItemsById.get(menuItemId)!
    return priceCatalogLine(item, menuItem, ratesById, fallbackDefault, warnings)
  })

  const subtotal = round2(pricedItems.reduce((sum, item) => sum + item.subtotal, 0))
  const tax = round2(pricedItems.reduce((sum, item) => sum + item.tax, 0))
  const total = round2(pricedItems.reduce((sum, item) => sum + item.total, 0))

  return { items: pricedItems, subtotal, tax, total, warnings }
}
