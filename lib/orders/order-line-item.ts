import { normalizeRouteTo, type OrderRouteTo } from '@/lib/order-routing'

export type OrderLineItem = {
  id?: string
  line_id?: string
  item_id?: string
  menu_item_id?: string
  menuItemId?: string
  name?: string
  displayName?: string
  quantity?: number
  subtotal?: number
  basePrice?: number
  base_price?: number
  route_to?: OrderRouteTo
  preparation_started_at?: string | null
  discount?: number
  [key: string]: unknown
}

export function getLineItemId(item: OrderLineItem): string {
  return String(item.id || item.line_id || item.item_id || '').trim()
}

export function getMenuItemId(item: OrderLineItem): string {
  return String(item.menuItemId || item.menu_item_id || item.item_id || '').trim()
}

export function getLineQuantity(item: OrderLineItem): number {
  const qty = Number(item.quantity)
  return Number.isFinite(qty) && qty > 0 ? qty : 0
}

export function getLineSubtotal(item: OrderLineItem): number {
  const subtotal = Number(item.subtotal)
  if (Number.isFinite(subtotal)) return subtotal
  const qty = getLineQuantity(item)
  const unit = Number(item.basePrice ?? item.base_price)
  return Number.isFinite(unit) ? qty * unit : 0
}

export function findLineItemIndex(items: OrderLineItem[], itemId: string): number {
  const trimmed = String(itemId || '').trim()
  if (!trimmed) return -1

  const byLineId = items.findIndex((item) => getLineItemId(item) === trimmed)
  if (byLineId >= 0) return byLineId

  return items.findIndex((item) => getMenuItemId(item) === trimmed)
}

export function orderItemsSubtotal(items: OrderLineItem[]): number {
  return items.reduce((sum, item) => sum + getLineSubtotal(item), 0)
}

export function isKitchenRoutedItem(item: OrderLineItem): boolean {
  const route = normalizeRouteTo(item.route_to)
  return route === 'kitchen' || route === 'both'
}
