import type { createServerSupabaseClient } from '@/lib/supabase/server'

/** Statuses no payment/overdue/credit recompute is allowed to move a document out of. */
const TERMINAL_STATUSES = new Set(['void', 'converted', 'expired', 'declined', 'cancelled'])

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export type RecomputedDocumentStatus = {
  status: string
  balance: number
  changed: boolean
}

/**
 * Ledger-derived status for invoices; no-op / passthrough for types that are not
 * payment-ledger-derived (quotes, credit notes).
 *
 * Invoice balance = total − sum(document_payments) − sum(issued credit_notes that
 * credit this invoice via credited_by_id). Credit notes themselves are ledger
 * events (issued/cancelled), not something with a payment stream — do not force
 * them through the same derivation.
 */
export async function recomputeDocumentStatus(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  documentId: string,
): Promise<RecomputedDocumentStatus> {
  const { data: doc, error: docError } = await supabase
    .from('business_documents')
    .select('id, document_type, total, due_date, status, balance')
    .eq('id', documentId)
    .single()
  if (docError) throw docError

  if (doc.document_type === 'quote' || doc.document_type === 'credit_note') {
    return { status: doc.status, balance: Number(doc.balance), changed: false }
  }

  if (doc.document_type !== 'invoice') {
    throw new Error(`recomputeDocumentStatus called on unsupported document_type: ${doc.document_type}`)
  }

  if (TERMINAL_STATUSES.has(doc.status)) {
    return { status: doc.status, balance: Number(doc.balance), changed: false }
  }

  const [{ data: payments, error: paymentsError }, { data: credits, error: creditsError }] =
    await Promise.all([
      supabase.from('document_payments').select('amount').eq('document_id', documentId),
      supabase
        .from('business_documents')
        .select('total')
        .eq('document_type', 'credit_note')
        .eq('status', 'issued')
        .eq('credited_by_id', documentId),
    ])
  if (paymentsError) throw paymentsError
  if (creditsError) throw creditsError

  const paid = (payments ?? []).reduce((sum, row) => sum + Number(row.amount), 0)
  const credited = (credits ?? []).reduce((sum, row) => sum + Number(row.total), 0)
  const balance = round2(Number(doc.total) - paid - credited)

  let status: string
  if (balance <= 0) {
    status = 'paid'
  } else if (paid > 0 || credited > 0) {
    status = 'partially_paid'
  } else if (doc.due_date && new Date(doc.due_date).getTime() < Date.now() && doc.status !== 'draft') {
    status = 'overdue'
  } else {
    status = doc.status
  }

  const changed = status !== doc.status || balance !== Number(doc.balance)
  if (changed) {
    const { error: updateError } = await supabase
      .from('business_documents')
      .update({ status, balance })
      .eq('id', documentId)
    if (updateError) throw updateError
  }

  return { status, balance, changed }
}

/** @deprecated Use recomputeDocumentStatus — kept as a thin alias for call-site migration. */
export async function recomputeInvoiceStatus(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  documentId: string,
): Promise<RecomputedDocumentStatus> {
  return recomputeDocumentStatus(supabase, documentId)
}
