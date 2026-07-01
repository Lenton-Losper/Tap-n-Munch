import type { SupabaseClient } from '@supabase/supabase-js'
import {
  movementDateRangeStart,
  type MovementDateRange,
  type MovementReason,
} from '@/lib/stock/format'

export type StockOverviewRow = {
  id: string
  name: string
  base_unit: string
  par_level: number | null
  currentStock: number
  isLow: boolean
}

export type StockOverviewData = {
  trackedItems: number
  lowStock: number
  lastDeliveryAt: string | null
  rows: StockOverviewRow[]
}

export type StockItemOption = {
  id: string
  name: string
  base_unit: string
}

export type MovementHistoryRow = {
  id: string
  itemName: string
  quantityDelta: number
  reason: string
  referenceLabel: string
  createdAt: string
  unitCost: number | null
}

function aggregateStockByItem(
  movements: Array<{ stock_item_id: string; quantity_delta: number | string }> | null,
) {
  const stockByItem = new Map<string, number>()
  for (const movement of movements ?? []) {
    const id = movement.stock_item_id
    const delta = Number(movement.quantity_delta) || 0
    stockByItem.set(id, (stockByItem.get(id) ?? 0) + delta)
  }
  return stockByItem
}

export async function getStockOverview(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<StockOverviewData> {
  const [{ data: items, error: itemsError }, { data: movements, error: movementsError }, { data: lastDelivery, error: lastDeliveryError }] =
    await Promise.all([
      supabase
        .from('stock_items')
        .select('id, name, base_unit, par_level')
        .eq('restaurant_id', restaurantId)
        .eq('is_active', true)
        .order('name'),
      supabase
        .from('stock_movements')
        .select('stock_item_id, quantity_delta')
        .eq('restaurant_id', restaurantId),
      supabase
        .from('goods_received')
        .select('received_at')
        .eq('restaurant_id', restaurantId)
        .order('received_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

  if (itemsError) throw itemsError
  if (movementsError) throw movementsError
  if (lastDeliveryError) throw lastDeliveryError

  const stockByItem = aggregateStockByItem(movements)

  const rows: StockOverviewRow[] = (items ?? []).map((item) => {
    const currentStock = stockByItem.get(item.id) ?? 0
    const parLevel = item.par_level != null ? Number(item.par_level) : null
    return {
      id: item.id,
      name: item.name,
      base_unit: item.base_unit,
      par_level: parLevel,
      currentStock,
      isLow: parLevel != null && currentStock <= parLevel,
    }
  })

  return {
    trackedItems: rows.length,
    lowStock: rows.filter((row) => row.isLow).length,
    lastDeliveryAt: lastDelivery?.received_at ?? null,
    rows,
  }
}

export type StockItemLevel = {
  id: string
  name: string
  base_unit: string
  currentStock: number
}

export async function getStockItemCurrentLevel(
  supabase: SupabaseClient,
  restaurantId: string,
  stockItemId: string,
): Promise<StockItemLevel | null> {
  const [{ data: item, error: itemError }, { data: movements, error: movementsError }] =
    await Promise.all([
      supabase
        .from('stock_items')
        .select('id, name, base_unit')
        .eq('restaurant_id', restaurantId)
        .eq('id', stockItemId)
        .eq('is_active', true)
        .maybeSingle(),
      supabase
        .from('stock_movements')
        .select('quantity_delta')
        .eq('restaurant_id', restaurantId)
        .eq('stock_item_id', stockItemId),
    ])

  if (itemError) throw itemError
  if (movementsError) throw movementsError
  if (!item) return null

  const currentStock = (movements ?? []).reduce(
    (sum, movement) => sum + (Number(movement.quantity_delta) || 0),
    0,
  )

  return {
    id: item.id,
    name: item.name,
    base_unit: item.base_unit,
    currentStock,
  }
}

export async function getActiveStockItems(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<StockItemOption[]> {
  const { data, error } = await supabase
    .from('stock_items')
    .select('id, name, base_unit')
    .eq('restaurant_id', restaurantId)
    .eq('is_active', true)
    .order('name')

  if (error) throw error
  return (data ?? []) as StockItemOption[]
}

export type MovementHistoryFilters = {
  stockItemId?: string
  reason?: MovementReason | 'all'
  dateRange?: MovementDateRange
  includeCosts?: boolean
}

export async function getMovementHistory(
  supabase: SupabaseClient,
  restaurantId: string,
  filters: MovementHistoryFilters = {},
): Promise<MovementHistoryRow[]> {
  const dateRange = filters.dateRange ?? '30d'
  const rangeStart = movementDateRangeStart(dateRange)

  let query = supabase
    .from('stock_movements')
    .select('id, stock_item_id, quantity_delta, reason, reference_type, reference_id, created_at')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false })

  if (filters.stockItemId && filters.stockItemId !== 'all') {
    query = query.eq('stock_item_id', filters.stockItemId)
  }

  if (filters.reason && filters.reason !== 'all') {
    query = query.eq('reason', filters.reason)
  }

  if (rangeStart) {
    query = query.gte('created_at', rangeStart)
  }

  const { data: movements, error: movementsError } = await query
  if (movementsError) throw movementsError
  if (!movements?.length) return []

  const stockItemIds = [...new Set(movements.map((movement) => movement.stock_item_id))]
  const { data: stockItems, error: stockItemsError } = await supabase
    .from('stock_items')
    .select('id, name')
    .in('id', stockItemIds)

  if (stockItemsError) throw stockItemsError
  const itemNameById = new Map((stockItems ?? []).map((item) => [item.id, item.name]))

  const lineItemIds = movements
    .filter((movement) => movement.reference_type === 'goods_received_items' && movement.reference_id)
    .map((movement) => movement.reference_id as string)

  const grvNumberByLineItemId = new Map<string, string>()
  const unitCostByLineItemId = new Map<string, number | null>()
  if (lineItemIds.length > 0) {
    type GrvLineItemBase = { id: string; goods_received_id: string }
    type GrvLineItemWithCost = GrvLineItemBase & {
      unit_cost: number | string | null
    }

    let lineItems: GrvLineItemBase[] = []

    if (filters.includeCosts) {
      const { data, error: lineItemsError } = await supabase
        .from('goods_received_items')
        .select('id, goods_received_id, unit_cost')
        .in('id', lineItemIds)

      if (lineItemsError) throw lineItemsError

      for (const row of (data ?? []) as GrvLineItemWithCost[]) {
        const cost = row.unit_cost
        unitCostByLineItemId.set(
          row.id,
          cost != null && cost !== '' ? Number(cost) : null,
        )
      }
      lineItems = (data ?? []) as GrvLineItemBase[]
    } else {
      const { data, error: lineItemsError } = await supabase
        .from('goods_received_items')
        .select('id, goods_received_id')
        .in('id', lineItemIds)

      if (lineItemsError) throw lineItemsError
      lineItems = data ?? []
    }

    const goodsReceivedIds = [...new Set(lineItems.map((row) => row.goods_received_id))]
    const lineItemToGrvId = new Map(lineItems.map((row) => [row.id, row.goods_received_id]))

    if (goodsReceivedIds.length > 0) {
      const { data: headers, error: headersError } = await supabase
        .from('goods_received')
        .select('id, grv_number')
        .in('id', goodsReceivedIds)

      if (headersError) throw headersError
      const grvNumberById = new Map(
        (headers ?? []).map((header) => [header.id, header.grv_number || '—']),
      )

      for (const lineItemId of lineItemIds) {
        const grvId = lineItemToGrvId.get(lineItemId)
        if (grvId) {
          grvNumberByLineItemId.set(lineItemId, grvNumberById.get(grvId) ?? '—')
        }
      }
    }
  }

  return movements.map((movement) => {
    const referenceLabel =
      movement.reference_type === 'goods_received_items' && movement.reference_id
        ? grvNumberByLineItemId.get(movement.reference_id) ?? '—'
        : 'Manual'

    return {
      id: movement.id,
      itemName: itemNameById.get(movement.stock_item_id) ?? 'Unknown item',
      quantityDelta: Number(movement.quantity_delta) || 0,
      reason: movement.reason,
      referenceLabel,
      createdAt: movement.created_at,
      unitCost:
        filters.includeCosts &&
        movement.reference_type === 'goods_received_items' &&
        movement.reference_id
          ? (unitCostByLineItemId.get(movement.reference_id) ?? null)
          : null,
    }
  })
}
