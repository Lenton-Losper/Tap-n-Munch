import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Refuse an order at PLACEMENT when a tracked item's stock has run out.
 *
 * Policy, as decided:
 *   - Untracked items are skipped entirely. "Not tracked" means the merchant has opted out
 *     of stock management for that item, so it must never be blocked by it — and must behave
 *     exactly as it did before this check existed.
 *   - For a tracked item with a live recipe, an ingredient balance of ZERO OR BELOW blocks
 *     the order outright. No warning-through state.
 *
 * Why placement and not deduction: deduct_recipe_stock runs from an AFTER UPDATE trigger that
 * fires once an order is already being marked 'completed' — the customer has been served, so
 * there is nothing left to block — and it deliberately swallows exceptions so a recipe
 * misconfiguration cannot strand an order. Blocking has to happen before the order exists.
 *
 * Deliberately NOT enforced here: the case where a balance is positive but smaller than the
 * quantity required (balance 5, recipe needs 10). The rule is "zero or below blocks", so that
 * order proceeds and drives the balance negative, exactly as it does today. Tightening that
 * to balance-minus-required is a separate policy decision.
 */

export type UnavailableLine = { itemName: string; stockItemName: string; balance: number }

export type StockSufficiencyResult =
  | { ok: true }
  | {
      ok: false
      reason: string
      /** Every unavailable item, so the message can name them all rather than just the first. */
      unavailable: UnavailableLine[]
      /** First offender, kept for callers that only need one. */
      itemName: string
      stockItemName: string
      balance: number
    }

/** "X", "X and Y", "X, Y and Z" -- read out to a customer, so no trailing comma or "1 more". */
function listNames(names: string[]): string {
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

type LineItem = Record<string, unknown>

function lineMenuItemId(item: LineItem): string {
  return String(item?.menuItemId ?? item?.menu_item_id ?? '').trim()
}

function lineName(item: LineItem): string {
  const raw = item?.displayName ?? item?.name
  return typeof raw === 'string' && raw.trim() ? raw.trim() : 'this item'
}

/**
 * @param supabase must be able to read menu_items, recipes, recipe_items and stock_movements.
 */
export async function checkStockSufficiency(
  supabase: SupabaseClient,
  restaurantId: string,
  items: LineItem[],
): Promise<StockSufficiencyResult> {
  const menuItemIds = [...new Set(items.map(lineMenuItemId).filter(Boolean))]
  if (menuItemIds.length === 0) return { ok: true }

  // Prefer the DB-side check: it runs in one transaction and takes row locks on the relevant
  // stock_items before reading balances, so concurrent callers cannot interleave and read a
  // torn view of the ledger across what would otherwise be four separate round trips.
  //
  // Falls through to the query-by-query path below if the function is not present (e.g. the
  // migration has not been applied yet), so deploying the code before the migration degrades
  // to the previous behaviour rather than failing every order.
  const rpc = await supabase.rpc('check_stock_sufficiency_locked', {
    p_restaurant_id: restaurantId,
    p_menu_item_ids: menuItemIds,
  })

  if (!rpc.error) {
    const rows = (rpc.data ?? []) as Array<{
      menu_item_id: string
      menu_item_name: string
      stock_item_name: string
      balance: number | string
    }>
    if (rows.length === 0) return { ok: true }

    const unavailable: UnavailableLine[] = []
    const seenIds = new Set<string>()
    for (const row of rows) {
      if (seenIds.has(row.menu_item_id)) continue
      seenIds.add(row.menu_item_id)
      unavailable.push({
        itemName: String(row.menu_item_name || 'this item'),
        stockItemName: String(row.stock_item_name || 'an ingredient'),
        balance: Number(row.balance) || 0,
      })
    }

    const rpcNames = listNames(unavailable.map((u) => u.itemName))
    return {
      ok: false,
      reason:
        unavailable.length === 1
          ? `${rpcNames} is out of stock and cannot be ordered right now.`
          : `${rpcNames} are out of stock and cannot be ordered right now. Please remove them and try again.`,
      unavailable,
      itemName: unavailable[0].itemName,
      stockItemName: unavailable[0].stockItemName,
      balance: unavailable[0].balance,
    }
  }

  console.warn(
    '[STOCK] check_stock_sufficiency_locked unavailable, falling back to unlocked check:',
    rpc.error.message,
  )

  // Only tracked items participate. An untracked item is skipped before any other lookup, so
  // this check cannot change its behaviour in any way.
  const { data: menuRows, error: menuError } = await supabase
    .from('menu_items')
    .select('id, name, track_inventory')
    .eq('restaurant_id', restaurantId)
    .in('id', menuItemIds)
  if (menuError) throw menuError

  const trackedIds = new Set(
    (menuRows ?? []).filter((m) => m.track_inventory === true).map((m) => String(m.id)),
  )
  if (trackedIds.size === 0) return { ok: true }

  const { data: recipes, error: recipeError } = await supabase
    .from('recipes')
    .select('id, menu_item_id')
    .eq('restaurant_id', restaurantId)
    .eq('is_active', true)
    .is('deleted_at', null)
    .in('menu_item_id', [...trackedIds])
  if (recipeError) throw recipeError
  if (!recipes?.length) return { ok: true }

  const recipeByMenuItem = new Map(recipes.map((r) => [String(r.menu_item_id), String(r.id)]))

  const { data: recipeItems, error: itemsError } = await supabase
    .from('recipe_items')
    .select('recipe_id, stock_item_id')
    .in('recipe_id', [...recipeByMenuItem.values()])
  if (itemsError) throw itemsError
  if (!recipeItems?.length) return { ok: true }

  const stockItemIds = [...new Set(recipeItems.map((ri) => String(ri.stock_item_id)))]

  // Balances are derived from the movement ledger, the same source the Stock screen uses, so
  // a refusal always matches the number the merchant can see.
  const { data: movements, error: movementsError } = await supabase
    .from('stock_movements')
    .select('stock_item_id, quantity_delta')
    .in('stock_item_id', stockItemIds)
  if (movementsError) throw movementsError

  const balances = new Map<string, number>()
  for (const id of stockItemIds) balances.set(id, 0)
  for (const m of movements ?? []) {
    const id = String(m.stock_item_id)
    balances.set(id, (balances.get(id) ?? 0) + Number(m.quantity_delta))
  }

  const { data: stockRows } = await supabase
    .from('stock_items')
    .select('id, name')
    .in('id', stockItemIds)
  const stockNameById = new Map((stockRows ?? []).map((s) => [String(s.id), String(s.name)]))

  const itemsByRecipe = new Map<string, string[]>()
  for (const ri of recipeItems) {
    const key = String(ri.recipe_id)
    const list = itemsByRecipe.get(key) ?? []
    list.push(String(ri.stock_item_id))
    itemsByRecipe.set(key, list)
  }

  // Every unavailable line is collected, not just the first. The whole order is rejected
  // either way -- an order must never silently become something other than what the customer
  // selected -- but they should be told everything that is unavailable in one go, rather
  // than removing one item, retrying, and hitting the next refusal.
  const unavailable: UnavailableLine[] = []
  const seen = new Set<string>()

  for (const line of items) {
    const menuItemId = lineMenuItemId(line)
    if (!menuItemId || !trackedIds.has(menuItemId)) continue

    const recipeId = recipeByMenuItem.get(menuItemId)
    if (!recipeId) continue

    for (const stockItemId of itemsByRecipe.get(recipeId) ?? []) {
      const balance = balances.get(stockItemId) ?? 0
      if (balance > 0) continue

      const itemName = lineName(line)
      // One entry per menu item, even if several of its ingredients are depleted, and even
      // if the same item appears on more than one line.
      if (seen.has(menuItemId)) continue
      seen.add(menuItemId)
      unavailable.push({
        itemName,
        stockItemName: stockNameById.get(stockItemId) ?? 'an ingredient',
        balance,
      })
      break
    }
  }

  if (unavailable.length === 0) return { ok: true }

  const names = listNames(unavailable.map((u) => u.itemName))
  const reason =
    unavailable.length === 1
      ? `${names} is out of stock and cannot be ordered right now.`
      : `${names} are out of stock and cannot be ordered right now. Please remove them and try again.`

  return {
    ok: false,
    reason,
    unavailable,
    itemName: unavailable[0].itemName,
    stockItemName: unavailable[0].stockItemName,
    balance: unavailable[0].balance,
  }
}
