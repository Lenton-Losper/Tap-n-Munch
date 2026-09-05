/**
 * Email a quote or invoice to the party it is billed to, with its PDF attached.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * `POST /api/admin/documents/[id]/send` was named "send" and sent nothing. It flipped
 * `status` to 'sent', stamped `sent_at`, and returned 200 — its own docstring said "Marks a
 * draft quote or invoice as sent". A staff member pressed Send, the row said sent, and the
 * customer never received anything. All three invoices on production are still `draft`, so
 * nothing has ever been delivered by any route.
 *
 * That is the same shape as the silent receipt issuance in #234: a write that records an
 * intention and is read later as an outcome.
 *
 * ============================================================================================
 * STATUS FOLLOWS THE SEND, NOT THE ATTEMPT
 * ============================================================================================
 *
 * The caller marks the document sent ONLY when the provider accepted it. A failed send leaves
 * the document in `draft` so it can be sent again, and returns the provider's message. Marking
 * 'sent' on a failure would be the original defect with an email client bolted on: the row would
 * still be claiming something that did not happen, and `aged-receivables` would start counting
 * the days since an invoice nobody received.
 *
 * ============================================================================================
 * EVERY ATTEMPT IS RECORDED, INCLUDING THE FAILURES
 * ============================================================================================
 *
 * Receipts have `receipt_deliveries` for this. Invoices have no equivalent table and this change
 * deliberately does not add one — a migration would couple this to a schema deploy for a record
 * `audit_logs` already holds well (it is what the settle route calls "the only durable record"
 * when a write fails). If invoice delivery later needs retry counts and provider references as
 * first-class columns, that is a table, and it can read this history to backfill.
 *
 * The audit row is written for BOTH outcomes. A failure that is only in the response is a failure
 * nobody can find tomorrow.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getResend } from '@/lib/email/resend'
import { generateDocumentPdfBytes } from '@/lib/documents/generate-document-pdf'
import { toBusinessDocumentRow } from '@/lib/documents/business-document-row'

const FROM = 'FlashTap <noreply@flashtap.app>'

/**
 * NO `reply_to`, AND NO INVITATION TO REPLY. A DECISION, NOT AN OMISSION — 2026-09-05.
 *
 * A draft of this email closed with "Questions about this invoice? Reply to this email and it will
 * reach <venue>." That sentence was false: replies go to noreply@flashtap.app and reach nobody.
 *
 * The obvious repair is a `reply_to` pointing at the venue. It was considered and REJECTED by the
 * owner: replies landing in an unwatched venue mailbox are worse than no invitation to reply,
 * because the customer believes they have been in touch and nobody has heard them. The venue's own
 * contact details are printed on the attached PDF, which is where a customer with a question
 * should be sent.
 *
 * Do not add a reply line back without a mailbox somebody actually reads.
 */

export type SendDocumentResult =
  | { ok: true; providerReference: string | null; to: string }
  | { ok: false; errorCode: string; errorMessage: string; to: string }

/** "invoice" | "quote" | "credit note" — for copy, so the subject line never says "document". */
function documentNoun(documentType: string): string {
  if (documentType === 'credit_note') return 'Credit note'
  if (documentType === 'quote') return 'Quote'
  return 'Invoice'
}

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The email body.
 *
 * BANK DETAILS ARE IN THE EMAIL, not only in the attached PDF. The whole point of this flow is
 * that the customer can pay, and asking someone to open an attachment to find an account number
 * is how an invoice sits unpaid. They are read from the DOCUMENT, not from the venue's profile:
 * `create-document.ts` snapshots them onto the row at creation, so a venue that changes banks
 * does not retroactively change where an already-issued invoice says to pay.
 *
 * The block is omitted entirely when the venue has no bank details on file, rather than rendering
 * empty labels.
 */
export function renderDocumentEmailHtml(doc: {
  document_type: string
  document_number: string
  business_name: string | null
  total: number
  currency: string
  due_date: string | null
  bill_to_name: string | null
  bank_name: string | null
  bank_account_name: string | null
  bank_account_number: string | null
  bank_branch_code: string | null
}): string {
  const noun = documentNoun(doc.document_type)
  const venue = doc.business_name?.trim() || 'FlashTap'
  const greeting = doc.bill_to_name?.trim() ? `Hi ${escapeHtml(doc.bill_to_name.trim())},` : 'Hello,'
  const due = formatDate(doc.due_date)

  const hasBank = Boolean(
    doc.bank_name || doc.bank_account_name || doc.bank_account_number || doc.bank_branch_code,
  )
  const bankRows: Array<[string, string | null]> = [
    ['Bank', doc.bank_name],
    ['Account name', doc.bank_account_name],
    ['Account number', doc.bank_account_number],
    ['Branch code', doc.bank_branch_code],
  ]

  const bankBlock = hasBank
    ? `
    <h2 style="font-size:15px;margin:24px 0 8px;color:#111827;">How to pay</h2>
    <table cellpadding="0" cellspacing="0" style="font-size:14px;color:#374151;border-collapse:collapse;">
      ${[...bankRows, ['Reference', doc.document_number] as [string, string]]
        .filter(([, v]) => Boolean(v && String(v).trim()))
        .map(
          ([label, v]) =>
            `<tr><td style="padding:2px 16px 2px 0;color:#6b7280;">${label}</td>` +
            `<td style="padding:2px 0;font-weight:600;">${escapeHtml(String(v))}</td></tr>`,
        )
        .join('')}
    </table>`
    : ''

  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;">
      <p style="font-size:15px;color:#374151;margin:0 0 16px;">${greeting}</p>
      <p style="font-size:15px;color:#374151;margin:0 0 24px;">
        ${noun} <strong>${escapeHtml(doc.document_number)}</strong> from ${escapeHtml(venue)} is attached as a PDF.
      </p>
      <table cellpadding="0" cellspacing="0" style="font-size:14px;color:#374151;border-collapse:collapse;margin:0 0 8px;">
        <tr>
          <td style="padding:2px 16px 2px 0;color:#6b7280;">Amount</td>
          <td style="padding:2px 0;font-weight:600;">${escapeHtml(formatMoney(doc.total, doc.currency))}</td>
        </tr>
        ${due ? `<tr><td style="padding:2px 16px 2px 0;color:#6b7280;">Due</td><td style="padding:2px 0;font-weight:600;">${escapeHtml(due)}</td></tr>` : ''}
      </table>
      ${bankBlock}
    </div>
  </body>
</html>`
}

export async function sendDocumentEmail(
  supabase: SupabaseClient,
  row: Record<string, unknown>,
  to: string,
  actorUserId: string,
): Promise<SendDocumentResult> {
  const documentId = String(row.id)
  const restaurantId = String(row.restaurant_id)
  const documentType = String(row.document_type ?? '')
  const documentNumber = String(row.document_number ?? '')
  const noun = documentNoun(documentType)

  let result: SendDocumentResult

  try {
    const parsed = toBusinessDocumentRow(row)
    const pdfBytes = await generateDocumentPdfBytes(parsed)
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64')

    const html = renderDocumentEmailHtml({
      document_type: documentType,
      document_number: documentNumber,
      business_name: parsed.business_name,
      total: parsed.total,
      currency: parsed.currency,
      due_date: parsed.due_date,
      bill_to_name: parsed.bill_to.name ?? null,
      bank_name: parsed.bank_name,
      bank_account_name: parsed.bank_account_name,
      bank_account_number: parsed.bank_account_number,
      bank_branch_code: parsed.bank_branch_code,
    })

    const venue = parsed.business_name?.trim() || 'FlashTap'
    const sent = await getResend().emails.send({
      from: FROM,
      to: [to],
      subject: `${noun} ${documentNumber} from ${venue}`,
      html,
      attachments: [
        {
          filename: `${noun.replace(/\s+/g, '-')}-${documentNumber}.pdf`,
          content: pdfBase64,
          contentType: 'application/pdf',
        },
      ],
    })

    result = sent.error
      ? {
          ok: false,
          errorCode: sent.error.name || 'resend_error',
          errorMessage: sent.error.message || 'Resend rejected the email',
          to,
        }
      : { ok: true, providerReference: sent.data?.id ?? null, to }
  } catch (err) {
    result = {
      ok: false,
      errorCode: 'send_exception',
      errorMessage: err instanceof Error ? err.message : 'Unknown error sending the email',
      to,
    }
  }

  // Both outcomes. A failure that exists only in the HTTP response is a failure nobody can find
  // tomorrow, and "did the customer ever get invoice 1043" is exactly tomorrow's question.
  const { error: auditError } = await supabase.from('audit_logs').insert({
    restaurant_id: restaurantId,
    action: result.ok ? 'document.emailed' : 'document.email_failed',
    entity_type: 'business_documents',
    entity_id: documentId,
    metadata: {
      document_type: documentType,
      document_number: documentNumber,
      to,
      actor_user_id: actorUserId,
      provider: 'resend',
      ...(result.ok
        ? { provider_reference: result.providerReference }
        : { error_code: result.errorCode, error_message: result.errorMessage }),
    },
  })

  if (auditError) {
    console.error('[documents/send] audit insert failed', { documentId, error: auditError })
  }

  return result
}
