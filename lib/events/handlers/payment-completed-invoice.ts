import type { SupabaseClient } from '@supabase/supabase-js'
import type { PaymentCompletedEvent } from '@/lib/events/contracts'
import { activatePendingInvoiceRequestOnPayment } from '@/lib/invoices/checkout-invoice-request'

export async function handlePaymentCompletedInvoice(
  event: PaymentCompletedEvent,
  supabase: SupabaseClient,
): Promise<void> {
  if (!event.invoice_requested) {
    return
  }

  await activatePendingInvoiceRequestOnPayment(supabase, {
    orderId: event.order_id,
    restaurantId: event.restaurant_id,
    paymentId: event.payment_id ?? null,
    paymentReference: event.payment_reference ?? null,
    fallbackDetails: event.invoice_details,
  })
}
