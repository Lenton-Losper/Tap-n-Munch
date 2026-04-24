import { createServerSupabaseClient } from './server'
import { supabase } from './client'

// CREATE ORDER
export async function createSupabaseOrder(data: {
  firebase_restaurant_id: string
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
      placed_at: new Date().toISOString()
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
export async function getSupabaseOrdersByStatus(
  restaurantId: string,
  status: string
) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('firebase_restaurant_id', restaurantId)
    .eq('status', status)
    .eq('is_closed', false)
    .order('placed_at', { ascending: true })
  if (error) throw error
  return data
}

// GET ORDERS BY TABLE
export async function getSupabaseOrdersByTable(
  restaurantId: string,
  tableNumber: number
) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('firebase_restaurant_id', restaurantId)
    .eq('table_number', tableNumber)
    .eq('is_closed', false)
    .order('placed_at', { ascending: true })
  if (error) throw error
  return data
}

// UPDATE ORDER STATUS
export async function updateSupabaseOrderStatus(
  orderId: string,
  status: string
) {
  const supabase = createServerSupabaseClient()
  const timestamp = new Date().toISOString()
  const timestampField = `${status}_at`

  const { error } = await supabase
    .from('orders')
    .update({
      status,
      [timestampField]: timestamp
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
      ...extras
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
export async function closeSupabaseTableOrders(
  restaurantId: string,
  tableNumber: number
) {
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('orders')
    .update({
      is_closed: true,
      table_closed: true
    })
    .eq('firebase_restaurant_id', restaurantId)
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
  // Initial fetch
  getSupabaseOrdersByStatus(restaurantId, status)
    .then(callback)
    .catch(console.error)

  // Realtime subscription
  const channel = supabase
    .channel(`orders-${restaurantId}-${status}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'orders',
        filter: `firebase_restaurant_id=eq.${restaurantId}`
      },
      () => {
        getSupabaseOrdersByStatus(restaurantId, status)
          .then(callback)
          .catch(console.error)
      }
    )
    .subscribe()

  // Return unsubscribe function
  return () => supabase.removeChannel(channel)
}

// GET ORDER NUMBER (next sequential number)
export async function getNextSupabaseOrderNumber(
  restaurantId: string
): Promise<number> {
  const supabase = createServerSupabaseClient()
  const { count, error } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('firebase_restaurant_id', restaurantId)
  if (error) throw error
  return (count || 0) + 1
}
