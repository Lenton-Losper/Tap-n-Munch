import type { OrderAmendedEvent } from '@/lib/events/contracts'

/**
 * Kitchen Display extension point for order.amended.
 * Realtime subscriptions on orders already propagate item changes; this
 * handler logs structured KDS notifications until a dedicated bus exists.
 */
export async function handleOrderAmendedKitchenDisplay(event: OrderAmendedEvent): Promise<void> {
  console.info('[kitchen-display] order.amended', {
    order_id: event.order_id,
    revision_number: event.revision_number,
    status: event.order.status,
    item_count: Array.isArray(event.order.items) ? event.order.items.length : 0,
    changes: event.changes.map((change) => ({
      item_id: change.item_id,
      action: change.action,
      quantity_delta: change.quantity_delta,
    })),
  })
}
