import { createServerSupabaseClient } from '@/lib/supabase/server'
import type { InvoiceGeneratedEvent } from '@/lib/events/contracts'
import { sendInvoiceEmail } from '@/lib/invoices/send-invoice-email'

const INVOICE_BUCKET = process.env.SUPABASE_INVOICE_BUCKET || process.env.SUPABASE_STORAGE_BUCKET || 'menu-images'

/**
 * Delivers a generated tax invoice PDF to the customer when status is sent.
 */
export async function handleInvoiceGeneratedDelivery(event: InvoiceGeneratedEvent): Promise<void> {
  if (event.status !== 'sent') return

  let pdfBytes: Uint8Array

  if (process.env.INVOICE_SKIP_STORAGE === 'true') {
    console.info('[invoices] skip storage download (test mode)', {
      invoice_request_id: event.invoice_request_id,
    })
    return
  }

  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase.storage.from(INVOICE_BUCKET).download(event.pdf_storage_path)

  if (error || !data) {
    throw new Error(error?.message || 'Failed to download generated invoice PDF')
  }

  pdfBytes = new Uint8Array(await data.arrayBuffer())

  await sendInvoiceEmail({
    to: event.email,
    restaurantName: event.restaurant_name,
    invoiceNumber: event.invoice_number,
    pdfBytes,
  })
}
