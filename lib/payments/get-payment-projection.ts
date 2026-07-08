import { createServerSupabaseClient } from '@/lib/supabase/server'

export type PaymentStatus = 'paid' | 'partially_refunded' | 'refunded'

export interface PaymentProjection {
  originalAmount: number
  refundedAmount: number
  remainingRefundable: number
  paymentStatus: PaymentStatus
  currency: string
  /** SALE lineage key — shared by all orders in a multi-order (tab) settlement. */
  originBusinessOrderNo: string
}

function buildProjection(
  originalAmount: number,
  refundedAmount: number,
  currency: string,
  originBusinessOrderNo: string,
): PaymentProjection {
  const remainingRefundable = originalAmount - refundedAmount
  const paymentStatus: PaymentStatus =
    refundedAmount === 0
      ? 'paid'
      : remainingRefundable <= 0
        ? 'refunded'
        : 'partially_refunded'

  return {
    originalAmount,
    refundedAmount,
    remainingRefundable,
    paymentStatus,
    currency: String(currency || 'NAD'),
    originBusinessOrderNo,
  }
}

/**
 * Net revenue adjustment for a set of paid orders: subtract each SALE's
 * refundedAmount once (keyed by origin_business_order_no), not once per order.
 * Without this, a tab sale covering [A,B,C] would triple-subtract the same refund.
 */
export function sumDistinctRefundedAmounts(
  orderIds: Iterable<string>,
  projections: Map<string, PaymentProjection>,
): number {
  const seenOrigins = new Set<string>()
  let refunded = 0
  for (const orderId of orderIds) {
    const projection = projections.get(String(orderId))
    if (!projection) continue
    const origin = projection.originBusinessOrderNo
    if (seenOrigins.has(origin)) continue
    seenOrigins.add(origin)
    refunded += projection.refundedAmount
  }
  return refunded
}

/**
 * Single source of truth for sale + refund balance derived from payment_events.
 * Returns null when no SALE event exists for the order (e.g. orders that predate
 * SALE recording) — distinct from "paid with zero refunds".
 */
export async function getPaymentProjection(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantId: string,
  orderId: string,
): Promise<PaymentProjection | null> {
  const map = await getPaymentProjections(supabase, restaurantId, [orderId])
  return map.get(orderId) ?? null
}

/**
 * Batched equivalent of getPaymentProjection: two round-trips for the whole set
 * (sales overlapping any order_id, then refunds for those origin_business_order_nos)
 * instead of 2N sequential queries.
 */
export async function getPaymentProjections(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  restaurantId: string,
  orderIds: string[],
): Promise<Map<string, PaymentProjection>> {
  const result = new Map<string, PaymentProjection>()
  const uniqueOrderIds = [...new Set(orderIds.map((id) => String(id).trim()).filter(Boolean))]
  if (uniqueOrderIds.length === 0) return result

  const orderIdSet = new Set(uniqueOrderIds)

  const { data: sales, error: saleError } = await supabase
    .from('payment_events')
    .select('business_order_no, amount, currency, order_ids, created_at')
    .eq('restaurant_id', restaurantId)
    .eq('event_type', 'sale')
    .overlaps('order_ids', uniqueOrderIds)
    .order('created_at', { ascending: false })

  if (saleError) throw saleError

  // Newest sale first → first assignment wins (mirrors limit(1) desc per order).
  type SaleRow = {
    business_order_no: string
    amount: number
    currency: string
  }
  const saleByOrderId = new Map<string, SaleRow>()
  for (const sale of sales ?? []) {
    const ids = Array.isArray(sale.order_ids)
      ? sale.order_ids.map((id: unknown) => String(id))
      : []
    for (const id of ids) {
      if (!orderIdSet.has(id) || saleByOrderId.has(id)) continue
      saleByOrderId.set(id, {
        business_order_no: String(sale.business_order_no),
        amount: Number(sale.amount),
        currency: String(sale.currency || 'NAD'),
      })
    }
  }

  if (saleByOrderId.size === 0) return result

  const originNos = [
    ...new Set([...saleByOrderId.values()].map((s) => s.business_order_no)),
  ]

  const { data: priorRefunds, error: priorError } = await supabase
    .from('payment_events')
    .select('amount, origin_business_order_no')
    .eq('restaurant_id', restaurantId)
    .eq('event_type', 'refund_succeeded')
    .in('origin_business_order_no', originNos)

  if (priorError) throw priorError

  const refundedByOrigin = new Map<string, number>()
  for (const row of priorRefunds ?? []) {
    const origin = String(row.origin_business_order_no)
    refundedByOrigin.set(origin, (refundedByOrigin.get(origin) ?? 0) + Number(row.amount))
  }

  for (const [orderId, sale] of saleByOrderId) {
    const refundedAmount = refundedByOrigin.get(sale.business_order_no) ?? 0
    result.set(
      orderId,
      buildProjection(
        sale.amount,
        refundedAmount,
        sale.currency,
        sale.business_order_no,
      ),
    )
  }

  return result
}
