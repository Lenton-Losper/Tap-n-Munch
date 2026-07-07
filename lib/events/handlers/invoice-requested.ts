import type { InvoiceRequestedEvent } from '@/lib/events/contracts'

/**
 * Extension point for invoice.requested — generation is scheduled by requestInvoice().
 */
export async function handleInvoiceRequested(event: InvoiceRequestedEvent): Promise<void> {
  console.info('[invoices] invoice.requested', {
    invoice_request_id: event.invoice_request_id,
    order_id: event.order_id,
    source: event.source,
    is_resend: event.is_resend,
  })
}
