import type { SupabaseClient } from '@supabase/supabase-js'
import { getTaxRatesForRestaurant, defaultTaxRate } from '@/lib/tax-rates/queries'
import type { TaxRateOption } from '@/lib/tax-rates/format'
import { round2, resolveTaxRate, applyTaxToAmount } from '@/lib/tax-rates/apply-tax'

type MenuItemPricingRow = {
  id: string
  base_price: number
  sizes: Array<{ name?: string; price_modifier?: number }>
  addons: Array<{ name?: string; price?: number }>
  tax_rate_id: string | null
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
  priceSource: 'catalog' | 'client-trusted'
}

export type OrderPricingResult = {
  items: PricedOrderLineItem[]
  subtotal: number
  tax: number
  total: number
  /** Human-readable notices worth logging (unmatched menu items, unmatched size/addon names). */
  warnings: string[]
}

function extractMenuItemId(item: Record<string, unknown>): string {
  return String(item.menuItemId ?? item.menu_item_id ?? '').trim()
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

function extractClientSubtotal(item: Record<string, unknown>): number {
  const raw = item.subtotal ?? item.lineTotal ?? item.line_total
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
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

/**
 * No matching menu_items row (missing id, deleted item, or a different restaurant's id) --
 * nothing authoritative to recompute from, so the client-submitted line amount is trusted as
 * the pre-tax subtotal, with only the restaurant's default tax rate applied on top/backed out.
 * This is logged distinctly by the caller from a client-total mismatch: it means "no catalog
 * item to validate against," not "the client lied about a real item's price."
 */
function priceUntrustedLine(
  item: Record<string, unknown>,
  ratesById: Map<string, TaxRateOption>,
  fallbackDefault: TaxRateOption | null,
): PricedOrderLineItem {
  const quantity = extractQuantity(item)
  const clientSubtotal = extractClientSubtotal(item)
  const rate = fallbackDefault
  const applied = applyTaxToAmount(clientSubtotal, rate)

  return {
    ...item,
    unitPrice: quantity > 0 ? round2(clientSubtotal / quantity) : 0,
    quantity,
    subtotal: applied.subtotal,
    tax: applied.tax,
    total: applied.total,
    taxRateId: rate?.id ?? null,
    taxRatePercentage: applied.taxRatePercentage,
    taxInclusive: applied.taxInclusive,
    priceSource: 'client-trusted',
  }
}

/**
 * Authoritative order pricing: for each line item, prices from the restaurant's real
 * menu_items row (never the client) and resolves VAT (item's own tax_rate_id, else the
 * restaurant's default rate, else 0%), returning line-level and order-level subtotal/tax/total.
 * Never trust a client-supplied price/total -- this is what gets stored and charged.
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
          .select('id, base_price, sizes, addons, tax_rate_id')
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

  const pricedItems: PricedOrderLineItem[] = rawItems.map((item) => {
    const menuItemId = extractMenuItemId(item)
    const menuItem = menuItemId ? menuItemsById.get(menuItemId) : undefined

    if (!menuItem) {
      if (menuItemId) {
        warnings.push(`menu item ${menuItemId} not found in restaurant ${restaurantId}, falling back to client-submitted line amount`)
      } else {
        warnings.push('line item has no menuItemId, falling back to client-submitted line amount')
      }
      return priceUntrustedLine(item, ratesById, fallbackDefault)
    }

    return priceCatalogLine(item, menuItem, ratesById, fallbackDefault, warnings)
  })

  const subtotal = round2(pricedItems.reduce((sum, item) => sum + item.subtotal, 0))
  const tax = round2(pricedItems.reduce((sum, item) => sum + item.tax, 0))
  const total = round2(pricedItems.reduce((sum, item) => sum + item.total, 0))

  return { items: pricedItems, subtotal, tax, total, warnings }
}
