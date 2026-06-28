import { createServerSupabaseClient } from './server'
import { supabase } from './client'
import {
  resolveOrderRestaurantScope,
  resolveRestaurantUuid,
  type OrderRestaurantScope,
} from './restaurants'

export type Order = Record<string, unknown> & {
  id: string
  restaurant_id: string
}

// CREATE ORDER
export async function createSupabaseOrder(data: {
  restaurant_id: string
  firebase_restaurant_id?: string
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
      status: data.status || 'pending',
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
export async function getSupabaseOrdersByStatus(
  restaurantId: string,
  status: string,
  scopeOverride?: OrderRestaurantScope | null
) {
  const scope = scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', scope.restaurantId)
    .eq('status', status)
    .eq('is_closed', false)
    .order(status === 'completed' ? 'completed_at' : 'placed_at', {
      ascending: status !== 'completed',
      nullsFirst: false,
    })
  if (error) {
    throw error
  }
  return data ?? []
}

// GET ORDERS BY TABLE
export async function getSupabaseOrdersByTable(restaurantId: string, tableNumber: number) {
  const scope = await resolveOrderRestaurantScope(restaurantId)
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', scope.restaurantId)
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
  const scope = await resolveOrderRestaurantScope(restaurantId)
  const supabase = createServerSupabaseClient()
  const { error } = await supabase
    .from('orders')
    .update({
      is_closed: true,
      table_closed: true,
    })
    .eq('restaurant_id', scope.restaurantId)
    .eq('table_number', tableNumber)
    .eq('is_closed', false)
  if (error) throw error
}

/** Hosted checkout orders awaiting payment (not a workflow status). */
export async function getPendingHostedOrders(
  restaurantId: string,
  scopeOverride?: OrderRestaurantScope | null
) {
  const scope = scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', scope.restaurantId)
    .eq('payment_status', 'pending')
    .eq('payment_channel', 'hosted')
    .eq('is_closed', false)
    .order('placed_at', { ascending: false })
  if (error) {
    throw error
  }
  return data ?? []
}

/** All open orders for a restaurant (single query for dashboard realtime cache). */
export async function getAllOpenRestaurantOrders(
  restaurantId: string,
  scopeOverride?: OrderRestaurantScope | null
) {
  const scope = scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', scope.restaurantId)
    .eq('is_closed', false)
    .order('placed_at', { ascending: false })
  if (error) {
    throw error
  }
  return data ?? []
}

export type OrderRealtimePayload = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE'
  new: Record<string, unknown> | null
  old: Record<string, unknown> | null
}

/**
 * Single Realtime channel for all order INSERT/UPDATE/DELETE events for a restaurant.
 */
export function subscribeRestaurantOrdersRealtime(
  restaurantId: string,
  callbacks: {
    onInitial: (orders: any[]) => void
    onChange: (payload: OrderRealtimePayload) => void
    onStatus?: (status: string) => void
  },
  scopeOverride?: OrderRestaurantScope | null
) {
  let channel: ReturnType<typeof supabase.channel> | null = null
  let cancelled = false

  const cleanup = () => {
    cancelled = true
    if (channel) {
      supabase.removeChannel(channel)
      channel = null
    }
  }

  const setup = async () => {
    const scope =
      scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))

    if (cancelled) return

    try {
      const orders = await getAllOpenRestaurantOrders(restaurantId, scope)
      if (!cancelled) callbacks.onInitial(orders)
    } catch (error) {
      console.error(error)
      if (!cancelled) callbacks.onInitial([])
    }

    if (cancelled) return

    const channelName = `orders-channel-${scope.restaurantId}`
    const nextChannel = supabase.channel(channelName)

    const onOrderChange = (payload: {
      eventType?: string
      new?: Record<string, unknown>
      old?: Record<string, unknown>
    }) => {
      if (cancelled) return
      const eventType = payload.eventType
      if (eventType !== 'INSERT' && eventType !== 'UPDATE' && eventType !== 'DELETE') return

      callbacks.onChange({
        eventType,
        new: (payload.new as Record<string, unknown> | undefined) ?? null,
        old: (payload.old as Record<string, unknown> | undefined) ?? null,
      })
    }

    nextChannel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'orders',
        filter: `restaurant_id=eq.${scope.restaurantId}`,
      },
      onOrderChange
    )

    nextChannel.subscribe((status: string) => {
      callbacks.onStatus?.(status)
    })

    if (cancelled) {
      supabase.removeChannel(nextChannel)
      return
    }

    channel = nextChannel
  }

  void setup().catch(console.error)

  return cleanup
}

// SUBSCRIBE TO ORDERS BY STATUS (realtime)
export function subscribeSupabaseOrders(
  restaurantId: string,
  status: string,
  callback: (orders: any[]) => void,
  scopeOverride?: OrderRestaurantScope | null
) {
  return subscribeRestaurantOrders(
    restaurantId,
    (scope) => getSupabaseOrdersByStatus(restaurantId, status, scope),
    callback,
    scopeOverride,
    status
  )
}

/** Realtime subscription for hosted pending-payment orders (payment filter, not workflow status). */
export function subscribePendingHostedOrders(
  restaurantId: string,
  callback: (orders: any[]) => void,
  scopeOverride?: OrderRestaurantScope | null
) {
  return subscribeRestaurantOrders(
    restaurantId,
    (scope) => getPendingHostedOrders(restaurantId, scope),
    callback,
    scopeOverride,
    'pending-hosted'
  )
}

function subscribeRestaurantOrders(
  restaurantId: string,
  fetchOrders: (scope: OrderRestaurantScope) => Promise<any[]>,
  callback: (orders: any[]) => void,
  scopeOverride: OrderRestaurantScope | null | undefined,
  channelSuffix: string
) {
  let removeChannel: (() => void) | undefined
  let cancelled = false

  const setup = async () => {
    const scope =
      scopeOverride ?? (await resolveOrderRestaurantScope(restaurantId))

    if (cancelled) return

    const refetchOrders = () => {
      if (cancelled) return
      fetchOrders(scope)
        .then((orders) => {
          if (!cancelled) callback(Array.isArray(orders) ? orders : [])
        })
        .catch(console.error)
    }

    refetchOrders()
    if (cancelled) return

    const channelName = `orders-${scope.restaurantId}-${channelSuffix}`
    const channel = supabase.channel(channelName)

    const onOrderChange = (_payload: { eventType?: string; new?: Record<string, unknown> }) => {
      refetchOrders()
    }

    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'orders',
        filter: `restaurant_id=eq.${scope.restaurantId}`,
      },
      onOrderChange
    )

    channel.subscribe()

    removeChannel = () => supabase.removeChannel(channel)
  }

  void setup().catch(console.error)

  return () => {
    cancelled = true
    removeChannel?.()
  }
}

// GET ORDER NUMBER (next sequential number)
export async function getNextSupabaseOrderNumber(restaurantId: string): Promise<number> {
  const scope = await resolveOrderRestaurantScope(restaurantId)
  const supabase = createServerSupabaseClient()
  const { count, error } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('restaurant_id', scope.restaurantId)
  if (error) throw error
  return (count || 0) + 1
}

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
  const scope = await resolveOrderRestaurantScope(restaurantId)
  let query = supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', scope.restaurantId)
    .order('placed_at', { ascending: false })
  if (status) query = query.eq('status', status)
  const { data, error } = await query
  if (error) throw error
  return (data || []) as Order[]
}

export async function getOrder(restaurantId: string, orderId: string): Promise<Order | null> {
  const scope = await resolveOrderRestaurantScope(restaurantId)
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', scope.restaurantId)
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw error
  return (data as Order) || null
}

export async function updateOrderStatus(restaurantId: string, orderId: string, status: string) {
  const scope = await resolveOrderRestaurantScope(restaurantId)
  const patch: Record<string, any> = { status, updated_at: new Date().toISOString() }
  if (status === 'accepted') patch.accepted_at = new Date().toISOString()
  if (status === 'ready') patch.ready_at = new Date().toISOString()
  if (status === 'completed') patch.completed_at = new Date().toISOString()
  const { error } = await createServerSupabaseClient()
    .from('orders')
    .update(patch)
    .eq('restaurant_id', scope.restaurantId)
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

export { resolveOrderRestaurantScope, resolveRestaurantUuid } from './restaurants'
