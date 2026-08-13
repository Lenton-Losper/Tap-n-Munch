import type { SupabaseClient } from '@supabase/supabase-js'
import { getTaxRatesForRestaurant, defaultTaxRate } from '@/lib/tax-rates/queries'
import type { TaxRateOption } from '@/lib/tax-rates/format'
import { round2, resolveTaxRate, applyTaxToAmount } from '@/lib/tax-rates/apply-tax'
import { isChargeableMenuStatus } from '@/lib/menu/menu-item-status'
import { listNames } from '@/lib/orders/list-names'

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
 * probes now match on the code, so copy can be rewritten freely afterwards — which is the point,
 * because the copy below is a placeholder.
 */
export type UnmatchedMenuItemCode =
  | 'MENU_ITEM_MISSING_ID'
  | 'MENU_ITEM_NOT_FOUND'
  | 'MENU_ITEM_NOT_ORDERABLE'

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
 * PENDING COPY — #273. Two placeholder refusals, modelled on the out-of-stock message they sit
 * beside (`checkStockSufficiency`: "<names> is out of stock and cannot be ordered right now."),
 * so a customer meeting either one hears the same voice and the same list punctuation.
 *
 * The distinction they exist to draw: an item the restaurant has WITHDRAWN is not an item that
 * has run out. The reader of the old message took a deliberate deactivation for a stock problem,
 * which is what #273 was filed about. So these deliberately avoid "right now" and "try again" —
 * nothing here is coming back in five minutes.
 *
 * Not final. Replace both, plus the 17 in EDIT_COPY_PENDING, in one pass.
 */
function pendingCopyNotOrderable(names: string[]): string {
  const list = listNames(names)
  return names.length === 1
    ? `PENDING COPY — ${list} is no longer on the menu. Please remove it from your order.`
    : `PENDING COPY — ${list} are no longer on the menu. Please remove them from your order.`
}

function pendingCopyNotFound(names: string[]): string {
  const list = listNames(names)
  return names.length === 1
    ? `PENDING COPY — We could not find ${list} on this restaurant's menu. Please remove it from your order.`
    : `PENDING COPY — We could not find ${list} on this restaurant's menu. Please remove them from your order.`
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
 * Prices one line item against a resolved menu_items row: base_price + matched size/addon
 * modifiers (only modifiers found by name in the catalog row ever contribute to the price --
 * unmatched names are dropped, never trusted from the client), then VAT per the resolved rate.
 * Inclusive rates keep the charged amount equal to base_price*qty (today's behavior) and back
 * out the VAT portion for reporting; exclusive rates add VAT on top of base_price*qty.
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
  if (sizeName) {
    const matchedSize = (menuItem.sizes || []).find((s) => s?.name === sizeName)
    if (matchedSize) {
      unitPrice += Number(matchedSize.price_modifier) || 0
    } else {
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
          .select('id, name, base_price, sizes, addons, tax_rate_id, status')
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
      pendingCopyNotOrderable(notOrderable.map((line) => line.name)),
      'MENU_ITEM_NOT_ORDERABLE',
      notOrderable,
    )
  }
  if (notFound.length > 0) {
    throw new UnmatchedMenuItemError(
      pendingCopyNotFound(notFound.map((line) => line.name)),
      'MENU_ITEM_NOT_FOUND',
      notFound,
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
