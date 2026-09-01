/**
 * Which menu items actually deduct stock, and which are INCOMPLETE CONFIGURATION.
 *
 * ============================================================================================
 * WHY THIS IS A NAMED CLASSIFICATION AND NOT A BOOLEAN
 * ============================================================================================
 *
 * Deduction requires BOTH halves of a two-sided state to agree (`deduct_recipe_stock`, since
 * migration 20260731230000):
 *
 *     menu_items.track_inventory IS TRUE   AND   an active, non-tombstoned recipe with ≥1 ingredient
 *
 * A boolean collapses three genuinely different situations into one, and two of them are faults
 * that look like the third:
 *
 *   deducting                  both halves agree. Sales move stock.
 *   tracked_without_recipe     the merchant ticked "track inventory" and nothing was ever
 *                              configured. Every screen says the item is tracked. NOTHING IS
 *                              DEDUCTED. This is the dangerous one — it is silent, and it is
 *                              indistinguishable from working unless you ask this question.
 *   recipe_without_tracking    a recipe exists but the item is not flagged. Dormant by design
 *                              since 20260731230000; harmless, but invisible drift.
 *   not_tracked                the merchant does not want stock tracked here. Correct, not a fault.
 *
 * RULED 2026-09-01: an incompletely configured item is NEVER guessed at. It is excluded from
 * automatic recipe-based deduction and surfaced to the merchant. Inferring ingredients from a
 * name, a price or a category would put invented numbers into a ledger that people count against.
 *
 * Measured read-only on production the same day: 38 items are `tracked_without_recipe` — the whole
 * of Chownow Nedbank's coffee menu — and 26 are `recipe_without_tracking`.
 */

export type InventoryConfigurationState =
  | 'deducting'
  | 'tracked_without_recipe'
  | 'recipe_without_tracking'
  | 'not_tracked'

export type MenuItemForConfiguration = {
  id: string
  name?: string | null
  restaurant_id?: string | null
  /** NULL is NOT tracked — matches the SQL's `IS TRUE`, which a NULL fails. */
  track_inventory?: boolean | null
  status?: string | null
}

export type RecipeForConfiguration = {
  id: string
  menu_item_id: string
  is_active?: boolean | null
  /** Soft delete (20260801010000). A tombstoned recipe does not deduct. */
  deleted_at?: string | null
}

export type RecipeItemForConfiguration = {
  recipe_id: string
}

export type InventoryConfigurationRow = {
  menuItemId: string
  name: string
  restaurantId: string | null
  state: InventoryConfigurationState
  /** True only for `deducting`. Everything else moves no stock on a sale. */
  deducts: boolean
  ingredientCount: number
  status: string | null
}

/**
 * A recipe only counts if it is active, not tombstoned, AND carries at least one ingredient.
 *
 * The ingredient count matters and is not pedantry: an empty recipe satisfies "a recipe exists"
 * while deducting precisely nothing, so treating its presence as configuration would report the
 * silent case as healthy — which is the exact failure this classification exists to expose.
 */
export function liveRecipeFor(
  menuItemId: string,
  recipes: readonly RecipeForConfiguration[],
  recipeItems: readonly RecipeItemForConfiguration[],
): { recipeId: string; ingredientCount: number } | null {
  const recipe = recipes.find(
    (r) => r.menu_item_id === menuItemId && r.is_active === true && !r.deleted_at,
  )
  if (!recipe) return null
  const ingredientCount = recipeItems.filter((ri) => ri.recipe_id === recipe.id).length
  return ingredientCount >= 1 ? { recipeId: recipe.id, ingredientCount } : null
}

export function classifyInventoryConfiguration(
  item: MenuItemForConfiguration,
  recipes: readonly RecipeForConfiguration[],
  recipeItems: readonly RecipeItemForConfiguration[],
): InventoryConfigurationRow {
  const live = liveRecipeFor(item.id, recipes, recipeItems)
  // `=== true` and not truthiness: this must mirror the SQL's `track_inventory IS TRUE`, under
  // which NULL is not tracked. A truthy test would agree by accident today and diverge the moment
  // anything writes a non-boolean.
  const tracked = item.track_inventory === true

  let state: InventoryConfigurationState
  if (tracked && live) state = 'deducting'
  else if (tracked && !live) state = 'tracked_without_recipe'
  else if (!tracked && live) state = 'recipe_without_tracking'
  else state = 'not_tracked'

  return {
    menuItemId: item.id,
    name: String(item.name ?? '').trim() || '(unnamed)',
    restaurantId: item.restaurant_id ?? null,
    state,
    deducts: state === 'deducting',
    ingredientCount: live?.ingredientCount ?? 0,
    status: item.status ?? null,
  }
}

export function classifyAll(
  items: readonly MenuItemForConfiguration[],
  recipes: readonly RecipeForConfiguration[],
  recipeItems: readonly RecipeItemForConfiguration[],
): InventoryConfigurationRow[] {
  return items.map((i) => classifyInventoryConfiguration(i, recipes, recipeItems))
}

/**
 * The items a merchant has to act on: they believe stock is tracked and it is not.
 *
 * Deliberately NOT "everything that does not deduct" — `not_tracked` is a choice, and listing it
 * as a problem is how a warning surface becomes noise and then gets ignored.
 */
export function incompleteConfiguration(
  rows: readonly InventoryConfigurationRow[],
): InventoryConfigurationRow[] {
  return rows.filter((r) => r.state === 'tracked_without_recipe')
}

/** Counts for a banner. `missing` is the number that needs a merchant decision. */
export function summariseConfiguration(rows: readonly InventoryConfigurationRow[]) {
  const tally: Record<InventoryConfigurationState, number> = {
    deducting: 0,
    tracked_without_recipe: 0,
    recipe_without_tracking: 0,
    not_tracked: 0,
  }
  for (const r of rows) tally[r.state] += 1
  return {
    ...tally,
    total: rows.length,
    missing: tally.tracked_without_recipe,
  }
}
