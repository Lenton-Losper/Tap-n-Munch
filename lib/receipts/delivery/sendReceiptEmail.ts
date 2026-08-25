import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getResend } from '@/lib/email/resend'
import { renderReceiptHtml } from '@/lib/receipts/renderers/htmlRenderer'
import { renderReceiptPdf } from '@/lib/receipts/renderers/pdfRenderer'
import type { ReceiptDocument, ReceiptSnapshot } from '@/lib/receipts/issueReceipt'

const PROVIDER = 'resend'

/**
 * #244 — THE GATES. `attempt_number` was a LABEL, not a limit.
 *
 * It was derived, written to the append-only log, and never compared to anything. No ceiling, no
 * dedup, no bound of any kind: the same receipt to the same address twice sent two emails and
 * logged them as attempts 1 and 2.
 *
 * THEY LIVE HERE, not in the routes, because THREE routes call this and one of them takes no
 * session token at all (`app/api/guest/orders/[orderId]/receipt/email` — that is #304, still
 * open). A limit enforced per route is a limit the next route forgets. This is the only place all
 * three share.
 *
 * That also settles the "latent" question the issue records. It is NOT latent: the guest route is
 * reachable unauthenticated today, so unbounded sends do not have to wait for issuance to be wired
 * to delivery or for a `customer_email` column to exist.
 *
 * THE NUMBERS ARE AN IMPLEMENTATION CHOICE, disclosed rather than smuggled:
 *
 *   DEDUP_WINDOW_MS   5 minutes. Long enough to cover a double tap, a retried request and an
 *                     impatient second press; short enough that a customer who genuinely lost the
 *                     mail can ask again without being told no.
 *   MAX_ATTEMPTS      10 per receipt, counting EVERY attempt including failed ones. Deliberately
 *                     generous: this is an abuse ceiling, not a retry policy, and a provider
 *                     having a bad afternoon must not permanently strand a real customer.
 *
 * WHAT IS DELIBERATELY NOT IMPLEMENTED: the issue's third gate, "no date bound". It cannot be
 * built honestly here. The only date this module can see is `receipt.issued_at`, and a receipt's
 * snapshot is built AT ISSUANCE rather than at sale — so issuing a backlog stamps TODAY onto a
 * months-old sale, and an age bound on `issued_at` would read every backfilled receipt as fresh.
 * The date it would need is the true payment date, which does not exist as a field. A bound that
 * measures the wrong thing is worse than none, because it reads as protection. Written up on #244.
 */
export const RECEIPT_EMAIL_DEDUP_WINDOW_MS = 5 * 60 * 1000
export const RECEIPT_EMAIL_MAX_ATTEMPTS = 10

/** Case and surrounding space are not identity for an email address. */
function sameAddress(a: unknown, b: unknown): boolean {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase()
}

/**
 * WHY THE CALLER GETS A CODE AND NOT A STRING TO MATCH ON.
 *
 * The owner ruled 2026-08-25 that a deliberate refusal answers 429 and a provider failure answers
 * 502, and that neither may put the internal reason in a customer's body. A route cannot make that
 * distinction from `errorMessage` without matching on English, which breaks the moment the wording
 * is edited -- the exact fragility this module documents elsewhere.
 */
export type SendReceiptEmailFailure = 'attempt_ceiling' | 'provider_failed'

export interface SendReceiptEmailResult {
  deliveryId: string
  status: 'sent' | 'failed'
  /** The REAL reason, for logs and the audit row. Never for a customer response body. */
  errorMessage: string | null
  /** Set whenever `status` is 'failed', so a caller can pick a status code without matching English. */
  failure?: SendReceiptEmailFailure
  /**
   * True when no mail was handed to the provider because an identical send already succeeded
   * inside the dedup window. The caller's contract is unchanged — the receipt IS on its way to
   * that address — so this is reported as `sent`, and this flag exists for logs and tests rather
   * than for a different answer to the customer.
   */
  deduplicated?: boolean
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

  /**
   * #244 GATE 1 — THE CEILING. Checked before anything is rendered or sent.
   *
   * Counts every prior EMAIL attempt on this receipt, to any address, in any status. Refused as a
   * `failed` result rather than a throw, so it travels the SAME path the three routes already have
   * for a provider rejection — no new branch, no new response shape, nothing to teach a client.
   *
   * The refusal is NOT written to `receipt_deliveries`. That table logs attempts to DELIVER; this
   * one never reached the provider, and an append-only trail whose rows do not correspond to
   * anything having been attempted stops being an audit trail. It is logged loudly instead.
   */
  if (attemptNumber > RECEIPT_EMAIL_MAX_ATTEMPTS) {
    console.error(
      '[sendReceiptEmail] refusing: this receipt has reached its email attempt ceiling (#244)',
      {
        receiptDocumentId: receipt.id,
        documentNumber: receipt.document_number,
        priorAttempts: priorAttempts ?? 0,
        ceiling: RECEIPT_EMAIL_MAX_ATTEMPTS,
      },
    )
    /**
     * A DIAGNOSTIC, NOT COPY, and deliberately so.
     *
     * All three routes put `result.errorMessage` straight into an API error body, and one of them
     * answers an unauthenticated customer. That slot already carries raw provider text ("Resend
     * rejected the receipt email"), so it is not a signed-copy surface — but it is also not a
     * place to invent a sentence addressed to a customer. This says what happened, in the same
     * register as the provider strings beside it, and nothing else.
     *
     * IF this refusal should ever say something to a customer — "ask a member of staff", or
     * anything of that shape — that is a wording decision and belongs to the owner, alongside the
     * question of whether a 502 is even the right status for a deliberate refusal. Flagged on
     * #244, not answered here.
     */
    return {
      deliveryId: '',
      status: 'failed',
      failure: 'attempt_ceiling',
      errorMessage: `Receipt email attempt ceiling reached (${RECEIPT_EMAIL_MAX_ATTEMPTS}) for this receipt`,
    }
  }

  /**
   * #244 GATE 2 — DEDUP. A successful send to the SAME address inside the window is not repeated.
   *
   * Compared in JavaScript rather than by a `destination` filter, so case and stray whitespace
   * cannot defeat it — `Ada@Example.com` and `ada@example.com ` are one address to a mail server
   * and must be one address here. The read is bounded and ordered, so a receipt with a long
   * history costs the same as a fresh one.
   *
   * Returns the EXISTING delivery id. The caller asked for the receipt to reach that address and
   * it has, minutes ago; answering `sent` is the true statement, not a convenient one.
   */
  const dedupSince = new Date(Date.now() - RECEIPT_EMAIL_DEDUP_WINDOW_MS).toISOString()
  const { data: recent, error: recentError } = await supabase
    .from('receipt_deliveries')
    .select('id, destination, status, requested_at')
    .eq('receipt_document_id', receipt.id)
    .eq('method', 'EMAIL')
    .eq('status', 'sent')
    .gte('requested_at', dedupSince)
    .order('requested_at', { ascending: false })
    .limit(20)

  if (recentError) {
    // FAIL OPEN, deliberately, and only here. This gate exists to suppress a DUPLICATE; if it
    // cannot run, the worst outcome is the behaviour that shipped for months anyway — one extra
    // email. Refusing instead would turn a read blip into a customer who cannot get their receipt.
    // The ceiling above is the gate that fails CLOSED, because its read failure throws.
    console.error('[sendReceiptEmail] dedup check failed; sending anyway (#244)', recentError)
  }

  const duplicate = (recent ?? []).find((row) => sameAddress(row.destination, to))
  if (duplicate) {
    console.warn('[sendReceiptEmail] suppressed a duplicate send inside the dedup window (#244)', {
      receiptDocumentId: receipt.id,
      deliveryId: duplicate.id,
      windowMs: RECEIPT_EMAIL_DEDUP_WINDOW_MS,
    })
    return {
      deliveryId: String(duplicate.id),
      status: 'sent',
      errorMessage: null,
      deduplicated: true,
    }
  }

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
