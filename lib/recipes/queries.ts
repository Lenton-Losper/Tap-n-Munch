import type { SupabaseClient } from '@supabase/supabase-js'
import { formatMeasurementUnitLabel } from '@/lib/measurement-units/format'

export type RecipeMenuItemRow = {
  menuItemId: string
  name: string
  categoryName: string
  hasRecipe: boolean
  recipeId: string | null
}

export type RecipesOverviewData = {
  withRecipe: number
  total: number
  rows: RecipeMenuItemRow[]
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

export async function getRecipesOverview(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<RecipesOverviewData> {
  const [{ data: menuItems, error: menuItemsError }, { data: recipes, error: recipesError }] =
    await Promise.all([
      supabase
        .from('menu_items')
        .select('id, name, category_id')
        .eq('restaurant_id', restaurantId)
        .eq('status', 'active')
        .order('name'),
      supabase
        .from('recipes')
        .select('id, menu_item_id')
        .eq('restaurant_id', restaurantId)
        .eq('is_active', true),
    ])

  if (menuItemsError) throw menuItemsError
  if (recipesError) throw recipesError

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

  const recipeByMenuItemId = new Map(
    (recipes ?? []).map((recipe) => [recipe.menu_item_id as string, recipe.id as string]),
  )

  const rows: RecipeMenuItemRow[] = (menuItems ?? []).map((item) => ({
    menuItemId: item.id,
    name: item.name,
    categoryName: item.category_id ? (categoryNameById.get(item.category_id) ?? '—') : '—',
    hasRecipe: recipeByMenuItemId.has(item.id),
    recipeId: recipeByMenuItemId.get(item.id) ?? null,
  }))

  return {
    withRecipe: rows.filter((row) => row.hasRecipe).length,
    total: rows.length,
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
    .eq('status', 'active')
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
