import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { createBusinessDocument, type LineItemInput } from '@/lib/documents/create-document'
import { getPaymentProjections } from '@/lib/payments/get-payment-projection'
import { round2 } from '@/lib/tax-rates/apply-tax'

/**
 * RAISE A FORMAL INVOICE FROM AN EXISTING ORDER.
 *
 * ================================================================================================
 * AN INVOICE IS A DOCUMENT. IT IS NOT A PAYMENT.
 * ================================================================================================
 *
 * Nothing in this module calls a gateway, mints a merchant order number, touches a payment intent,
 * writes a settlement, or changes `orders.payment_status` / `orders.status`. Creating an invoice
 * for an unpaid order leaves it exactly as unpaid as it was, and creating one for a paid order
 * collects nothing further. The only row written is one `business_documents` row (plus the sequence
 * counter the numbering RPC advances).
 *
 * That separation is the point, and it is load-bearing: the moment a document operation can move
 * money, every guard on the payment path has to be restated here, and one of them will be missed.
 *
 * ================================================================================================
 * THE SERVER IS THE ONLY SOURCE OF FIGURES
 * ================================================================================================
 *
 * The caller supplies an order id and nothing else that can affect money. Line descriptions,
 * quantities, unit prices, tax rates, the total -- all are read from the order row the server
 * loads. A client cannot propose a price, a quantity, a VAT figure, a total, or a restaurant.
 *
 * ================================================================================================
 * VAT IS NOT RECOMPUTED UNDER A NEW POLICY -- IT IS REPRODUCED, AND THEN CHECKED
 * ================================================================================================
 *
 * `createBusinessDocument` computes per-line VAT from each line's `tax_rate_id` through exactly the
 * same hierarchy order pricing uses. Handing it the order's own `taxRateId` and `unitPrice` should
 * therefore reproduce the order's own figures.
 *
 * "Should" is not good enough for a tax document, so it is VERIFIED: the document total must equal
 * `orders.total` to the cent, and the invoice is refused if it does not. It can differ -- 289 of
 * 4,463 paid production orders have at least one line with no `taxRateId`, which falls back to
 * whatever the venue's default rate is TODAY, and a venue that changed its rate since the sale
 * would produce a document stating a figure the customer never paid.
 *
 * No Namibian tax rule is encoded here, and none is invented. The engine's existing behaviour is
 * reused unchanged; this only refuses to issue a document that disagrees with the sale it claims to
 * describe.
 */

/** Order lifecycle states a formal invoice may be raised from. */
export const INVOICEABLE_ORDER_STATUSES = ['completed'] as const

export type InvoiceFromOrderRefusalCode =
  | 'ORDER_NOT_FOUND'
  | 'ORDER_CANCELLED'
  | 'ORDER_NOT_FINAL'
  | 'ORDER_AWAITING_REACCEPTANCE'
  | 'ORDER_REFUNDED'
  | 'ORDER_HAS_NO_LINES'
  | 'ORDER_TOTAL_UNUSABLE'
  | 'BILLING_PROFILE_INCOMPLETE'
  | 'INVOICE_ALREADY_EXISTS'
  | 'DOCUMENT_TOTAL_DISAGREES_WITH_ORDER'

export type InvoiceFromOrderResult =
  | { ok: true; document: Record<string, unknown>; warnings: string[] }
  | {
      ok: false
      code: InvoiceFromOrderRefusalCode
      /** Staff-facing. Says what is wrong and what to do about it. */
      message: string
      /** For BILLING_PROFILE_INCOMPLETE: exactly which Settings fields are missing. */
      missingBillingFields?: string[]
      /** For INVOICE_ALREADY_EXISTS: the document that already bills for this order. */
      existingDocument?: { id: string; document_number: string; status: string }
    }

type OrderRow = {
  id: string
  restaurant_id: string
  order_number: number | null
  status: string | null
  payment_status: string | null
  total: number | null
  items: unknown
  placed_at: string | null
  table_number: number | null
  customer_name: string | null
  requires_reacceptance: boolean | null
}

const ORDER_COLUMNS =
  'id, restaurant_id, order_number, status, payment_status, total, items, placed_at, table_number, customer_name, requires_reacceptance'

/**
 * THE MINIMUM A FORMAL INVOICE MUST CARRY ABOUT THE MERCHANT, and no more.
 *
 * `registration_number` only. It is required because the renderer prints it and because
 * 20260901120000's own measurement records the gap it leaves: 1,241 production receipts state a VAT
 * amount and carry no registration number, and the system could not say whether that is a
 * compliance failure or correct output for an unregistered merchant.
 *
 * Bank details are deliberately NOT required. An invoice can be settled by means other than a
 * transfer, and making them mandatory would be inventing a rule this codebase does not state
 * anywhere. They are rendered when present.
 *
 * `vat_number` is conditionally required -- see requiredBillingFieldsFor() -- on the same rule the
 * billing-profile route already enforces: claiming VAT without a registration number puts an
 * unidentifiable VAT charge in front of a customer.
 */
export const REQUIRED_BILLING_FIELDS = ['registration_number'] as const

export function requiredBillingFieldsFor(chargesVat: boolean): string[] {
  return chargesVat ? [...REQUIRED_BILLING_FIELDS, 'vat_number'] : [...REQUIRED_BILLING_FIELDS]
}

/**
 * Map an order's stored lines onto document line items.
 *
 * `unitPrice` is carried across unchanged. Under an INCLUSIVE rate -- which is what every priced
 * production line uses -- `applyTaxToAmount` treats `quantity * unit_price` as the gross charged
 * amount and backs the VAT out of it, so the document reproduces the order's gross exactly rather
 * than adding tax on top of a tax-inclusive figure.
 */
export function orderLinesToInvoiceLines(items: unknown): LineItemInput[] {
  if (!Array.isArray(items)) return []
  const lines: LineItemInput[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>

    const quantity = Number(item.quantity)
    const unitPrice = Number(item.unitPrice ?? item.unit_price ?? item.basePrice)
    if (!Number.isFinite(quantity) || quantity <= 0) continue
    if (!Number.isFinite(unitPrice) || unitPrice < 0) continue

    const name = String(item.name ?? '').trim()
    const taxRateId = item.taxRateId ?? item.tax_rate_id
    lines.push({
      // A line with no name is still a real charge; it must not vanish from the document.
      description: name || 'Item',
      quantity,
      unit_price: unitPrice,
      tax_rate_id: typeof taxRateId === 'string' && taxRateId ? taxRateId : null,
    })
  }
  return lines
}

export async function createInvoiceFromOrder(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  params: {
    orderId: string
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
  },
): Promise<InvoiceFromOrderResult> {
  const { orderId, restaurantId, createdBy } = params

  // ── 1. The order, read by the server, scoped to the caller's restaurant ────────────────────
  const { data, error } = await supabase
    .from('orders')
    .select(ORDER_COLUMNS)
    .eq('id', orderId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  if (error) throw error

  const order = data as OrderRow | null
  if (!order) {
    /**
     * The SAME answer for "no such order" and "an order at another venue". Distinguishing them
     * would let a caller enumerate order ids across tenants by reading the refusal.
     */
    return {
      ok: false,
      code: 'ORDER_NOT_FOUND',
      message: 'That order could not be found at this venue.',
    }
  }

  // ── 2. Eligibility ────────────────────────────────────────────────────────────────────────
  const status = String(order.status ?? '').toLowerCase()

  if (status === 'cancelled') {
    return {
      ok: false,
      code: 'ORDER_CANCELLED',
      message:
        'This order was cancelled, so it cannot be invoiced. Invoicing a cancelled order would ' +
        'bill a customer for food that was never supplied.',
    }
  }

  if (!(INVOICEABLE_ORDER_STATUSES as readonly string[]).includes(status)) {
    /**
     * IN-FLIGHT ORDERS ARE REFUSED, and this is a deliberate narrowing rather than an oversight.
     * An order that is pending, preparing or ready can still gain lines, lose lines, be amended or
     * be cancelled outright. An invoice is immutable once issued and can only be withdrawn through
     * a credit note, so issuing one against a moving total manufactures corrections.
     */
    return {
      ok: false,
      code: 'ORDER_NOT_FINAL',
      message:
        `This order is still ${order.status ?? 'in progress'}. An invoice can only be raised once ` +
        'the order is completed, because the amount can still change until then.',
    }
  }

  if (order.requires_reacceptance === true) {
    return {
      ok: false,
      code: 'ORDER_AWAITING_REACCEPTANCE',
      message:
        'This order was edited and is waiting to be re-accepted. Settle that first — its total is ' +
        'not final yet.',
    }
  }

  // ── 3. Refunds are a credit note's job, never a smaller invoice ───────────────────────────
  const projections = await getPaymentProjections(supabase, restaurantId, [order.id])
  const refunded = projections.get(order.id)?.refundedAmount ?? 0
  if (refunded > 0) {
    return {
      ok: false,
      code: 'ORDER_REFUNDED',
      message:
        'Money has been refunded against this order, so a plain invoice would overstate what is ' +
        'owed. Raise the invoice for the original sale and issue a credit note for the refund.',
    }
  }

  // ── 4. One invoice per order, unless the first was voided ─────────────────────────────────
  const { data: existingRows, error: existingError } = await supabase
    .from('business_documents')
    .select('id, document_number, status, document_type')
    .eq('order_id', order.id)
    .eq('restaurant_id', restaurantId)
  if (existingError) throw existingError

  const liveInvoice = (existingRows ?? []).find(
    (d) =>
      String((d as { document_type?: unknown }).document_type) === 'invoice' &&
      String((d as { status?: unknown }).status) !== 'void',
  ) as { id: string; document_number: string; status: string } | undefined

  if (liveInvoice) {
    /**
     * A VOIDED invoice is deliberately not a blocker: `correct_invoice()` voids the original and
     * issues a replacement, so an order whose only invoice is void has been corrected, not
     * double-billed. Uniqueness is enforced here rather than by an index because an index cannot
     * tell a correction from a duplicate.
     */
    return {
      ok: false,
      code: 'INVOICE_ALREADY_EXISTS',
      message: `Invoice ${liveInvoice.document_number} has already been raised for this order.`,
      existingDocument: {
        id: String(liveInvoice.id),
        document_number: String(liveInvoice.document_number),
        status: String(liveInvoice.status),
      },
    }
  }

  // ── 5. Lines ──────────────────────────────────────────────────────────────────────────────
  const lineItems = orderLinesToInvoiceLines(order.items)
  if (lineItems.length === 0) {
    return {
      ok: false,
      code: 'ORDER_HAS_NO_LINES',
      message: 'This order has no priced lines to invoice.',
    }
  }

  const orderTotal = Number(order.total)
  if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
    return {
      ok: false,
      code: 'ORDER_TOTAL_UNUSABLE',
      message: 'This order has no usable total, so an invoice cannot be raised from it.',
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
   * Whether this sale carried VAT, taken from the ORDER rather than guessed from the venue's
   * current settings -- the question is what the customer was charged, not what they would be
   * charged today.
   */
  const chargesVat = lineItems.some((l) => l.tax_rate_id != null)
  const required = requiredBillingFieldsFor(chargesVat)
  const profile = (billingProfile ?? {}) as Record<string, unknown>
  const missing = required.filter((field) => !String(profile[field] ?? '').trim())

  if (missing.length > 0) {
    /**
     * FAILS CLOSED, and before `get_next_document_number` is called. A refusal after the sequence
     * advanced would leave a gap in the invoice numbering for a document that was never issued,
     * which is exactly the property gapless numbering exists to provide.
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
    orderId: order.id,
    shipTo: {},
    billTo: params.billTo ?? {},
    lineItems,
    dueDate: params.dueDate ?? null,
    referenceNote: params.referenceNote ?? orderReference(order),
    createdBy,
  })

  // ── 8. The document must agree with the sale it describes ─────────────────────────────────
  const documentTotal = Number((created.document as { total?: unknown }).total)
  if (round2(documentTotal) !== round2(orderTotal)) {
    /**
     * The document row has already been written at this point, and it is deliberately NOT deleted:
     * `business_documents` is an append-only, gapless-numbered ledger and silently removing a row
     * from it is a worse defect than the one being reported. It is voided instead, which is the
     * engine's own vocabulary for "issued and withdrawn", leaving the number consumed and the
     * reason discoverable.
     */
    await supabase.from('business_documents').update({ status: 'void' }).eq('id', String((created.document as { id: unknown }).id))

    return {
      ok: false,
      code: 'DOCUMENT_TOTAL_DISAGREES_WITH_ORDER',
      message:
        `The invoice worked out to ${documentTotal.toFixed(2)} but the order was ` +
        `${orderTotal.toFixed(2)}. This usually means the venue's VAT rate changed after the sale. ` +
        'The invoice was voided rather than issued — it would have stated a figure the customer ' +
        'never paid.',
    }
  }

  return { ok: true, document: created.document, warnings: created.warnings }
}

function orderReference(order: OrderRow): string {
  const number = order.order_number != null ? `#${order.order_number}` : order.id
  const placed = order.placed_at ? ` placed ${String(order.placed_at).slice(0, 10)}` : ''
  const table = order.table_number ? ` · table ${order.table_number}` : ''
  return `FlashTap order ${number}${table}${placed}`
}
