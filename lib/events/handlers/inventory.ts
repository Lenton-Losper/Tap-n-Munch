import type { OrderAmendedEvent } from '@/lib/events/contracts'

/**
 * Inventory-side effects for order.amended.
 * Stock movements are written during amendOrder(); this handler is the
 * extension point for cache invalidation or downstream inventory sync.
 */
export async function handleOrderAmendedInventory(event: OrderAmendedEvent): Promise<void> {
  const stockChanges = event.changes.filter(
    (change) => change.stock_action === 'reversed' || change.stock_action === 'waste',
  )

  if (stockChanges.length === 0) {
    return
  }

  console.info('[inventory] order.amended stock effects recorded', {
    order_id: event.order_id,
    revision_number: event.revision_number,
    stock_changes: stockChanges.map((change) => ({
      item_id: change.item_id,
      stock_action: change.stock_action,
      quantity_delta: change.quantity_delta,
    })),
  })
}
