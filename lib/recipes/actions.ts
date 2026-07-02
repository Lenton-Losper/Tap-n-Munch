'use server'

import { revalidatePath } from 'next/cache'
import { PERMISSIONS } from '@/lib/permissions'
import { requireRecipePermissionOrError } from '@/lib/recipes/auth'

export type RecipeIngredientInput = {
  stockItemId: string
  quantity: number
  unitId: string
}

export type SaveRecipeInput = {
  menuItemId: string
  ingredients: RecipeIngredientInput[]
}

export async function saveRecipeAction(input: SaveRecipeInput) {
  const menuItemId = input.menuItemId.trim()
  if (!menuItemId) {
    return { error: 'Menu item is required.' }
  }

  const ingredients = input.ingredients
    .map((row) => ({
      stockItemId: row.stockItemId.trim(),
      quantity: Number(row.quantity),
      unitId: row.unitId.trim(),
    }))
    .filter((row) => row.stockItemId && row.unitId && Number.isFinite(row.quantity) && row.quantity > 0)

  const context = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_EDIT)
  if ('error' in context) {
    return { error: context.error }
  }
  const { supabase, restaurantId } = context

  const { data: menuItem, error: menuItemError } = await supabase
    .from('menu_items')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('id', menuItemId)
    .maybeSingle()

  if (menuItemError) {
    return { error: menuItemError.message }
  }
  if (!menuItem) {
    return { error: 'Menu item not found.' }
  }

  const { data: existingRecipe, error: existingRecipeError } = await supabase
    .from('recipes')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('menu_item_id', menuItemId)
    .maybeSingle()

  if (existingRecipeError) {
    return { error: existingRecipeError.message }
  }

  let recipeId = existingRecipe?.id as string | undefined

  if (!recipeId) {
    const { data: createdRecipe, error: createRecipeError } = await supabase
      .from('recipes')
      .insert({
        restaurant_id: restaurantId,
        menu_item_id: menuItemId,
        is_active: true,
      })
      .select('id')
      .single()

    if (createRecipeError || !createdRecipe) {
      return { error: createRecipeError?.message ?? 'Failed to create recipe.' }
    }
    recipeId = createdRecipe.id
  } else {
    const { error: updateRecipeError } = await supabase
      .from('recipes')
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq('id', recipeId)

    if (updateRecipeError) {
      return { error: updateRecipeError.message }
    }
  }

  const { error: deleteItemsError } = await supabase
    .from('recipe_items')
    .delete()
    .eq('recipe_id', recipeId)

  if (deleteItemsError) {
    return { error: deleteItemsError.message }
  }

  if (ingredients.length > 0) {
    const { error: insertItemsError } = await supabase.from('recipe_items').insert(
      ingredients.map((row) => ({
        recipe_id: recipeId,
        stock_item_id: row.stockItemId,
        quantity: row.quantity,
        unit_id: row.unitId,
      })),
    )

    if (insertItemsError) {
      return { error: insertItemsError.message }
    }
  }

  revalidatePath('/stock/recipes')
  revalidatePath(`/stock/recipes/${menuItemId}`)
  revalidatePath('/menu-management')

  return { data: { recipeId, ingredientCount: ingredients.length } }
}

export async function loadMenuItemInventoryAction(menuItemId: string) {
  const id = menuItemId.trim()
  if (!id) {
    return { error: 'Menu item is required.' }
  }

  const context = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_VIEW)
  if ('error' in context) {
    return { error: context.error }
  }

  const { getMeasurementUnitsForRestaurant } = await import('@/lib/measurement-units/queries')
  const { getActiveStockItemsWithLevels } = await import('@/lib/stock/queries')
  const { getRecipeEditorData } = await import('@/lib/recipes/queries')

  try {
    const [editorData, stockItems, measurementUnits] = await Promise.all([
      getRecipeEditorData(context.supabase, context.restaurantId, id),
      getActiveStockItemsWithLevels(context.supabase, context.restaurantId),
      getMeasurementUnitsForRestaurant(context.supabase, context.restaurantId),
    ])

    if (!editorData) {
      return { error: 'Menu item not found.' }
    }

    return {
      data: {
        menuItemId: editorData.menuItemId,
        ingredients: editorData.ingredients,
        hasInventory: editorData.ingredients.length > 0 || editorData.recipeId != null,
        stockItems,
        measurementUnits,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load inventory.'
    return { error: message }
  }
}

export async function canEditMenuInventoryAction(): Promise<{ canEdit: boolean }> {
  const context = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_EDIT)
  return { canEdit: !('error' in context) }
}

export async function loadInventoryPickerAction() {
  const context = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_EDIT)
  if ('error' in context) {
    return { error: context.error }
  }

  const { getMeasurementUnitsForRestaurant } = await import('@/lib/measurement-units/queries')
  const { getActiveStockItemsWithLevels } = await import('@/lib/stock/queries')

  try {
    const [stockItems, measurementUnits] = await Promise.all([
      getActiveStockItemsWithLevels(context.supabase, context.restaurantId),
      getMeasurementUnitsForRestaurant(context.supabase, context.restaurantId),
    ])
    return { data: { stockItems, measurementUnits } }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load inventory picker.'
    return { error: message }
  }
}
