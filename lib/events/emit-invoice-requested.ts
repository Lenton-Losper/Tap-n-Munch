import type { InvoiceRequestedEvent } from '@/lib/events/contracts'
import { handleInvoiceRequested } from '@/lib/events/handlers/invoice-requested'

type InvoiceRequestedHandler = (event: InvoiceRequestedEvent) => void | Promise<void>

const INVOICE_REQUESTED_HANDLERS: InvoiceRequestedHandler[] = [handleInvoiceRequested]

export async function emitInvoiceRequested(event: InvoiceRequestedEvent): Promise<void> {
  await Promise.all(
    INVOICE_REQUESTED_HANDLERS.map(async (handler) => {
      try {
        await handler(event)
      } catch (error) {
        console.error('[events] invoice.requested handler failed', {
          handler: handler.name,
          invoice_request_id: event.invoice_request_id,
          error,
        })
      }
    }),
  )
}
