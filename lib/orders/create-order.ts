import { createServerSupabaseClient } from '@/lib/supabase/server'
import { calculateOrderPricing } from '@/lib/orders/calculate-order-pricing'

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
}

export interface CreateOrderResult {
  orderId: string
  orderNumber: number
  restaurantId: string
  paymentStatus: string
}

export async function createOrder(params: CreateOrderParams): Promise<CreateOrderResult> {
  const supabase = createServerSupabaseClient()

  // Get next order number scoped to restaurant
  const { count } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('firebase_restaurant_id', params.firebaseRestaurantId)

  const orderNumber = (count || 0) + 1

  const pricing = await calculateOrderPricing(supabase, params.restaurantId, params.items)
  for (const warning of pricing.warnings) {
    console.warn('[ORDERS] pricing warning:', warning)
  }
  if (Number.isFinite(params.total) && Math.abs(params.total - pricing.total) > 0.01) {
    console.warn('[ORDERS] client/server total mismatch — using server-recomputed total', {
      restaurantId: params.restaurantId,
      clientSubtotal: params.subtotal,
      clientTotal: params.total,
      serverSubtotal: pricing.subtotal,
      serverTax: pricing.tax,
      serverTotal: pricing.total,
    })
  }

  const { data: newOrder, error: orderError } = await supabase
    .from('orders')
    .insert({
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
    })
    .select('id, restaurant_id, order_number, payment_status')
    .single()

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
