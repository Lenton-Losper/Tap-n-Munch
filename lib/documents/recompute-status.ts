import type { createServerSupabaseClient } from '@/lib/supabase/server'

/** Statuses no payment/overdue recompute is allowed to move a document out of. */
const TERMINAL_STATUSES = new Set(['void', 'converted', 'expired', 'declined'])

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export type RecomputedInvoiceStatus = {
  status: string
  balance: number
  changed: boolean
}

/**
 * Single source of truth for invoice status/balance, derived from document_payments the same
 * way lib/payments/get-payment-projection.ts derives order payment state from payment_events --
 * application-level recompute, not a DB trigger, so it can be called both right after a write
 * (payment recorded, marked sent) and lazily on read (to surface 'overdue' without needing a
 * scheduled job, since no single row write happens when a due_date simply passes).
 *
 * Only writes back to business_documents when the computed status/balance actually differ, to
 * avoid an UPDATE on every list/read call.
 */
export async function recomputeInvoiceStatus(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  documentId: string,
): Promise<RecomputedInvoiceStatus> {
  const { data: doc, error: docError } = await supabase
    .from('business_documents')
    .select('id, document_type, total, due_date, status, balance')
    .eq('id', documentId)
    .single()
  if (docError) throw docError
  if (doc.document_type !== 'invoice') {
    throw new Error('recomputeInvoiceStatus called on a non-invoice document')
  }

  if (TERMINAL_STATUSES.has(doc.status)) {
    return { status: doc.status, balance: Number(doc.balance), changed: false }
  }

  const { data: payments, error: paymentsError } = await supabase
    .from('document_payments')
    .select('amount')
    .eq('document_id', documentId)
  if (paymentsError) throw paymentsError

  const paid = (payments ?? []).reduce((sum, row) => sum + Number(row.amount), 0)
  const balance = round2(Number(doc.total) - paid)

  let status: string
  if (balance <= 0) {
    status = 'paid'
  } else if (paid > 0) {
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
