import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { createBusinessDocument } from '@/lib/documents/create-document'
import { recomputeDocumentStatus } from '@/lib/documents/recompute-status'
import {
  INVOICE_LINE_COLUMNS,
  INVOICE_ORDER_COLUMNS,
  invoicePaymentRecords,
  planInvoice,
  type AllocationSettlementRow,
  type InvoiceOrderRow,
  type InvoicePlan,
  type InvoiceRefusalCode,
  type SaleEventRow,
} from '@/lib/documents/invoice-projection'
import type { FinancialLineInput } from '@/lib/orders/order-financials'
import { getPaymentProjections } from '@/lib/payments/get-payment-projection'
import { settledCentsByOrder } from '@/lib/payments/settled-cents'
import { resolveTaxRate } from '@/lib/tax-rates/apply-tax'
import { getTaxRatesForRestaurant, defaultTaxRate } from '@/lib/tax-rates/queries'

/**
 * RAISE A FORMAL INVOICE FROM AN EXISTING ORDER, OR FROM A WHOLE TAB.
 *
 * ================================================================================================
 * AN INVOICE IS A DOCUMENT. IT IS NOT A PAYMENT.
 * ================================================================================================
 *
 * Nothing in this module calls a gateway, mints a merchant order number, touches a payment intent,
 * writes a settlement, or changes `orders.payment_status` / `orders.status`. Creating an invoice
 * for an unpaid order leaves it exactly as unpaid as it was, and creating one for a paid order
 * collects nothing further. The rows written are: one `business_documents` row (plus the sequence
 * counter the numbering RPC advances), and -- when money has ALREADY been collected -- the
 * `document_payments` rows that let the document engine's own balance say so (see step 9).
 *
 * `document_payments` is the document engine's ledger of what an invoice has been paid, not a
 * payment: writing one moves no money and is read by nothing on the payment path. It is how the
 * engine's balance/status recompute (lib/documents/recompute-status.ts) comes to say PAID for a
 * tab that was settled at the table, which is what the Sprint 2026-09-28 brief requires (it
 * answers open question 4 of docs/decisions-2026-09-13-invoice-and-payment-surfaces.md).
 *
 * ================================================================================================
 * EVERY FIGURE IS THE PROJECTION'S
 * ================================================================================================
 *
 * The caller supplies an order id or a tab id and nothing else that can affect money. Lines,
 * quantities, unit prices, what is voided, what is paid and what is outstanding all come from
 * lib/orders/order-financials.ts through lib/documents/invoice-projection.ts. `orders.total` and
 * `orders.items` are never billed as stored: both include voided lines, which is the defect the
 * first version of this module shipped with.
 *
 * ================================================================================================
 * VAT IS NOT RECOMPUTED UNDER A NEW POLICY -- IT IS REPRODUCED, AND THEN CHECKED
 * ================================================================================================
 *
 * `createBusinessDocument` computes per-line VAT from each line's `tax_rate_id` through exactly the
 * same hierarchy order pricing uses. The document total must then equal the projection's LIVE
 * total to the cent, and the invoice is voided rather than issued if it does not. It can differ --
 * 289 of 4,463 paid production orders have a line with no `taxRateId`, which falls back to the
 * venue's default rate TODAY, and a venue that changed its rate since the sale would produce a
 * document stating a figure the customer never paid.
 *
 * No Namibian tax rule is encoded here, and none is invented.
 */

export type InvoiceFromOrderRefusalCode = InvoiceRefusalCode

export type InvoiceFromOrderResult =
  | { ok: true; document: Record<string, unknown>; warnings: string[] }
  | {
      ok: false
      code: InvoiceFromOrderRefusalCode
      /** Staff-facing. Says what is wrong and what to do about it. */
      message: string
      /** For BILLING_PROFILE_INCOMPLETE: exactly which Settings fields are missing. */
      missingBillingFields?: string[]
      /** For INVOICE_ALREADY_EXISTS: the document that already bills for this order/tab. */
      existingDocument?: { id: string; document_number: string; status: string }
    }

/**
 * THE MINIMUM A FORMAL INVOICE MUST CARRY ABOUT THE MERCHANT, and no more.
 *
 * `registration_number` only. It is required because the renderer prints it and because
 * 20260901120000's own measurement records the gap it leaves: 1,241 production receipts state a VAT
 * amount and carry no registration number, and the system could not say whether that is a
 * compliance failure or correct output for an unregistered merchant.
 *
 * Bank details are deliberately NOT required. `vat_number` is conditionally required -- see
 * requiredBillingFieldsFor() -- on the same rule the billing-profile route already enforces.
 */
export const REQUIRED_BILLING_FIELDS = ['registration_number'] as const

export function requiredBillingFieldsFor(chargesVat: boolean): string[] {
  return chargesVat ? [...REQUIRED_BILLING_FIELDS, 'vat_number'] : [...REQUIRED_BILLING_FIELDS]
}

type Supabase = ReturnType<typeof createServerSupabaseClient>

type CommonParams = {
  /** The restaurant the CALLER is authorized for. Never taken from the request body. */
  restaurantId: string
  createdBy: string
  dueDate?: string | null
  referenceNote?: string | null
  /**
   * Bill-to party. Free-form, entered by staff at the time of raising the invoice, and NOT
   * persisted to the order -- see the customer-contact note in the route.
   */
  billTo?: Record<string, unknown>
}

type TabRow = { id: string; restaurant_id: string; table_number: number | null; status: string | null }

type Loaded = {
  scope: 'order' | 'tab'
  tab: TabRow | null
  orders: InvoiceOrderRow[]
  lines: FinancialLineInput[]
  settledByOrder: Map<string, number>
}

export async function createInvoiceFromOrder(
  supabase: Supabase,
  params: CommonParams & { orderId: string },
): Promise<InvoiceFromOrderResult> {
  // ── 1. The order, read by the server, scoped to the caller's restaurant ────────────────────
  const { data, error } = await supabase
    .from('orders')
    .select(INVOICE_ORDER_COLUMNS)
    .eq('id', params.orderId)
    .eq('restaurant_id', params.restaurantId)
    .maybeSingle()
  if (error) throw error

  const order = data as unknown as InvoiceOrderRow | null
  if (!order) {
    /**
     * The SAME answer for "no such order" and "an order at another venue". Distinguishing them
     * would let a caller enumerate order ids across tenants by reading the refusal.
     */
    return { ok: false, code: 'ORDER_NOT_FOUND', message: 'That order could not be found at this venue.' }
  }

  const loaded = await loadLinesAndSettlements(supabase, { scope: 'order', tab: null, orders: [order] })
  return issue(supabase, params, loaded)
}

export async function createInvoiceFromTab(
  supabase: Supabase,
  params: CommonParams & { tabId: string },
): Promise<InvoiceFromOrderResult> {
  const { data: tabData, error: tabError } = await supabase
    .from('tabs')
    .select('id, restaurant_id, table_number, status')
    .eq('id', params.tabId)
    .eq('restaurant_id', params.restaurantId)
    .maybeSingle()
  if (tabError) throw tabError
  const tab = tabData as TabRow | null
  if (!tab) {
    // Same no-enumeration rule as for orders.
    return { ok: false, code: 'TAB_NOT_FOUND', message: 'That tab could not be found at this venue.' }
  }

  const { data: orderRows, error: ordersError } = await supabase
    .from('orders')
    .select(INVOICE_ORDER_COLUMNS)
    .eq('tab_id', tab.id)
    .eq('restaurant_id', params.restaurantId)
  if (ordersError) throw ordersError
  const orders = ((orderRows ?? []) as unknown as InvoiceOrderRow[]).sort(
    (a, b) => String(a.placed_at ?? '').localeCompare(String(b.placed_at ?? '')),
  )
  if (orders.length === 0) {
    return { ok: false, code: 'ORDER_HAS_NO_LINES', message: 'This tab has no orders to invoice.' }
  }

  const loaded = await loadLinesAndSettlements(supabase, { scope: 'tab', tab, orders })
  return issue(supabase, params, loaded)
}

async function loadLinesAndSettlements(
  supabase: Supabase,
  base: Omit<Loaded, 'lines' | 'settledByOrder'>,
): Promise<Loaded> {
  const orderIds = base.orders.map((o) => String(o.id))
  const { data: lineRows, error: linesError } = await supabase
    .from('order_lines')
    .select(INVOICE_LINE_COLUMNS)
    .in('order_id', orderIds)
  if (linesError) throw linesError
  // Fails closed: SettledCentsUnreadable propagates. Not knowing what was collected is not
  // permission to state that nothing was.
  const settledByOrder = await settledCentsByOrder(supabase, orderIds)
  return { ...base, lines: (lineRows ?? []) as unknown as FinancialLineInput[], settledByOrder }
}

async function issue(supabase: Supabase, params: CommonParams, loaded: Loaded): Promise<InvoiceFromOrderResult> {
  const { restaurantId, createdBy } = params
  const orderIds = loaded.orders.map((o) => String(o.id))

  // ── 2. Refunds are a credit note's job, never a smaller invoice ───────────────────────────
  const projections = await getPaymentProjections(supabase, restaurantId, orderIds)
  const refundedOrderIds = new Set(
    orderIds.filter((id) => (projections.get(id)?.refundedAmount ?? 0) > 0),
  )

  // ── 3. The plan: eligibility, lines, and the projection's totals ──────────────────────────
  const plan = planInvoice({
    scope: loaded.scope,
    orders: loaded.orders,
    lines: loaded.lines,
    settledByOrder: loaded.settledByOrder,
    refundedOrderIds,
  })
  if (!plan.ok) return plan

  // ── 4. One live invoice per order and per tab, unless the earlier one was voided ──────────
  const existing = await findLiveInvoice(supabase, restaurantId, loaded, plan)
  if (existing) {
    return {
      ok: false,
      code: 'INVOICE_ALREADY_EXISTS',
      message:
        loaded.scope === 'tab'
          ? `Invoice ${existing.document_number} already bills for this tab or one of its orders.`
          : `Invoice ${existing.document_number} has already been raised for this order.`,
      existingDocument: existing,
    }
  }

  // ── 5. Payments, read for labelling BEFORE a number is burned ─────────────────────────────
  const payments = await readPaymentRecords(supabase, restaurantId, loaded, plan)
  if (!payments) {
    return {
      ok: false,
      code: 'PAYMENT_LEDGER_DISAGREES',
      message:
        'The payments on these items changed while the invoice was being prepared. Try again in a ' +
        'moment.',
    }
  }

  // ── 6. Merchant details, checked BEFORE a document number is burned ───────────────────────
  const { data: billingProfile, error: billingError } = await supabase
    .from('restaurant_billing_profiles')
    .select('registration_number, vat_number')
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  if (billingError) throw billingError

  /**
   * WHETHER THE DOCUMENT WILL ACTUALLY CHARGE VAT -- resolved the way the engine resolves it, not
   * guessed from whether a line names a rate. A line with NO `tax_rate_id` falls back to the
   * venue's default rate; reading it as "no VAT" would issue a VAT-charging invoice from a venue
   * that has never supplied a VAT number.
   */
  const taxRates = await getTaxRatesForRestaurant(supabase, restaurantId)
  const ratesById = new Map(taxRates.map((rate) => [rate.id, rate]))
  const fallback = defaultTaxRate(taxRates)
  const chargesVat = plan.invoiceLines.some((line) => {
    const rate = resolveTaxRate(line.tax_rate_id, ratesById, fallback)
    return rate != null && Number(rate.percentage) > 0
  })
  const required = requiredBillingFieldsFor(chargesVat)
  const profile = (billingProfile ?? {}) as Record<string, unknown>
  const missing = required.filter((field) => !String(profile[field] ?? '').trim())

  if (missing.length > 0) {
    /**
     * FAILS CLOSED, and before `get_next_document_number` is called. A refusal after the sequence
     * advanced would leave a gap in gapless numbering for a document that was never issued.
     */
    return {
      ok: false,
      code: 'BILLING_PROFILE_INCOMPLETE',
      message:
        'This venue\'s business details are not complete, so a formal invoice cannot be issued ' +
        'yet. Add them under Settings → Billing.',
      missingBillingFields: missing,
    }
  }

  // ── 7. Create, through the one existing path ──────────────────────────────────────────────
  const created = await createBusinessDocument(supabase, {
    restaurantId,
    type: 'invoice',
    orderId: loaded.scope === 'order' ? orderIds[0] : null,
    tabId: loaded.scope === 'tab' ? loaded.tab?.id ?? null : null,
    orderIds: loaded.scope === 'tab' ? plan.coveredOrderIds : null,
    cancelledLineItems: plan.cancelledLines,
    shipTo: {},
    billTo: params.billTo ?? {},
    lineItems: plan.invoiceLines,
    dueDate: params.dueDate ?? null,
    referenceNote: params.referenceNote ?? scopeReference(loaded, plan),
    createdBy,
  })
  const documentId = String((created.document as { id: unknown }).id)

  /**
   * ── 7b. TWO CREATES AT ONCE (Sprint 2026-09-30, RC-ORDERS M) ─────────────────────────────────
   *
   * Step 4 is a read, and the insert above is a separate round trip, so two requests for the same
   * tab (a double-click, a retried request whose first answer was lost) both passed step 4 and BOTH
   * issued an invoice -- reproduced through the real route (chaos orders-cancel-kitchen, O23: two
   * 201s, two live invoices for one tab). A unique index cannot express "one live invoice per scope"
   * here: correct_invoice inserts the replacement while the original is still live, and a tab
   * invoice's scope is an order-id array.
   *
   * So the check is repeated AFTER the insert, and a request that now sees another live invoice for
   * its scope withdraws its own -- voided, not deleted, exactly like steps 8-10, because the number
   * is already consumed in a gapless ledger. Of two concurrent creates at least one sees the other
   * (whichever checks last), so there is never more than one live invoice. In the narrow case that
   * each sees the other, both withdraw and neither is issued; the caller is told to try again
   * (INVOICE_CREATE_CONFLICT) and the retry issues exactly one. Never two.
   */
  const rival = await findLiveInvoice(supabase, restaurantId, loaded, plan, documentId)
  if (rival) {
    await supabase.from('business_documents').update({ status: 'void' }).eq('id', documentId)
    const stillLive = await findLiveInvoice(supabase, restaurantId, loaded, plan, documentId)
    if (stillLive) {
      return {
        ok: false,
        code: 'INVOICE_ALREADY_EXISTS',
        message:
          loaded.scope === 'tab'
            ? `Invoice ${stillLive.document_number} already bills for this tab or one of its orders.`
            : `Invoice ${stillLive.document_number} has already been raised for this order.`,
        existingDocument: stillLive,
      }
    }
    return {
      ok: false,
      code: 'INVOICE_CREATE_CONFLICT',
      message: 'Another invoice for this bill was being created at the same moment. Try again.',
    }
  }

  // ── 8. The document must agree with the projection's LIVE total ───────────────────────────
  const documentCents = Math.round(Number((created.document as { total?: unknown }).total) * 100)
  if (documentCents !== plan.liveCents) {
    /**
     * The row is deliberately NOT deleted: `business_documents` is an append-only, gapless-numbered
     * ledger. It is voided instead -- "issued and withdrawn" -- leaving the number consumed and the
     * reason discoverable.
     */
    await supabase.from('business_documents').update({ status: 'void' }).eq('id', documentId)
    return {
      ok: false,
      code: 'DOCUMENT_TOTAL_DISAGREES_WITH_ORDER',
      message:
        `The invoice worked out to ${(documentCents / 100).toFixed(2)} but the bill is ` +
        `${(plan.liveCents / 100).toFixed(2)}. This usually means the venue's VAT rate changed ` +
        'after the sale. The invoice was voided rather than issued — it would have stated a figure ' +
        'the customer never paid.',
    }
  }

  // ── 9. What has already been paid, recorded where the document engine reads it ───────────
  if (payments.length > 0) {
    const { error: paymentsError } = await supabase.from('document_payments').insert(
      payments.map((p) => ({
        document_id: documentId,
        amount: p.amountCents / 100,
        method: p.method,
        reference: p.reference,
        ...(p.paidAt ? { paid_at: p.paidAt } : {}),
        recorded_by: createdBy,
      })),
    )
    if (paymentsError) {
      await supabase.from('business_documents').update({ status: 'void' }).eq('id', documentId)
      throw paymentsError
    }
  }
  const recomputed = await recomputeDocumentStatus(supabase, documentId)

  /**
   * THE BALANCE MUST BE THE PROJECTION'S OUTSTANDING. It is total − recorded payments, and both are
   * the projection's, so this can only fail if a payment row was lost or another writer touched the
   * document in between. An invoice whose balance says something else is voided, not issued.
   */
  if (Math.round(recomputed.balance * 100) !== plan.outstandingCents) {
    await supabase.from('business_documents').update({ status: 'void' }).eq('id', documentId)
    return {
      ok: false,
      code: 'DOCUMENT_BALANCE_DISAGREES',
      message:
        `The invoice's balance came to ${recomputed.balance.toFixed(2)} but ` +
        `${(plan.outstandingCents / 100).toFixed(2)} is outstanding. The invoice was voided.`,
    }
  }

  const document = { ...created.document, status: recomputed.status, balance: recomputed.balance }
  return { ok: true, document, warnings: created.warnings }
}

/**
 * The live (non-void) invoice that already bills for any order in scope, or for this tab.
 *
 * A VOIDED invoice is deliberately not a blocker: `correct_invoice()` voids the original and issues
 * a replacement that carries the same order_id / tab_id / order_ids (20260913100100,
 * 20260928140100), so the replacement is what blocks. Uniqueness is enforced here rather than by an
 * index because an index cannot tell a correction from a duplicate.
 *
 * Two parser-free reads (`.in`), not one `.or()`.
 */
async function findLiveInvoice(
  supabase: Supabase,
  restaurantId: string,
  loaded: Loaded,
  plan: InvoicePlan,
  excludeId: string | null = null,
): Promise<{ id: string; document_number: string; status: string } | null> {
  const covered = new Set(plan.coveredOrderIds)
  const tabIds = new Set<string>()
  if (loaded.tab) tabIds.add(String(loaded.tab.id))
  for (const o of loaded.orders) if (o.tab_id) tabIds.add(String(o.tab_id))

  const { data: byOrder, error: byOrderError } = await supabase
    .from('business_documents')
    .select('id, document_number, status, document_type, order_id')
    .eq('restaurant_id', restaurantId)
    .in('order_id', [...covered])
  if (byOrderError) throw byOrderError

  /**
   * TAB INVOICES ARE LOOKED UP BY TAB, and only by selecting `tab_id, order_ids` -- columns that
   * exist only after 20260928140000. An order that is not on a tab never issues this read, so a
   * plain order invoice keeps working against a database the migration has not reached yet.
   */
  let byTab: unknown[] = []
  if (tabIds.size > 0) {
    const { data, error } = await supabase
      .from('business_documents')
      .select('id, document_number, status, document_type, order_id, tab_id, order_ids')
      .eq('restaurant_id', restaurantId)
      .in('tab_id', [...tabIds])
    if (error) throw error
    byTab = data ?? []
  }

  type DocRow = {
    id: unknown
    document_number: unknown
    status: unknown
    document_type: unknown
    order_id: unknown
    tab_id?: unknown
    order_ids?: unknown
  }
  for (const d of [...(byOrder ?? []), ...byTab] as DocRow[]) {
    if (String(d.document_type) !== 'invoice' || String(d.status) === 'void') continue
    if (excludeId !== null && String(d.id) === excludeId) continue
    const docOrderIds = Array.isArray(d.order_ids) ? (d.order_ids as unknown[]).map(String) : []
    const billsThisTab =
      loaded.scope === 'tab' && loaded.tab != null && String(d.tab_id ?? '') === String(loaded.tab.id)
    const billsAnOrder =
      (d.order_id != null && covered.has(String(d.order_id))) || docOrderIds.some((id) => covered.has(id))
    if (billsThisTab || billsAnOrder) {
      return { id: String(d.id), document_number: String(d.document_number), status: String(d.status) }
    }
  }
  return null
}

async function readPaymentRecords(
  supabase: Supabase,
  restaurantId: string,
  loaded: Loaded,
  plan: InvoicePlan,
) {
  const paidOrderIds = plan.perOrder.filter((f) => f.paidCents > 0).map((f) => f.orderId)
  if (paidOrderIds.length === 0) return []

  // Item-ledger settlements, for method/reference. Same two-step shape as settledCentsByOrder.
  const allocationSettlements: AllocationSettlementRow[] = []
  const { data: allocations, error: allocError } = await supabase
    .from('order_line_allocations')
    .select('id, order_id')
    .in('order_id', paidOrderIds)
    .is('voided_at', null)
  if (allocError) throw allocError
  const orderByAllocation = new Map<string, string>()
  for (const a of (allocations ?? []) as Array<{ id: unknown; order_id: unknown }>) {
    orderByAllocation.set(String(a.id), String(a.order_id))
  }
  if (orderByAllocation.size > 0) {
    const { data: settlements, error: settleError } = await supabase
      .from('order_line_allocation_settlements')
      .select('order_line_allocation_id, amount_cents, method, payment_reference, settled_at')
      .in('order_line_allocation_id', [...orderByAllocation.keys()])
    if (settleError) throw settleError
    for (const s of (settlements ?? []) as Array<Record<string, unknown>>) {
      const orderId = orderByAllocation.get(String(s.order_line_allocation_id))
      if (!orderId) continue
      allocationSettlements.push({
        order_id: orderId,
        amount_cents: Number(s.amount_cents),
        method: s.method != null ? String(s.method) : null,
        payment_reference: s.payment_reference != null ? String(s.payment_reference) : null,
        settled_at: s.settled_at != null ? String(s.settled_at) : null,
      })
    }
  }

  // Sale events: identity only (transaction id, time). Their `amount` is not selected -- see
  // invoicePaymentRecords for why it must never be attributed per order.
  const { data: events, error: eventsError } = await supabase
    .from('payment_events')
    .select('order_ids, transaction_id, business_order_no, created_at')
    .eq('restaurant_id', restaurantId)
    .eq('event_type', 'sale')
    .overlaps('order_ids', paidOrderIds)
  if (eventsError) throw eventsError

  return invoicePaymentRecords({
    perOrder: plan.perOrder,
    orders: loaded.orders,
    settledByOrder: loaded.settledByOrder,
    allocationSettlements,
    saleEvents: (events ?? []) as SaleEventRow[],
  })
}

/** "FlashTap tab · table 4 · orders #154, #155 · 2026-09-01" -- the table/order/tab reference. */
function scopeReference(loaded: Loaded, plan: InvoicePlan): string {
  const covered = loaded.orders.filter((o) => plan.coveredOrderIds.includes(String(o.id)))
  const numbers = covered.map((o) => (o.order_number != null ? `#${o.order_number}` : String(o.id)))
  const table = loaded.tab?.table_number ?? covered.find((o) => o.table_number)?.table_number ?? null
  const placed = covered.map((o) => String(o.placed_at ?? '').slice(0, 10)).filter(Boolean).sort()[0]
  const parts =
    loaded.scope === 'tab'
      ? ['FlashTap tab', table ? `table ${table}` : null, `orders ${numbers.join(', ')}`]
      : [`FlashTap order ${numbers[0]}`, table ? `table ${table}` : null]
  if (placed) parts.push(loaded.scope === 'tab' ? placed : `placed ${placed}`)
  return parts.filter(Boolean).join(' · ')
}
