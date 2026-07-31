import type { SupabaseClient } from '@supabase/supabase-js'
import { formatMeasurementUnitLabel } from '@/lib/measurement-units/format'

export type InventorySetupItemRef = {
  menuItemId: string
  name: string
}

export type InventorySetupData = {
  total: number
  configured: number
  missing: number
  missingItems: InventorySetupItemRef[]
  /** Menu items with track_inventory=true and ≥1 ingredient configured. */
  readyMenuItemIds: string[]
  /**
   * Menu items with an ACTIVE recipe and ≥1 ingredient whose track_inventory is false.
   *
   * Neither of the lists above can contain these -- both are filtered to track_inventory=true
   * -- so before this the state was invisible to every surface: no badge, not counted as
   * configured, not counted as missing. Meanwhile deduct_recipe_stock keys solely on
   * recipes.is_active, so these items still deduct stock on every sale.
   */
  linkedButUntrackedIds: string[]
}

/** @deprecated Use InventorySetupData */
export type RecipesOverviewData = {
  withRecipe: number
  total: number
  rows: RecipeMenuItemRow[]
}

export type RecipeMenuItemRow = {
  menuItemId: string
  name: string
  categoryName: string
  hasRecipe: boolean
  recipeId: string | null
}

export type RecipeIngredientRow = {
  stockItemId: string
  stockItemName: string
  stockItemUnitId: string
  quantity: number
  unitId: string
  unitLabel: string
}

export type RecipeEditorData = {
  menuItemId: string
  menuItemName: string
  recipeId: string | null
  ingredients: RecipeIngredientRow[]
}

type UnitJoin = { name: string; symbol: string | null } | { name: string; symbol: string | null }[] | null

function unitLabelFromJoin(unit: UnitJoin) {
  const row = Array.isArray(unit) ? unit[0] : unit
  if (!row) return '—'
  return formatMeasurementUnitLabel(row)
}

export async function getInventorySetupOverview(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<InventorySetupData> {
  const [{ data: trackedItems, error: menuItemsError }, { data: recipes, error: recipesError }] =
    await Promise.all([
      supabase
        .from('menu_items')
        .select('id, name')
        .eq('restaurant_id', restaurantId)
        .eq('track_inventory', true)
        .neq('status', 'hidden')
        .order('name'),
      supabase
        .from('recipes')
        .select('id, menu_item_id')
        .eq('restaurant_id', restaurantId)
        .eq('is_active', true),
    ])

  if (menuItemsError) throw menuItemsError
  if (recipesError) throw recipesError

  const recipeByMenuItemId = new Map(
    (recipes ?? []).map((recipe) => [recipe.menu_item_id as string, recipe.id as string]),
  )

  const recipeIds = [...recipeByMenuItemId.values()]
  const ingredientCountByRecipeId = new Map<string, number>()

  if (recipeIds.length > 0) {
    const { data: recipeItems, error: recipeItemsError } = await supabase
      .from('recipe_items')
      .select('recipe_id')
      .in('recipe_id', recipeIds)

    if (recipeItemsError) throw recipeItemsError

    for (const row of recipeItems ?? []) {
      const recipeId = row.recipe_id as string
      ingredientCountByRecipeId.set(recipeId, (ingredientCountByRecipeId.get(recipeId) ?? 0) + 1)
    }
  }

  const readyMenuItemIds: string[] = []
  const missingItems: InventorySetupItemRef[] = []

  for (const item of trackedItems ?? []) {
    const recipeId = recipeByMenuItemId.get(item.id)
    const ingredientCount = recipeId ? (ingredientCountByRecipeId.get(recipeId) ?? 0) : 0
    if (recipeId && ingredientCount >= 1) {
      readyMenuItemIds.push(item.id)
    } else {
      missingItems.push({ menuItemId: item.id, name: item.name })
    }
  }

  // Items whose tracking is switched off but whose recipe is still live. Deduction keys on
  // recipes.is_active alone, so these keep draining stock while reading as untracked
  // everywhere. Surfaced so the badge can say so instead of rendering nothing.
  const trackedIds = new Set((trackedItems ?? []).map((item) => item.id as string))
  const linkedButUntrackedIds: string[] = []
  for (const [menuItemId, recipeId] of recipeByMenuItemId) {
    if (trackedIds.has(menuItemId)) continue
    if ((ingredientCountByRecipeId.get(recipeId) ?? 0) >= 1) {
      linkedButUntrackedIds.push(menuItemId)
    }
  }

  const total = (trackedItems ?? []).length
  const configured = readyMenuItemIds.length

  return {
    total,
    configured,
    missing: missingItems.length,
    missingItems,
    readyMenuItemIds,
    linkedButUntrackedIds,
  }
}

/** Legacy overview — prefer getInventorySetupOverview. */
export async function getRecipesOverview(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<RecipesOverviewData> {
  const setup = await getInventorySetupOverview(supabase, restaurantId)
  const missingIds = new Set(setup.missingItems.map((item) => item.menuItemId))

  const { data: menuItems, error } = await supabase
    .from('menu_items')
    .select('id, name, category_id')
    .eq('restaurant_id', restaurantId)
    .eq('track_inventory', true)
    .neq('status', 'hidden')
    .order('name')

  if (error) throw error

  const categoryIds = [
    ...new Set((menuItems ?? []).map((item) => item.category_id).filter(Boolean)),
  ] as string[]

  const categoryNameById = new Map<string, string>()
  if (categoryIds.length > 0) {
    const { data: categories, error: categoriesError } = await supabase
      .from('menu_categories')
      .select('id, name')
      .in('id', categoryIds)

    if (categoriesError) throw categoriesError
    for (const category of categories ?? []) {
      categoryNameById.set(category.id, category.name)
    }
  }

  const rows: RecipeMenuItemRow[] = (menuItems ?? []).map((item) => ({
    menuItemId: item.id,
    name: item.name,
    categoryName: item.category_id ? (categoryNameById.get(item.category_id) ?? '—') : '—',
    hasRecipe: !missingIds.has(item.id),
    recipeId: null,
  }))

  return {
    withRecipe: setup.configured,
    total: setup.total,
    rows,
  }
}

export async function getRecipeEditorData(
  supabase: SupabaseClient,
  restaurantId: string,
  menuItemId: string,
): Promise<RecipeEditorData | null> {
  const { data: menuItem, error: menuItemError } = await supabase
    .from('menu_items')
    .select('id, name')
    .eq('restaurant_id', restaurantId)
    .eq('id', menuItemId)
    .maybeSingle()

  if (menuItemError) throw menuItemError
  if (!menuItem) return null

  const { data: recipe, error: recipeError } = await supabase
    .from('recipes')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('menu_item_id', menuItemId)
    .eq('is_active', true)
    .maybeSingle()

  if (recipeError) throw recipeError

  if (!recipe) {
    return {
      menuItemId: menuItem.id,
      menuItemName: menuItem.name,
      recipeId: null,
      ingredients: [],
    }
  }

  const { data: recipeItems, error: recipeItemsError } = await supabase
    .from('recipe_items')
    .select(
      'stock_item_id, quantity, unit_id, measurement_units(name, symbol), stock_items!inner(id, name, unit_id)',
    )
    .eq('recipe_id', recipe.id)

  if (recipeItemsError) throw recipeItemsError

  const ingredients: RecipeIngredientRow[] = (recipeItems ?? []).map((row) => {
    const joined = row.stock_items
    const stockItem = Array.isArray(joined) ? joined[0] : joined
    if (!stockItem || typeof stockItem !== 'object') {
      throw new Error('Recipe ingredient is missing its linked stock item.')
    }
    return {
      stockItemId: row.stock_item_id,
      stockItemName: stockItem.name,
      stockItemUnitId: stockItem.unit_id,
      quantity: Number(row.quantity),
      unitId: row.unit_id,
      unitLabel: unitLabelFromJoin(row.measurement_units as UnitJoin),
    }
  })

  return {
    menuItemId: menuItem.id,
    menuItemName: menuItem.name,
    recipeId: recipe.id,
    ingredients,
  }
}
