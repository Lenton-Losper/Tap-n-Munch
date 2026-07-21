import { createServerSupabaseClient } from '@/lib/supabase/server'

const DOCUMENT_TYPE = 'SALE_RECEIPT' as const
const DOCUMENT_NUMBER_PREFIX = 'RCT'
const DOCUMENT_NUMBER_SEQUENCE = 'rct_number_seq'

export interface ReceiptLineItem {
  name: string
  quantity: number
  unit_price: number
  line_total: number
}

export interface ReceiptPayment {
  method: string
  masked_reference: string
  amount: number
  paid_at: string
}

export interface ReceiptSnapshot {
  outlet: {
    restaurant_name: string
    address: string | null
  }
  // Only ever populated for kiosk orders today (table and POS orders always send null),
  // and even kiosk customers can skip it -- always presence-check before displaying.
  customer_name: string | null
  line_items: ReceiptLineItem[]
  totals: {
    subtotal: number
    vat: number
    discount: number
    grand_total: number
  }
  payments: ReceiptPayment[]
}

export interface ReceiptDocument {
  id: string
  restaurant_id: string
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
 * never check-then-insert.
 */
export async function issueReceiptForOrder(orderId: string): Promise<ReceiptDocument> {
  const supabase = createServerSupabaseClient()

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, restaurant_id, payment_status, payment_method, subtotal, tax, total, items, customer_name')
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

  const payments: ReceiptPayment[] = (saleEvents ?? []).map((event) => ({
    // payment_events has no method column in Phase 1 -- the order's payment_method
    // is the best available source (one order, one settlement method).
    method: order.payment_method || 'unknown',
    masked_reference: maskReference(String(event.transaction_id || event.business_order_no || '')),
    amount: Number(event.amount) || 0,
    paid_at: String(event.created_at),
  }))

  const snapshot: ReceiptSnapshot = {
    outlet: {
      restaurant_name: restaurant.name,
      address: restaurant.address ?? null,
    },
    customer_name: order.customer_name ?? null,
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
      order_id: orderId,
      document_type: DOCUMENT_TYPE,
      document_number: documentNumber,
      currency: restaurant.currency || 'NAD',
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
