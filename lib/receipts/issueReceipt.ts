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
  line_total: number
  /** Size / addon labels captured at issue time (display-only). */
  modifiers: string[]
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

  const lineTotalRaw = item.subtotal ?? item.lineTotal ?? item.line_total
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
      'id, restaurant_id, payment_status, payment_method, payment_reference, paycloud_merchant_order_no, paid_at, subtotal, tax, total, items, customer_name, table_number, channel',
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

  let payments: ReceiptPayment[] = (saleEvents ?? []).map((event) => ({
    // payment_events has no method column in Phase 1 -- the order's payment_method
    // is the best available source (one order, one settlement method).
    method: order.payment_method || 'unknown',
    masked_reference: maskReference(String(event.transaction_id || event.business_order_no || '')),
    amount: Number(event.amount) || 0,
    paid_at: String(event.created_at),
  }))

  // When issuance runs from mark-paid (/payment, webhook, settle) before recordSaleEvent,
  // there may be no payment_events yet. Prefer sale events when present; otherwise synthesize
  // one payment line from the paid order so the frozen snapshot is not empty forever.
  if (payments.length === 0) {
    const ref = String(order.payment_reference || order.paycloud_merchant_order_no || '').trim()
    payments = [
      {
        method: order.payment_method || 'unknown',
        masked_reference: maskReference(ref),
        amount: grandTotal,
        paid_at: String(order.paid_at || new Date().toISOString()),
      },
    ]
  }

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
