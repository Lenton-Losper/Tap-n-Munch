import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { recomputeDocumentStatus, type RecomputedDocumentStatus } from '@/lib/documents/recompute-status'
import { readInvoicePaymentRecords } from '@/lib/documents/create-invoice-from-order'
import { INVOICE_LINE_COLUMNS, INVOICE_ORDER_COLUMNS, type InvoiceOrderRow } from '@/lib/documents/invoice-projection'
import { computeOrderFinancials, type FinancialLineInput } from '@/lib/orders/order-financials'
import { settledCentsByOrder } from '@/lib/payments/settled-cents'

/**
 * A PAYMENT TAKEN AFTER AN INVOICE WAS ISSUED REACHES THE INVOICE (Sprint 2026-09-30 brief, J8).
 *
 * ================================================================================================
 * WHAT AN ISSUED INVOICE IS
 * ================================================================================================
 *
 * Two things with different lifetimes:
 *
 *   WHAT WAS BILLED   lines, VAT, total, cancelled lines. A SNAPSHOT: fixed at issue, never
 *                     rewritten. The eligibility rule (invoice-projection.ts) only lets an invoice
 *                     be issued once its orders' money can no longer move, so the snapshot stays
 *                     true.
 *   WHAT WAS PAID     `document_payments`, and the balance/status recompute-status derives from it.
 *                     NOT a snapshot: payments keep arriving after the document exists.
 *
 * createInvoiceFrom* wrote the paid half once, at issue. An invoice raised for an unpaid tab that
 * was then paid at the table kept saying "Amount outstanding: <the whole bill>" on the PDF, in the
 * email, in the documents list and in aged-receivables, which would chase the customer for it.
 *
 * ================================================================================================
 * THE BEHAVIOUR
 * ================================================================================================
 *
 * Every surface that SHOWS or SENDS an order-/tab-linked invoice calls refreshInvoicePayments
 * first. It recomputes the projection's paid figure for exactly the orders the invoice covers
 * (`order_ids`, or `order_id`), breaks it into (method, reference) payments with the same reader
 * issue uses, and hands them to `sync_invoice_projection_payments` (20260930120000), which -- under
 * a row lock, so two refreshes cannot both insert -- ADDS only the missing document_payments rows.
 * Nothing is rewritten or deleted; the document's lines and total are untouched. recompute-status
 * then derives balance and status exactly as it does after a manual payment.
 *
 * A NEW ROUND on the tab is a new order the invoice does not cover; its payment does not reach this
 * invoice (it is not billed on it). A hand-written invoice has no linked orders and is only
 * recomputed, as before.
 *
 * ================================================================================================
 * WHEN IT CANNOT BE SURE
 * ================================================================================================
 *
 * `balanceMatchesProjection` is false when, after the refresh, the invoice still says MORE is
 * outstanding than the projection does -- the stale state this exists to prevent (the ledger could
 * not be read consistently, or the sync refused). The PDF and send routes REFUSE on it (409
 * INVOICE_PAYMENTS_UNRESOLVED): a document that may demand money already paid is not rendered.
 * Less outstanding than the projection is allowed: that is a manual payment recorded against the
 * invoice (an EFT the tab ledger never saw), which is exactly what document_payments is for.
 */

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type InvoiceRefresh = RecomputedDocumentStatus & {
  /** 'not_linked' for hand-written documents and non-invoices; 'terminal' for void etc. */
  synced: 'synced' | 'not_linked' | 'terminal' | 'ledger_unreadable' | 'refused'
  insertedCents: number
  /** Outstanding per the projection over the covered orders, cents; null when not linked. */
  projectionOutstandingCents: number | null
  /** False = the invoice still claims more is owed than the projection says. Refuse to show it. */
  balanceMatchesProjection: boolean
  detail?: string
}

const TERMINAL_STATUSES = new Set(['void', 'converted', 'expired', 'declined', 'cancelled'])

function coveredOrderIds(doc: { order_id?: unknown; order_ids?: unknown }): string[] {
  const fromArray = Array.isArray(doc.order_ids) ? (doc.order_ids as unknown[]).map(String).filter(Boolean) : []
  if (fromArray.length > 0) return [...new Set(fromArray)]
  const single = String(doc.order_id ?? '').trim()
  return single ? [single] : []
}

export async function refreshInvoicePayments(
  supabase: Supabase,
  documentId: string,
  actorUserId: string | null,
): Promise<InvoiceRefresh> {
  const { data: doc, error: docError } = await supabase
    .from('business_documents')
    .select('id, restaurant_id, document_type, status, total, balance, order_id, tab_id, order_ids')
    .eq('id', documentId)
    .maybeSingle()
  if (docError) throw docError
  if (!doc) throw new Error(`document ${documentId} not found`)

  const covered = coveredOrderIds(doc as { order_id?: unknown; order_ids?: unknown })
  const passthrough = async (synced: InvoiceRefresh['synced'], detail?: string): Promise<InvoiceRefresh> => {
    const recomputed = await recomputeDocumentStatus(supabase, documentId)
    return {
      ...recomputed,
      synced,
      insertedCents: 0,
      projectionOutstandingCents: null,
      balanceMatchesProjection: synced === 'not_linked' || synced === 'terminal',
      detail,
    }
  }
  if (String(doc.document_type) !== 'invoice' || covered.length === 0) return passthrough('not_linked')
  if (TERMINAL_STATUSES.has(String(doc.status))) return passthrough('terminal')

  const restaurantId = String(doc.restaurant_id)
  const { data: orderRows, error: ordersError } = await supabase
    .from('orders')
    .select(INVOICE_ORDER_COLUMNS)
    .in('id', covered)
    .eq('restaurant_id', restaurantId)
  if (ordersError) throw ordersError
  const orders = (orderRows ?? []) as unknown as InvoiceOrderRow[]
  const { data: lineRows, error: linesError } = await supabase
    .from('order_lines')
    .select(INVOICE_LINE_COLUMNS)
    .in('order_id', covered)
  if (linesError) throw linesError
  const lines = (lineRows ?? []) as unknown as FinancialLineInput[]
  const settledByOrder = await settledCentsByOrder(supabase, covered)

  // The same projection issue used (planInvoice), over exactly the covered orders.
  const perOrder = orders
    .map((o) => computeOrderFinancials(o, lines, settledByOrder.get(String(o.id)) ?? 0))
    .filter((f) => !f.isSettlementArtefact)
  const projectionOutstandingCents = perOrder.reduce((s, f) => s + (f.cancelled ? 0 : f.outstandingCents), 0)

  const records = orders.length === covered.length
    ? await readInvoicePaymentRecords(supabase, restaurantId, { perOrder, orders, settledByOrder })
    : null
  if (!records) {
    const r = await passthrough('ledger_unreadable', 'the payment ledger could not be read consistently')
    return {
      ...r,
      projectionOutstandingCents,
      balanceMatchesProjection: Math.round(r.balance * 100) <= projectionOutstandingCents,
    }
  }

  /**
   * Only call the writer when something is missing. The function re-derives the shortfall under
   * its lock anyway; this just keeps a read of an up-to-date invoice a read.
   */
  const { data: existing, error: existingError } = await supabase
    .from('document_payments')
    .select('amount, method, reference')
    .eq('document_id', documentId)
  if (existingError) throw existingError
  const recordedByKey = new Map<string, number>()
  for (const p of (existing ?? []) as Array<{ amount: unknown; method: unknown; reference: unknown }>) {
    const key = `${String(p.method)}|${String(p.reference ?? '').trim()}`
    recordedByKey.set(key, (recordedByKey.get(key) ?? 0) + Math.round(Number(p.amount) * 100))
  }
  const missing = records.some((r) => r.amountCents > (recordedByKey.get(`${r.method}|${r.reference ?? ''}`) ?? 0))

  let insertedCents = 0
  let synced: InvoiceRefresh['synced'] = 'synced'
  let detail: string | undefined
  if (missing) {
    const { data, error } = await supabase.rpc('sync_invoice_projection_payments', {
      p_document_id: documentId,
      p_restaurant_id: restaurantId,
      p_records: records.map((r) => ({
        method: r.method,
        reference: r.reference,
        amount_cents: r.amountCents,
        paid_at: r.paidAt,
      })),
      p_recorded_by: actorUserId,
    })
    if (error) throw error
    const result = (data ?? {}) as { ok?: boolean; reason?: string; inserted_cents?: number }
    if (result.ok === true) {
      insertedCents = Number(result.inserted_cents ?? 0)
    } else {
      synced = 'refused'
      detail = String(result.reason ?? 'refused')
    }
  }

  const recomputed = await recomputeDocumentStatus(supabase, documentId)
  return {
    ...recomputed,
    synced,
    insertedCents,
    projectionOutstandingCents,
    balanceMatchesProjection: Math.round(recomputed.balance * 100) <= projectionOutstandingCents,
    detail,
  }
}

/** The body a PDF/send route answers with when the invoice may still demand money already paid. */
export function unresolvedInvoicePaymentsBody(refresh: InvoiceRefresh) {
  return {
    error:
      'This invoice\'s payments could not be brought up to date with what has been paid at the ' +
      'table, so it was not produced: it might ask for money that has already been paid. Try again ' +
      'in a moment.',
    code: 'INVOICE_PAYMENTS_UNRESOLVED',
    synced: refresh.synced,
    detail: refresh.detail ?? null,
    balance: refresh.balance,
    projection_outstanding: refresh.projectionOutstandingCents != null ? refresh.projectionOutstandingCents / 100 : null,
  }
}
