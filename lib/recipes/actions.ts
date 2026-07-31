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

  const ingredients = input.ingredients.map((row) => ({
    stockItemId: row.stockItemId.trim(),
    quantity: Number(row.quantity),
    unitId: row.unitId.trim(),
  }))

  const invalidRow = ingredients.find(
    (row) => !row.stockItemId || !row.unitId || !Number.isFinite(row.quantity) || row.quantity <= 0
  )
  if (invalidRow) {
    return { error: 'One or more ingredient rows are incomplete or invalid — every linked ingredient needs a stock item, unit, and quantity greater than zero.' }
  }

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

    // Mark the menu item as tracked in the same operation that links it.
    //
    // Every "is this tracked?" surface reads menu_items.track_inventory --
    // getInventorySetupOverview lists only items where it is true, and
    // loadMenuItemInventoryAction derives hasInventory/trackInventory from it. Writing the
    // recipe without it meant a link made from the Stock -> Recipes editor persisted
    // perfectly, reported "Recipe saved.", and left the item reading as untracked with no
    // way for the merchant to tell the link had worked.
    //
    // This one write MUST use the service-role client, not `supabase` above. That client is
    // user-scoped (role `authenticated`), and migration 20260705200000 deliberately revokes
    // INSERT/UPDATE/DELETE on menu_items from `authenticated` -- "staff mutations go through
    // service_role API routes only". Using the request client here returns 42501 permission
    // denied AFTER the recipe rows are already written, turning a wrong-status bug into a
    // partial save. Authorisation is not weakened: requireRecipePermissionOrError has already
    // established RECIPE_EDIT for this restaurant, and the update is scoped to that
    // restaurant and menu item.
    //
    // Safe to force true here: the menu item form only calls this action when its own
    // tracking toggle is already on, so this cannot override a merchant turning tracking
    // off. Deliberately NOT set back to false when ingredients are empty -- "tracked but not
    // yet configured" is a state the overview models explicitly via missingItems.
    const { createServerSupabaseClient } = await import('@/lib/supabase/server')
    const { error: trackError } = await createServerSupabaseClient()
      .from('menu_items')
      .update({ track_inventory: true })
      .eq('restaurant_id', restaurantId)
      .eq('id', menuItemId)

    if (trackError) {
      return { error: trackError.message }
    }
  }

  revalidatePath('/stock/recipes')
  revalidatePath(`/stock/recipes/${menuItemId}`)
  revalidatePath('/menu-management')

  return { data: { recipeId, ingredientCount: ingredients.length } }
}

export async function canEditMenuInventoryAction() {
  const context = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_EDIT)
  return { canEdit: !('error' in context) }
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
    const [editorData, stockItems, measurementUnits, menuItemRow] = await Promise.all([
      getRecipeEditorData(context.supabase, context.restaurantId, id),
      getActiveStockItemsWithLevels(context.supabase, context.restaurantId),
      getMeasurementUnitsForRestaurant(context.supabase, context.restaurantId),
      context.supabase
        .from('menu_items')
        .select('track_inventory')
        .eq('restaurant_id', context.restaurantId)
        .eq('id', id)
        .maybeSingle(),
    ])

    if (!editorData) {
      return { error: 'Menu item not found.' }
    }

    const trackInventoryFlag = Boolean(menuItemRow.data?.track_inventory)

    return {
      data: {
        menuItemId: editorData.menuItemId,
        ingredients: editorData.ingredients,
        hasInventory: trackInventoryFlag,
        trackInventory: trackInventoryFlag,
        stockItems,
        measurementUnits,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load inventory.'
    return { error: message }
  }
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

export async function loadInventorySetupAction() {
  const context = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_VIEW)
  if ('error' in context) {
    return { error: context.error }
  }

  const { getInventorySetupOverview } = await import('@/lib/recipes/queries')

  try {
    const data = await getInventorySetupOverview(context.supabase, context.restaurantId)
    return { data }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load inventory setup.'
    return { error: message }
  }
}
