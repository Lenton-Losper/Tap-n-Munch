import { createServerSupabaseClient } from '@/lib/supabase/server'
import { calculateOrderPricing } from '@/lib/orders/calculate-order-pricing'
import { insertOrderWithAllocatedNumber } from '@/lib/orders/order-number'

export interface CreateOrderParams {
  restaurantId: string        // UUID
  firebaseRestaurantId: string
  tableNumber: number         // 0 for POS/no-table orders
  tableId: string | null
  sessionId: string | null
  items: unknown[]            // enriched with route_to by caller
  subtotal: number
  total: number
  paymentMethod: string
  paymentChannel: string | null
  paymentStatus: string
  orderInstructions: string | null
  tabId: string | null
  channel: string             // 'table' | 'kiosk' | 'pos' | 'online'
  customerName: string | null
  idempotencyKey: string | null
  memberSessionId: string | null
  tabSettlementForTabId: string | null
  isClosed?: boolean
  /**
   * Pricing that calculateOrderPricing ALREADY produced server-side and that the customer has
   * already been quoted. When set, createOrder persists it verbatim and does not re-price.
   *
   * Only the Accept path may set this. Re-pricing stays the default because the other caller,
   * app/api/terminal/orders, passes client-supplied subtotal/total -- for that path the
   * recompute is the anti-tampering control and must not be bypassed. Setting this field with
   * anything a client sent would be a price-tampering hole.
   */
  preauthorizedPricing?: {
    items: unknown[]
    subtotal: number
    tax: number
    total: number
  } | null
}

export interface CreateOrderResult {
  orderId: string
  orderNumber: number
  restaurantId: string
  paymentStatus: string
}

export async function createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  const supabase = createServerSupabaseClient()

  // Two pricing modes, and which one applies is the caller's explicit choice.
  //
  // Default (POS/terminal): re-price from the catalog and IGNORE the caller's numbers. There
  // the subtotal/total came from a client, so trusting them would let a caller set its own
  // prices.
  //
  // preauthorizedPricing (Accept): persist verbatim. Those figures are calculateOrderPricing
  // output taken at submission or staff review, they are what the customer's confirmation
  // screen shows, and they are what the Finatic checkout charges. Re-pricing them a second time
  // at Accept made the recorded total drift away from the amount quoted and actually taken.
  let pricing: { items: unknown[]; subtotal: number; tax: number; total: number }

  if (params.preauthorizedPricing) {
    pricing = params.preauthorizedPricing
  } else {
    const computed = await calculateOrderPricing(supabase, params.restaurantId, params.items)
    for (const warning of computed.warnings) {
      console.warn('[ORDERS] pricing warning:', warning)
    }
    if (Number.isFinite(params.total) && Math.abs(params.total - computed.total) > 0.01) {
      console.warn('[ORDERS] client/server total mismatch — using server-recomputed total', {
        restaurantId: params.restaurantId,
        clientSubtotal: params.subtotal,
        clientTotal: params.total,
        serverSubtotal: computed.subtotal,
        serverTax: computed.tax,
        serverTotal: computed.total,
      })
    }
    pricing = computed
  }

  // order_number is allocated per attempt inside the helper (#127): max(order_number)+1 behind a
  // unique index, retried only on a collision on that index. Every other error, including the
  // idempotency-key 23505 handled just below, comes back on the first attempt exactly as before.
  const { data: newOrder, error: orderError } = await insertOrderWithAllocatedNumber<{
    id: string
    restaurant_id: string
    order_number: number
    payment_status: string
  }>(
    supabase,
    params.firebaseRestaurantId,
    'id, restaurant_id, order_number, payment_status',
    (orderNumber) => ({
      restaurant_id: params.restaurantId,
      firebase_restaurant_id: params.firebaseRestaurantId,
      table_number: params.tableNumber,
      table_id: params.tableId,
      session_id: params.sessionId,
      member_session_id: params.memberSessionId,
      payment_method: params.paymentMethod,
      payment_channel: params.paymentChannel,
      payment_status: params.paymentStatus,
      status: 'pending',
      subtotal: pricing.subtotal,
      tax: pricing.tax,
      total: pricing.total,
      items: pricing.items,
      order_instructions: params.orderInstructions,
      tab_id: params.tabId,
      tab_settlement_for_tab_id: params.tabSettlementForTabId,
      order_number: orderNumber,
      channel: params.channel,
      customer_name: params.customerName,
      placed_at: new Date().toISOString(),
      idempotency_key: params.idempotencyKey,
      is_closed: params.isClosed ?? false,
    }),
  )

  if (orderError) {
    // Handle idempotency duplicate
    if (orderError.code === '23505' && params.idempotencyKey) {
      const { data: existing } = await supabase
        .from('orders')
        .select('id, restaurant_id, order_number, payment_status')
        .eq('idempotency_key', params.idempotencyKey)
        .single()
      if (existing) {
        return {
          orderId: existing.id,
          orderNumber: existing.order_number,
          restaurantId: existing.restaurant_id,
          paymentStatus: existing.payment_status,
        }
      }
    }
    throw new Error(orderError.message)
  }

  if (!newOrder?.restaurant_id) {
    throw new Error('Order created without restaurant_id')
  }

  return {
    orderId: newOrder.id,
    orderNumber: newOrder.order_number,
    restaurantId: newOrder.restaurant_id,
    paymentStatus: newOrder.payment_status,
  }
}
