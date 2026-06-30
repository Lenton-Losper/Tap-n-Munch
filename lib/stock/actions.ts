'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { PERMISSIONS } from '@/lib/permissions'
import { authorize } from '@/lib/permissions/authorize'
import { requireStockPermissionOrError } from '@/lib/stock/auth'
import { ADJUSTMENT_TYPES, type AdjustmentType } from '@/lib/stock/format'
import { getStockItemCurrentLevel } from '@/lib/stock/queries'

export type GrvLineItemInput = {
  stockItemId: string
  quantity: number
  unitCost?: number | null
}

export type SaveGrvInput = {
  supplier: string
  invoiceNumber: string
  lineItems: GrvLineItemInput[]
}

export async function createStockItemAction(input: { name: string; baseUnit: string }) {
  const name = input.name.trim()
  const baseUnit = input.baseUnit.trim()

  if (!name || !baseUnit) {
    return { error: 'Name and base unit are required.' }
  }

  const context = await requireStockPermissionOrError(PERMISSIONS.STOCK_RECEIVE)
  if ('error' in context) {
    return { error: context.error }
  }
  const { supabase, restaurantId } = context

  const { data, error } = await supabase
    .from('stock_items')
    .insert({
      restaurant_id: restaurantId,
      name,
      base_unit: baseUnit,
      is_purchasable: true,
      is_manufactured: false,
      is_active: true,
    })
    .select('id, name, base_unit')
    .single()

  if (error) {
    return { error: error.message }
  }

  revalidatePath('/stock')
  revalidatePath('/stock/receive')
  revalidatePath('/stock/history')

  return { data }
}

export async function saveGrvAction(input: SaveGrvInput) {
  const supplier = input.supplier.trim()
  const invoiceNumber = input.invoiceNumber.trim()
  const lineItems = input.lineItems.filter(
    (row) => row.stockItemId && Number(row.quantity) > 0,
  )

  if (!supplier) {
    return { error: 'Supplier is required.' }
  }

  if (lineItems.length === 0) {
    return { error: 'Add at least one item with a quantity greater than zero.' }
  }

  const context = await requireStockPermissionOrError(PERMISSIONS.STOCK_RECEIVE)
  if ('error' in context) {
    return { error: context.error }
  }
  const { supabase, userId, restaurantId } = context

  const canViewCosts = await authorize(userId, restaurantId, PERMISSIONS.STOCK_VIEW_COSTS)

  const { data: header, error: headerError } = await supabase
    .from('goods_received')
    .insert({
      restaurant_id: restaurantId,
      supplier,
      invoice_number: invoiceNumber || null,
      received_by: userId,
      received_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (headerError || !header) {
    return { error: headerError?.message ?? 'Failed to create goods received record.' }
  }

  const itemRows = lineItems.map((row) => ({
    goods_received_id: header.id,
    stock_item_id: row.stockItemId,
    quantity: row.quantity,
    unit_cost: canViewCosts ? (row.unitCost ?? null) : null,
  }))

  const { error: itemsError } = await supabase.from('goods_received_items').insert(itemRows)

  if (itemsError) {
    await supabase.from('goods_received').delete().eq('id', header.id)
    return { error: itemsError.message }
  }

  revalidatePath('/stock')
  revalidatePath('/stock/history')

  redirect(`/stock?received=${lineItems.length}`)
}

const ADJUSTMENT_TYPE_VALUES = new Set<string>(ADJUSTMENT_TYPES.map((option) => option.value))

export async function getStockItemLevelAction(stockItemId: string) {
  const id = stockItemId.trim()
  if (!id) {
    return { error: 'Stock item is required.' }
  }

  const context = await requireStockPermissionOrError(PERMISSIONS.STOCK_ADJUST)
  if ('error' in context) {
    return { error: context.error }
  }
  const { supabase, restaurantId } = context

  try {
    const level = await getStockItemCurrentLevel(supabase, restaurantId, id)
    if (!level) {
      return { error: 'Stock item not found.' }
    }
    return { data: level }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load stock level.'
    return { error: message }
  }
}

export type SaveAdjustmentInput = {
  stockItemId: string
  adjustmentType: AdjustmentType
  quantityDelta: number
  notes?: string
}

export async function saveAdjustmentAction(input: SaveAdjustmentInput) {
  const stockItemId = input.stockItemId.trim()
  const notes = input.notes?.trim() ?? ''
  const quantityDelta = Number(input.quantityDelta)

  if (!stockItemId) {
    return { error: 'Stock item is required.' }
  }

  if (!ADJUSTMENT_TYPE_VALUES.has(input.adjustmentType)) {
    return { error: 'Select a valid adjustment reason.' }
  }

  if (!Number.isFinite(quantityDelta) || quantityDelta === 0) {
    return { error: 'Enter a non-zero quantity change.' }
  }

  const context = await requireStockPermissionOrError(PERMISSIONS.STOCK_ADJUST)
  if ('error' in context) {
    return { error: context.error }
  }
  const { supabase, userId, restaurantId } = context

  const level = await getStockItemCurrentLevel(supabase, restaurantId, stockItemId)
  if (!level) {
    return { error: 'Stock item not found.' }
  }

  const { error } = await supabase.from('stock_movements').insert({
    restaurant_id: restaurantId,
    stock_item_id: stockItemId,
    quantity_delta: quantityDelta,
    reason: 'adjustment',
    adjustment_type: input.adjustmentType,
    created_by: userId,
    notes: notes || null,
  })

  if (error) {
    return { error: error.message }
  }

  const newBalance = level.currentStock + quantityDelta

  revalidatePath('/stock')
  revalidatePath('/stock/history')

  return {
    data: {
      newBalance,
      baseUnit: level.base_unit,
      itemName: level.name,
    },
  }
}
