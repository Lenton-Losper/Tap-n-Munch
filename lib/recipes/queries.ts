import type { SupabaseClient } from '@supabase/supabase-js'

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
  baseUnit: string
  quantity: number
  unit: string | null
}

export type RecipeEditorData = {
  menuItemId: string
  menuItemName: string
  recipeId: string | null
  ingredients: RecipeIngredientRow[]
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
    .select('stock_item_id, quantity, unit, stock_items!inner(id, name, base_unit)')
    .eq('recipe_id', recipe.id)

  if (recipeItemsError) throw recipeItemsError

  const ingredients: RecipeIngredientRow[] = (recipeItems ?? []).map((row) => {
    const stockItem = row.stock_items as { id: string; name: string; base_unit: string }
    return {
      stockItemId: row.stock_item_id,
      stockItemName: stockItem.name,
      baseUnit: stockItem.base_unit,
      quantity: Number(row.quantity),
      unit: row.unit,
    }
  })

  return {
    menuItemId: menuItem.id,
    menuItemName: menuItem.name,
    recipeId: recipe.id,
    ingredients,
  }
}
