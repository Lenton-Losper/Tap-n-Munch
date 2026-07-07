import type { InvoiceGeneratedEvent } from '@/lib/events/contracts'
import { handleInvoiceGeneratedDelivery } from '@/lib/events/handlers/invoice-generated-delivery'

type InvoiceGeneratedHandler = (event: InvoiceGeneratedEvent) => void | Promise<void>

const INVOICE_GENERATED_HANDLERS: InvoiceGeneratedHandler[] = [handleInvoiceGeneratedDelivery]

export async function emitInvoiceGenerated(event: InvoiceGeneratedEvent): Promise<void> {
  await Promise.all(
    INVOICE_GENERATED_HANDLERS.map(async (handler) => {
      try {
        await handler(event)
      } catch (error) {
        console.error('[events] invoice.generated handler failed', {
          handler: handler.name,
          invoice_request_id: event.invoice_request_id,
          error,
        })
      }
    }),
  )
}
