import { createServerSupabaseClient } from './server'
import { supabase } from './client'
import { resolveRestaurantUuid } from './restaurants'

export type Order = Record<string, unknown> & {
  id: string
  restaurant_id: string
}

// CREATE ORDER
export async function createSupabaseOrder(data: {
  restaurant_id: string
  table_id?: string
  tab_id?: string
  order_number?: number
  table_number: number
  session_id: string
  member_session_id?: string
  status?: string
  payment_status?: string
  payment_method: string
  payment_channel?: string
  subtotal: number
  tax?: number
  total: number
  items: any[]
  order_instructions?: string
  tab_settlement_for_tab_id?: string
  paycloud_merchant_order_no?: string
  payment_checkout_url?: string
}) {
  const supabase = createServerSupabaseClient()
  const { data: order, error } = await supabase
    .from('orders')
    .insert({
      ...data,
      status: data.status || 'new',
      payment_status: data.payment_status || 'pending',
      placed_at: new Date().toISOString(),
    })
    .select()
    .single()
  if (error) throw error
  return order
}

// GET ORDER BY ID
export async function getSupabaseOrder(orderId: string) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single()
  if (error) throw error
  return data
}

// GET ORDERS BY RESTAURANT AND STATUS
export async function getSupabaseOrdersByStatus(restaurantId: string, status: string) {
  const restaurantUuid = await resolveRestaurantUuid(restaurantId)
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantUuid)
    .eq('status', status)
    .eq('is_closed', false)
    .order('placed_at', { ascending: true })
  if (error) throw error
  return data
}

// GET ORDERS BY TABLE
export async function getSupabaseOrdersByTable(restaurantId: string, tableNumber: number) {
  const restaurantUuid = await resolveRestaurantUuid(restaurantId)
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantUuid)
    .eq('table_number', tableNumber)
    .eq('is_closed', false)
    .order('placed_at', { ascending: true })
  if (error) throw error
  return data
}

// UPDATE ORDER STATUS
export async function updateSupabaseOrderStatus(orderId: string, status: string) {
  const supabase = createServerSupabaseClient()
  const timestamp = new Date().toISOString()
  const timestampField = `${status}_at`

  const { error } = await supabase
    .from('orders')
    .update({
      status,
      [timestampField]: timestamp,
    })
    .eq('id', orderId)
  if (error) throw error
}

// UPDATE ORDER PAYMENT STATUS
export async function updateSupabaseOrderPayment(
  orderId: string,
  paymentStatus: string,
  extras?: Record<string, any>
) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('orders')
    .update({
      payment_status: paymentStatus,
      ...(paymentStatus === 'paid' ? { paid_at: new Date().toISOString() } : {}),
      ...extras,
    })
    .eq('id', orderId)
  if (error) throw error
}

// UPDATE ORDER BY MERCHANT ORDER NO (for webhooks)
export async function updateSupabaseOrderByMerchantNo(
  merchantOrderNo: string,
  updates: Record<string, any>
) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('orders')
    .update(updates)
    .eq('paycloud_merchant_order_no', merchantOrderNo)
  if (error) throw error
}

// CLOSE TABLE ORDERS
export async function closeSupabaseTableOrders(restaurantId: string, tableNumber: number) {
  const restaurantUuid = await resolveRestaurantUuid(restaurantId)
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('orders')
    .update({
      is_closed: true,
      table_closed: true,
    })
    .eq('restaurant_id', restaurantUuid)
    .eq('table_number', tableNumber)
    .eq('is_closed', false)
  if (error) throw error
}

// SUBSCRIBE TO ORDERS BY STATUS (realtime)
export function subscribeSupabaseOrders(
  restaurantId: string,
  status: string,
  callback: (orders: any[]) => void
) {
  let removeChannel: (() => void) | undefined

  void resolveRestaurantUuid(restaurantId)
    .then((restaurantUuid) => {
      getSupabaseOrdersByStatus(restaurantId, status).then(callback).catch(console.error)

      const channel = supabase
        .channel(`orders-${restaurantUuid}-${status}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'orders',
            filter: `restaurant_id=eq.${restaurantUuid}`,
          },
          () => {
            getSupabaseOrdersByStatus(restaurantId, status).then(callback).catch(console.error)
          }
        )
        .subscribe()

      removeChannel = () => supabase.removeChannel(channel)
    })
    .catch(console.error)

  return () => {
    removeChannel?.()
  }
}

// GET ORDER NUMBER (next sequential number)
export async function getNextSupabaseOrderNumber(restaurantId: string): Promise<number> {
  const restaurantUuid = await resolveRestaurantUuid(restaurantId)
  const supabase = createServerSupabaseClient()
  const { count, error } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('restaurant_id', restaurantUuid)
  if (error) throw error
  return (count || 0) + 1
}

// Firebase-orders compatibility exports (migration bridge)
export async function getNextOrderNumber(restaurantId: string) {
  return getNextSupabaseOrderNumber(restaurantId)
}

export async function createOrder(orderData: any): Promise<string> {
  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orderData),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Order failed')
  return String(result.orderId)
}

export async function getOrders(restaurantId: string, status?: string): Promise<Order[]> {
  const restaurantUuid = await resolveRestaurantUuid(restaurantId)
  let query = supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantUuid)
    .order('placed_at', { ascending: false })
  if (status) query = query.eq('status', status)
  const { data, error } = await query
  if (error) throw error
  return (data || []) as Order[]
}

export async function getOrder(restaurantId: string, orderId: string): Promise<Order | null> {
  const restaurantUuid = await resolveRestaurantUuid(restaurantId)
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantUuid)
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw error
  return (data as Order) || null
}

export async function updateOrderStatus(restaurantId: string, orderId: string, status: string) {
  const restaurantUuid = await resolveRestaurantUuid(restaurantId)
  const patch: Record<string, any> = { status, updated_at: new Date().toISOString() }
  if (status === 'accepted') patch.accepted_at = new Date().toISOString()
  if (status === 'preparing') patch.preparing_at = new Date().toISOString()
  if (status === 'ready') patch.ready_at = new Date().toISOString()
  if (status === 'completed') patch.completed_at = new Date().toISOString()
  const { error } = await createServerSupabaseClient()
    .from('orders')
    .update(patch)
    .eq('restaurant_id', restaurantUuid)
    .eq('id', orderId)
  if (error) throw error
}

export async function updateOrderPayment(
  restaurantId: string,
  orderId: string,
  paymentStatus: string,
  paidBy?: string
) {
  return updateSupabaseOrderPayment(orderId, paymentStatus, {
    paid_by: paidBy || null,
  })
}

export function subscribeToOrders(
  restaurantId: string,
  status: string,
  callback: (orders: any[]) => void
) {
  return subscribeSupabaseOrders(restaurantId, status, callback)
}
