import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getResend } from '@/lib/email/resend'
import { renderReceiptHtml } from '@/lib/receipts/renderers/htmlRenderer'
import { renderReceiptPdf } from '@/lib/receipts/renderers/pdfRenderer'
import type { ReceiptDocument, ReceiptSnapshot } from '@/lib/receipts/issueReceipt'

const PROVIDER = 'resend'

export interface SendReceiptEmailResult {
  deliveryId: string
  status: 'sent' | 'failed'
  errorMessage: string | null
}

/**
 * Sends the receipt as HTML via Resend and logs the attempt to receipt_deliveries --
 * same append-only pattern as PRINT attempts (attempt_number is server-derived, a retry
 * is always a new row, never an edit of a prior one). Never throws on send failure; the
 * failed attempt is logged and returned to the caller to act on.
 */
export async function sendReceiptEmail(
  receipt: ReceiptDocument,
  to: string,
): Promise<SendReceiptEmailResult> {
  const supabase = createServerSupabaseClient()

  const { count: priorAttempts, error: countError } = await supabase
    .from('receipt_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('receipt_document_id', receipt.id)
    .eq('method', 'EMAIL')

  if (countError) {
    throw new Error(`sendReceiptEmail: failed to compute attempt number: ${countError.message}`)
  }

  const attemptNumber = (priorAttempts ?? 0) + 1
  const snapshot = receipt.snapshot_json as ReceiptSnapshot
  const html = renderReceiptHtml(snapshot, {
    documentNumber: receipt.document_number,
    issuedAt: receipt.issued_at,
  })

  let status: 'sent' | 'failed' = 'sent'
  let providerReference: string | null = null
  let errorCode: string | null = null
  let errorMessage: string | null = null

  try {
    const pdfBytes = await renderReceiptPdf(snapshot, {
      documentNumber: receipt.document_number,
      issuedAt: receipt.issued_at,
    })
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64')

    const result = await getResend().emails.send({
      from: 'FlashTap <noreply@flashtap.app>',
      to: [to],
      subject: `Receipt ${receipt.document_number} - ${snapshot.outlet.restaurant_name}`,
      html,
      attachments: [
        {
          filename: `Receipt-${receipt.document_number}.pdf`,
          content: pdfBase64,
          contentType: 'application/pdf',
        },
      ],
    })

    if (result.error) {
      status = 'failed'
      errorCode = result.error.name || 'resend_error'
      errorMessage = result.error.message || 'Resend rejected the receipt email'
    } else {
      providerReference = result.data?.id ?? null
    }
  } catch (err) {
    status = 'failed'
    errorCode = 'send_exception'
    errorMessage = err instanceof Error ? err.message : 'Unknown error sending receipt email'
  }

  const now = new Date().toISOString()

  const { data: delivery, error: insertError } = await supabase
    .from('receipt_deliveries')
    .insert({
      receipt_document_id: receipt.id,
      method: 'EMAIL',
      destination: to,
      status,
      attempt_number: attemptNumber,
      provider: PROVIDER,
      provider_reference: providerReference,
      error_code: errorCode,
      error_message: errorMessage,
      requested_at: now,
      completed_at: now,
    })
    .select('id, status')
    .single()

  if (insertError || !delivery) {
    throw new Error(`sendReceiptEmail: failed to record delivery attempt: ${insertError?.message}`)
  }

  return { deliveryId: delivery.id, status: delivery.status as 'sent' | 'failed', errorMessage }
}
