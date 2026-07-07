import type { SupabaseClient } from '@supabase/supabase-js'
import type { PaymentCompletedEvent } from '@/lib/events/contracts'
import {
  buildCheckoutInvoiceIdempotencyKey,
  requestInvoice,
} from '@/lib/invoices/request-invoice'
import { handlePaymentCompletedInvoice } from '@/lib/events/handlers/payment-completed-invoice'

type PaymentCompletedHandler = (
  event: PaymentCompletedEvent,
  supabase: SupabaseClient,
) => void | Promise<void>

const PAYMENT_COMPLETED_HANDLERS: PaymentCompletedHandler[] = [handlePaymentCompletedInvoice]

export async function emitPaymentCompleted(
  event: PaymentCompletedEvent,
  supabase: SupabaseClient,
): Promise<void> {
  await Promise.all(
    PAYMENT_COMPLETED_HANDLERS.map(async (handler) => {
      try {
        await handler(event, supabase)
      } catch (error) {
        console.error('[events] payment.completed handler failed', {
          handler: handler.name,
          order_id: event.order_id,
          error,
        })
      }
    }),
  )
}

export { buildCheckoutInvoiceIdempotencyKey, requestInvoice }
