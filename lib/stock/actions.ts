'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireStockOwner } from '@/lib/stock/auth'

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

  const { supabase, restaurantId } = await requireStockOwner()

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

  const { supabase, userId, restaurantId } = await requireStockOwner()

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
    unit_cost: row.unitCost ?? null,
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
