import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getLineQuantity,
  getMenuItemId,
  type OrderLineItem,
} from '@/lib/orders/order-line-item'
import type { StockAction } from '@/lib/orders/amend-types'

type RecipeIngredient = {
  stock_item_id: string
  quantity: number | string
}

async function loadRecipeIngredients(
  supabase: SupabaseClient,
  restaurantId: string,
  menuItemId: string,
): Promise<RecipeIngredient[]> {
  const { data: recipe, error: recipeError } = await supabase
    .from('recipes')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('menu_item_id', menuItemId)
    .eq('is_active', true)
    .maybeSingle()

  if (recipeError) throw recipeError
  if (!recipe?.id) return []

  const { data: recipeItems, error: itemsError } = await supabase
    .from('recipe_items')
    .select('stock_item_id, quantity')
    .eq('recipe_id', recipe.id)

  if (itemsError) throw itemsError
  return (recipeItems ?? []) as RecipeIngredient[]
}

async function orderHasSaleMovements(
  supabase: SupabaseClient,
  orderId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('stock_movements')
    .select('id', { count: 'exact', head: true })
    .eq('reference_type', 'order')
    .eq('reference_id', orderId)
    .eq('reason', 'sale')

  if (error) throw error
  return (count ?? 0) > 0
}

export async function applyAmendmentStockEffects(input: {
  supabase: SupabaseClient
  restaurantId: string
  orderId: string
  revisionId: string
  lineItem: OrderLineItem
  reducedQuantity: number
  stockAction: StockAction
  createdBy: string | null
  notes: string
}): Promise<void> {
  const {
    supabase,
    restaurantId,
    orderId,
    revisionId,
    lineItem,
    reducedQuantity,
    stockAction,
    createdBy,
    notes,
  } = input

  if (stockAction === 'none' || reducedQuantity <= 0) {
    return
  }

  const menuItemId = getMenuItemId(lineItem)
  if (!menuItemId) return

  const ingredients = await loadRecipeIngredients(supabase, restaurantId, menuItemId)
  if (ingredients.length === 0) return

  const saleAlreadyDeducted = await orderHasSaleMovements(supabase, orderId)

  const rows = ingredients.map((ingredient) => {
    const perUnit = Number(ingredient.quantity)
    const delta = perUnit * reducedQuantity
    if (!Number.isFinite(delta) || delta <= 0) return null

    if (stockAction === 'reversed') {
      if (!saleAlreadyDeducted) {
        return null
      }
      return {
        restaurant_id: restaurantId,
        stock_item_id: ingredient.stock_item_id,
        quantity_delta: delta,
        reason: 'adjustment',
        adjustment_type: 'sale',
        reference_type: 'order_revision',
        reference_id: revisionId,
        created_by: createdBy,
        notes,
      }
    }

    return {
      restaurant_id: restaurantId,
      stock_item_id: ingredient.stock_item_id,
      quantity_delta: -delta,
      reason: 'adjustment',
      adjustment_type: 'waste',
      reference_type: 'order_revision',
      reference_id: revisionId,
      created_by: createdBy,
      notes,
    }
  }).filter(Boolean)

  if (rows.length === 0) return

  const { error } = await supabase.from('stock_movements').insert(rows)
  if (error) throw error
}

export function resolveReducedQuantity(
  action: string,
  lineItem: OrderLineItem,
  quantityDelta: number,
): number {
  if (action === 'removed') {
    return getLineQuantity(lineItem)
  }
  if (action === 'quantity_changed' && quantityDelta < 0) {
    return Math.min(getLineQuantity(lineItem), Math.abs(quantityDelta))
  }
  return 0
}
