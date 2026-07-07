import type { OrderAmendedEvent } from '@/lib/events/contracts'
import { handleOrderAmendedInventory } from '@/lib/events/handlers/inventory'
import { handleOrderAmendedKitchenDisplay } from '@/lib/events/handlers/kitchen-display'

type OrderAmendedHandler = (event: OrderAmendedEvent) => void | Promise<void>

const ORDER_AMENDED_HANDLERS: OrderAmendedHandler[] = [
  handleOrderAmendedInventory,
  handleOrderAmendedKitchenDisplay,
]

/**
 * Direct dispatch for order.amended — swap this registry for a real bus later
 * without changing OrderAmendedEvent payload shape.
 */
export async function emitOrderAmended(event: OrderAmendedEvent): Promise<void> {
  await Promise.all(
    ORDER_AMENDED_HANDLERS.map(async (handler) => {
      try {
        await handler(event)
      } catch (error) {
        console.error('[events] order.amended handler failed', {
          handler: handler.name,
          order_id: event.order_id,
          revision_id: event.revision_id,
          error,
        })
      }
    }),
  )
}
