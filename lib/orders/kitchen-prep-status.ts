import { isKitchenRoutedItem, type OrderLineItem } from '@/lib/orders/order-line-item'

export type OrderPrepContext = {
  status?: string | null
  preparing_at?: string | null
  accepted_at?: string | null
}

const PREP_STARTED_STATUSES = new Set(['preparing', 'ready', 'ready_for_terminal', 'completed', 'served'])

/**
 * Whether kitchen preparation has started for a specific line item.
 *
 * There is no dedicated order_items table or per-line KDS status column today.
 * Line items live in orders.items JSONB. The closest existing signals are:
 *   - item.preparation_started_at (optional JSON field — not yet written by order flow)
 *   - order.preparing_at + kitchen-routed items (order-level kitchen start)
 */
export function hasLineItemPreparationStarted(
  order: OrderPrepContext,
  lineItem: OrderLineItem,
): boolean {
  const itemPrepAt = String(lineItem.preparation_started_at || '').trim()
  if (itemPrepAt) return true

  if (!isKitchenRoutedItem(lineItem)) {
    return false
  }

  const preparingAt = String(order.preparing_at || '').trim()
  if (preparingAt) return true

  const status = String(order.status || '').trim().toLowerCase()
  return PREP_STARTED_STATUSES.has(status)
}
