'use server'

import { revalidatePath } from 'next/cache'
import { requireStockPermissionOrError } from '@/lib/stock/auth'
import { requireRecipePermissionOrError } from '@/lib/recipes/auth'
import { PERMISSIONS } from '@/lib/permissions'

export async function createMeasurementUnitAction(input: { name: string; symbol?: string | null }) {
  const name = input.name.trim()
  const symbol = input.symbol?.trim() || null

  if (!name) {
    return { error: 'Unit name is required.' }
  }

  const stockContext = await requireStockPermissionOrError(PERMISSIONS.STOCK_RECEIVE)
  let supabase
  let restaurantId
  if ('error' in stockContext) {
    const recipeContext = await requireRecipePermissionOrError(PERMISSIONS.RECIPE_EDIT)
    if ('error' in recipeContext) {
      return { error: stockContext.error }
    }
    supabase = recipeContext.supabase
    restaurantId = recipeContext.restaurantId
  } else {
    supabase = stockContext.supabase
    restaurantId = stockContext.restaurantId
  }

  const { data, error } = await supabase
    .from('measurement_units')
    .insert({
      restaurant_id: restaurantId,
      name,
      symbol,
      is_system: false,
    })
    .select('id, name, symbol, is_system')
    .single()

  if (error) {
    return { error: error.message }
  }

  revalidatePath('/stock')
  revalidatePath('/stock/receive')
  revalidatePath('/stock/recipes')

  return { data }
}
