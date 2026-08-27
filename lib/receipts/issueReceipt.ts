import { createServerSupabaseClient } from '@/lib/supabase/server'

const DOCUMENT_TYPE = 'SALE_RECEIPT' as const
const DOCUMENT_NUMBER_PREFIX = 'RCT'
const DOCUMENT_NUMBER_SEQUENCE = 'rct_number_seq'

/**
 * Bumped when thermal/HTML/PDF layout semantics change in a way that would alter
 * regenerated output for the same snapshot. Frozen onto each issued document.
 * Byte-identical ESC/POS reprint also requires the same characterWidth at GET time
 * (width is a printer layout param, not frozen at issue — see terminal receipts GET).
 */
export const RECEIPT_RENDERER_VERSION = 'receipt-render-v2'

export interface ReceiptLineItem {
  name: string
  quantity: number
  unit_price: number
  /**
   * GROSS since #250. Do NOT read this as "gross" on a snapshot you did not just build:
   * on production the 820 receipts issued 2026-07-23..2026-08-25 carry the EX-VAT figure
   * here under the same `renderer_version`, and the document says nothing about which.
   * `receiptLineVatBasis()` below is the only sanctioned way to ask.
   */
  line_total: number
  /** Size / addon labels captured at issue time (display-only). */
  modifiers: string[]
  /**
   * #251 — the ex-VAT / tax split and the rate that produced it, frozen beside the gross
   * figure exactly as the TAX INVOICE has always done (`lib/documents/create-document.ts`
   * stores `line_total` + `line_subtotal` + `line_tax` + `tax_rate_percentage` +
   * `tax_inclusive`). Their presence is what makes a receipt line self-describing: a reader
   * can re-present it on either basis without consulting `orders.items`, and without
   * consulting `tax_rates`, which is mutable, has no `updated_at`, and would silently
   * backdate today's rate onto a historical sale.
   *
   * PERMANENTLY OPTIONAL. All 1,805 receipts already on production were issued before these
   * fields existed and no backfill is sanctioned (issue #251: converting them would mean
   * re-deriving from the order rows, which is a ruling, not an implementation choice).
   * Absent therefore means the basis is UNKNOWN — never "assume ex-VAT", never "assume
   * gross", and never "recompute it at today's rate".
   *
   * Written only when the source line carries all three of `subtotal`/`tax`/`total` AND they
   * reconcile to the cent against the figure actually printed. A cart-shaped line
   * (`contexts/cart-context.tsx`) has no `tax`, so it gets no split rather than a guessed one.
   */
  line_subtotal?: number
  line_tax?: number
  tax_rate_percentage?: number
  tax_inclusive?: boolean
}

/** The re-presentable form of one snapshot line. Only ever derived from stored figures. */
export interface ReceiptLineVatBasis {
  gross: number
  ex_vat: number
  tax: number
  /** null when the line stored the split but not the rate that produced it. */
  tax_rate_percentage: number | null
  tax_inclusive: boolean | null
}

export interface ReceiptPayment {
  method: string
  masked_reference: string
  amount: number
  paid_at: string
}

export interface ReceiptSnapshot {
  /** Renderer id that produced this snapshot shape / expected layout family. */
  renderer_version: string
  outlet: {
    restaurant_name: string
    address: string | null
    /** Frozen billing VAT / registration at issue time (null if unset). */
    vat_number: string | null
    registration_number: string | null
    /** Restaurant currency code/symbol at issue (e.g. NAD / N$). */
    currency: string
  }
  // Only ever populated for kiosk orders today (table and POS orders always send null),
  // and even kiosk customers can skip it -- always presence-check before displaying.
  customer_name: string | null
  /** Table number when known; 0 / null means no table (POS counter, kiosk). */
  table_number: number | null
  channel: string | null
  /** No staff column on orders yet — reserved null until POS waiter identity exists. */
  staff_name: string | null
  /**
   * The customer's order-level note (orders.order_instructions), frozen at issue time.
   * Optional because every snapshot issued before #135 was written without the field —
   * renderers must treat absent and null the same way.
   */
  order_instructions?: string | null
  line_items: ReceiptLineItem[]
  totals: {
    subtotal: number
    vat: number
    /** Always 0 until an order-level discount model exists. */
    discount: number
    grand_total: number
  }
  payments: ReceiptPayment[]
}

export interface ReceiptDocument {
  id: string
  restaurant_id: string
  /** Reserved for multi-outlet; not populated until outlets exist. */
  outlet_id: string | null
  order_id: string
  document_type: typeof DOCUMENT_TYPE
  document_number: string
  version: number
  status: 'issued' | 'void'
  currency: string
  snapshot_json: ReceiptSnapshot
  issued_at: string
  created_at: string
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' || Boolean(error?.message?.includes('duplicate key'))
}

/** Keeps the last 4 characters visible, masks the rest -- display-safe, never the raw gateway reference. */
function maskReference(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length)
  return '*'.repeat(trimmed.length - 4) + trimmed.slice(-4)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Integer cents, or null when the value is not a finite number. Money is never compared as a float. */
function cents(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) : null
}

/**
 * #251 — copies the per-line VAT split off a SERVER-PRICED order line, or returns nothing.
 *
 * `lib/orders/calculate-order-pricing.ts` already writes `subtotal` (ex-VAT), `tax`, `total`
 * (gross), `taxRatePercentage` and `taxInclusive` onto every priced line, and every one of the
 * 820 mis-based receipts on production still has all five on its order row. So this copies; it
 * never computes, and in particular never applies a rate to a figure.
 *
 * TWO GATES, both of which must pass, because a wrong split is worse than no split:
 *
 *  1. BOTH halves present and finite. `tax` is the discriminating key: a cart-shaped line has a
 *     `subtotal` and no `tax`, and `subtotal` means the GROSS charge in that shape, so treating a
 *     missing `tax` as zero would file a gross number under an ex-VAT name and stamp "VAT 0.00"
 *     on a receipt for a sale that did bear VAT.
 *
 *  2. `subtotal + tax` equals THE FIGURE THIS RECEIPT IS PRINTING, to the cent. Deliberately
 *     reconciled against `lineTotal` and not against `item.total`: `item.total` is only one of
 *     four keys `lineTotal` may resolve from, and a split that adds up to some number other than
 *     the one on the paper is exactly the disagreement #251 is about. `applyTaxToAmount` makes
 *     `subtotal + tax === total` exact in all three of its branches, so a genuine pricer line
 *     whose `total` is what gets printed always passes, and nothing else does.
 */
function extractLineVatSplit(
  item: Record<string, unknown>,
  lineTotal: number,
): Pick<ReceiptLineItem, 'line_subtotal' | 'line_tax' | 'tax_rate_percentage' | 'tax_inclusive'> {
  const subtotalCents = cents(item.subtotal)
  const taxCents = cents(item.tax)

  if (subtotalCents === null || taxCents === null) return {}
  if (subtotalCents + taxCents !== Math.round(lineTotal * 100)) return {}

  const split: Pick<
    ReceiptLineItem,
    'line_subtotal' | 'line_tax' | 'tax_rate_percentage' | 'tax_inclusive'
  > = {
    line_subtotal: subtotalCents / 100,
    line_tax: taxCents / 100,
  }

  const percentage = item.taxRatePercentage ?? item.tax_rate_percentage
  if (typeof percentage === 'number' && Number.isFinite(percentage)) {
    split.tax_rate_percentage = percentage
  }

  const inclusive = item.taxInclusive ?? item.tax_inclusive
  if (typeof inclusive === 'boolean') {
    split.tax_inclusive = inclusive
  }

  return split
}

/**
 * #251 — the ONLY sanctioned way to ask a snapshot line what its VAT basis is.
 *
 * Returns null when the line does not carry its own split. That null is the whole point of the
 * fix: it is the difference between "this receipt is 17.39 ex-VAT of a 20.00 sale" and "this
 * receipt says 17.39 and nobody alive knows whether that is the gross figure". Every one of the
 * 1,805 receipts issued before #251 answers null, and a caller that wants a number anyway must
 * go and get a ruling — it must not divide by a rate, because the only rate reachable at render
 * time is whatever `tax_rates` holds TODAY.
 *
 * The reconciliation re-check is not redundant with the write path: snapshots are opaque jsonb
 * that has been sitting in the database for months, and a row hand-edited to carry a split that
 * does not add up must answer null rather than be believed.
 */
export function receiptLineVatBasis(line: ReceiptLineItem): ReceiptLineVatBasis | null {
  const exVatCents = cents(line.line_subtotal)
  const taxCents = cents(line.line_tax)
  const grossCents = cents(line.line_total)

  if (exVatCents === null || taxCents === null || grossCents === null) return null
  if (exVatCents + taxCents !== grossCents) return null

  return {
    gross: grossCents / 100,
    ex_vat: exVatCents / 100,
    tax: taxCents / 100,
    tax_rate_percentage:
      typeof line.tax_rate_percentage === 'number' && Number.isFinite(line.tax_rate_percentage)
        ? line.tax_rate_percentage
        : null,
    tax_inclusive: typeof line.tax_inclusive === 'boolean' ? line.tax_inclusive : null,
  }
}

function extractModifiers(item: Record<string, unknown>): string[] {
  const out: string[] = []

  const size =
    (typeof item.size === 'string' && item.size.trim()) ||
    (item.selected_size &&
      typeof item.selected_size === 'object' &&
      typeof (item.selected_size as { name?: unknown }).name === 'string' &&
      String((item.selected_size as { name: string }).name).trim()) ||
    (item.selectedSize &&
      typeof item.selectedSize === 'object' &&
      typeof (item.selectedSize as { name?: unknown }).name === 'string' &&
      String((item.selectedSize as { name: string }).name).trim()) ||
    ''
  if (size) out.push(String(size))

  const rawAddons = item.selected_addons ?? item.selectedAddons ?? item.addons ?? item.modifiers
  if (Array.isArray(rawAddons)) {
    for (const entry of rawAddons) {
      if (typeof entry === 'string' && entry.trim()) {
        out.push(entry.trim())
        continue
      }
      if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
        const name = String((entry as { name: string }).name).trim()
        if (name) out.push(name)
      }
    }
  }

  return out
}

/**
 * order.items is opaque client-supplied JSON with no fixed schema; read defensively.
 *
 * The cart (components/menu/item-detail-modal.tsx calculatePrice()) stores the real,
 * already-quantity-and-addon-inclusive line charge as `subtotal`, and the per-unit menu
 * price as `basePrice` (camelCase -- not `base_price`). Every real order in production
 * uses that shape; the old unitPrice/unit_price/price/base_price fallback chain never
 * matched it, so unit_price and line_total silently rendered as 0 on every receipt ever
 * issued. `subtotal` is preferred for line_total since it's the authoritative charged
 * amount (it reflects addons/size modifiers that basePrice alone does not).
 */
export function toLineItem(raw: unknown): ReceiptLineItem {
  const item = (raw ?? {}) as Record<string, unknown>
  const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'Unknown item'
  const quantity =
    typeof item.quantity === 'number' && item.quantity > 0 ? item.quantity : 1

  /**
   * GROSS, NOT EX-VAT. #250, ruled by the owner 2026-08-16 closing #165 as its duplicate:
   * "make the receipt's `line_total` gross."
   *
   * THE TWO SHAPES, and why this ordering is right for both:
   *
   *  - A SERVER-PRICED line (`lib/orders/calculate-order-pricing.ts:192-198`) carries all three
   *    figures: `subtotal` = applied.subtotal (EX-VAT under an inclusive rate), `tax`, and
   *    `total` = applied.total (GROSS). Reading `subtotal` here is what produced #165's printed
   *    receipt -- `1 x N$25.00 ... N$21.74` -- a gross unit price beside an ex-VAT line total,
   *    which reads to a customer as an arithmetic error. `total` is the figure that belongs
   *    under a column headed Total beside a gross Unit Price.
   *
   *  - A CART-SHAPED line that never went through the pricer has NO `total` key
   *    (`contexts/cart-context.tsx`, `components/menu/item-detail-modal.tsx:174` store
   *    `subtotal: calculatePrice()`), and there `subtotal` is the already
   *    quantity-and-addon-inclusive charge -- itself gross. So the fallback lands on the gross
   *    figure for that shape too.
   *
   * Both shapes therefore yield GROSS, which is the whole point: the column must not change
   * meaning depending on which path built the line. The `subtotal` fallback is kept LAST rather
   * than deleted, because deleting it would regress every cart-shaped line to 0 -- the
   * always-0.00 bug the tests above this one exist to pin.
   *
   * This aligns the receipt with the TAX INVOICE, which has always stored the gross figure
   * (`lib/documents/create-document.ts:73`) and keeps the ex-VAT split beside it. #250 established
   * the invoice was the one already right.
   *
   * FUTURE RECEIPTS ONLY. Snapshots are frozen at issuance, so receipts already issued keep the
   * ex-VAT figure -- see #251, which is why they cannot be re-presented on the other basis.
   */
  const lineTotalRaw = item.total ?? item.lineTotal ?? item.line_total ?? item.subtotal
  const unitPriceRaw =
    item.unitPrice ?? item.unit_price ?? item.price ?? item.basePrice ?? item.base_price

  const hasUnitPrice = typeof unitPriceRaw === 'number' && Number.isFinite(unitPriceRaw)
  const hasLineTotal = typeof lineTotalRaw === 'number' && Number.isFinite(lineTotalRaw)

  const lineTotal = hasLineTotal
    ? round2(lineTotalRaw as number)
    : round2(quantity * (hasUnitPrice ? (unitPriceRaw as number) : 0))

  const unitPrice = hasUnitPrice
    ? (unitPriceRaw as number)
    : quantity > 0
      ? round2(lineTotal / quantity)
      : 0

  return {
    name,
    quantity,
    unit_price: unitPrice,
    line_total: lineTotal,
    modifiers: extractModifiers(item),
    // #251: present only when the source line carried a reconciling split. Spread last so an
    // absent split leaves the four keys off the object entirely rather than writing undefined --
    // `jsonb` would drop them either way, but the in-memory shape must match what is stored.
    ...extractLineVatSplit(item, lineTotal),
  }
}

async function generateDocumentNumber(
  supabase: ReturnType<typeof createServerSupabaseClient>,
): Promise<string> {
  const { data, error } = await supabase.rpc('generate_document_number', {
    p_prefix: DOCUMENT_NUMBER_PREFIX,
    p_sequence_name: DOCUMENT_NUMBER_SEQUENCE,
  })

  if (error || typeof data !== 'string' || !data) {
    throw new Error(
      `issueReceiptForOrder: failed to generate document number: ${error?.message ?? 'no data returned'}`,
    )
  }

  return data
}

/**
 * Issues the canonical SALE_RECEIPT for a paid order, or returns the existing one if
 * already issued. Idempotent under concurrent/duplicate calls via the DB unique
 * constraint on (order_id, document_type, version) -- insert first, then fetch on conflict,
 * never check-then-insert for the write path. We still short-circuit on an existing row
 * before allocating an RCT number so common retries do not burn sequence values.
 *
 * Concurrent races can still consume one unused RCT number when two issuers collide;
 * that is accepted — uniqueness of the surviving document is guaranteed by the constraint.
 *
 * outlet_id is intentionally null until multi-outlet support exists.
 */
export async function issueReceiptForOrder(orderId: string): Promise<ReceiptDocument> {
  const supabase = createServerSupabaseClient()

  const { data: existingEarly } = await supabase
    .from('receipt_documents')
    .select('*')
    .eq('order_id', orderId)
    .eq('document_type', DOCUMENT_TYPE)
    .eq('version', 1)
    .maybeSingle()

  if (existingEarly) {
    return existingEarly as ReceiptDocument
  }

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select(
      'id, restaurant_id, payment_status, payment_method, payment_reference, paycloud_merchant_order_no, paid_at, subtotal, tax, total, items, customer_name, table_number, channel, order_instructions',
    )
    .eq('id', orderId)
    .single()

  if (orderError || !order) {
    throw new Error(`issueReceiptForOrder: order not found (${orderId})`)
  }

  if (order.payment_status !== 'paid') {
    throw new Error(
      `issueReceiptForOrder: order ${orderId} has not reached final paid state (payment_status=${order.payment_status})`,
    )
  }

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .select('name, address, currency')
    .eq('id', order.restaurant_id)
    .single()

  if (restaurantError || !restaurant) {
    throw new Error(`issueReceiptForOrder: restaurant not found (${order.restaurant_id})`)
  }

  const { data: billing } = await supabase
    .from('restaurant_billing_profiles')
    .select('vat_number, registration_number')
    .eq('restaurant_id', order.restaurant_id)
    .maybeSingle()

  const { data: saleEvents, error: saleEventsError } = await supabase
    .from('payment_events')
    .select('amount, transaction_id, business_order_no, created_at')
    .eq('restaurant_id', order.restaurant_id)
    .eq('event_type', 'sale')
    .contains('order_ids', [orderId])

  if (saleEventsError) {
    throw new Error(
      `issueReceiptForOrder: failed to load payment events for order ${orderId}: ${saleEventsError.message}`,
    )
  }

  const lineItems = (Array.isArray(order.items) ? order.items : []).map(toLineItem)
  const subtotal = Number(order.subtotal) || 0
  const vat = Number(order.tax) || 0
  // No discount concept exists on orders yet -- snapshot records 0 until one is added.
  const discount = 0
  const grandTotal = Number(order.total) || 0
  const currency = String(restaurant.currency || 'NAD')

  let payments: ReceiptPayment[] = (saleEvents ?? []).map((event) => {
    const method = String(order.payment_method || 'unknown')
    const isCash = method.toLowerCase().startsWith('cash')
    const rawRef = String(event.transaction_id || event.business_order_no || '')
    return {
      // payment_events has no method column in Phase 1 -- the order's payment_method
      // is the best available source (one order, one settlement method).
      method,
      masked_reference: isCash ? '' : maskReference(rawRef),
      amount: Number(event.amount) || 0,
      paid_at: String(event.created_at),
    }
  })

  // When issuance runs from mark-paid (/payment, webhook, settle) before recordSaleEvent,
  // there may be no payment_events yet. Prefer sale events when present; otherwise synthesize
  // one payment line from the paid order so the frozen snapshot is not empty forever.
  if (payments.length === 0) {
    const method = String(order.payment_method || 'unknown')
    const isCash = method.toLowerCase().startsWith('cash')
    const ref = String(order.payment_reference || order.paycloud_merchant_order_no || '').trim()
    payments = [
      {
        method,
        masked_reference: isCash ? '' : maskReference(ref),
        amount: grandTotal,
        paid_at: String(order.paid_at || new Date().toISOString()),
      },
    ]
  }

  // Display-only, never trimmed to fit: it is the customer's own words (an allergy note is
  // the obvious case). Empty/whitespace is recorded as absent rather than as a blank line.
  const orderInstructionsRaw =
    typeof order.order_instructions === 'string' ? order.order_instructions.trim() : ''
  const orderInstructions = orderInstructionsRaw || null

  const tableNumberRaw = order.table_number
  const tableNumber =
    typeof tableNumberRaw === 'number' && Number.isFinite(tableNumberRaw) && tableNumberRaw > 0
      ? tableNumberRaw
      : null

  const snapshot: ReceiptSnapshot = {
    renderer_version: RECEIPT_RENDERER_VERSION,
    outlet: {
      restaurant_name: restaurant.name,
      address: restaurant.address ?? null,
      vat_number: billing?.vat_number?.trim() ? billing.vat_number.trim() : null,
      registration_number: billing?.registration_number?.trim()
        ? billing.registration_number.trim()
        : null,
      currency,
    },
    customer_name: order.customer_name ?? null,
    table_number: tableNumber,
    channel: order.channel ? String(order.channel) : null,
    staff_name: null,
    order_instructions: orderInstructions,
    line_items: lineItems,
    totals: {
      subtotal,
      vat,
      discount,
      grand_total: grandTotal,
    },
    payments,
  }

  const documentNumber = await generateDocumentNumber(supabase)

  const { data: created, error: insertError } = await supabase
    .from('receipt_documents')
    .insert({
      restaurant_id: order.restaurant_id,
      // outlet_id left null until multi-outlet exists
      order_id: orderId,
      document_type: DOCUMENT_TYPE,
      document_number: documentNumber,
      currency,
      snapshot_json: snapshot,
    })
    .select('*')
    .single()

  if (!insertError && created) {
    return created as ReceiptDocument
  }

  if (isUniqueViolation(insertError)) {
    const { data: existing, error: existingError } = await supabase
      .from('receipt_documents')
      .select('*')
      .eq('order_id', orderId)
      .eq('document_type', DOCUMENT_TYPE)
      .eq('version', 1)
      .single()

    if (existingError || !existing) {
      throw new Error(
        `issueReceiptForOrder: unique violation but no existing receipt found for order ${orderId}`,
      )
    }

    return existing as ReceiptDocument
  }

  throw new Error(
    `issueReceiptForOrder: failed to insert receipt for order ${orderId}: ${insertError?.message}`,
  )
}
