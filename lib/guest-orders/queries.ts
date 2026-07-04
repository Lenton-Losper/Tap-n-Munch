import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { guestCanAccessOrder, paymentRefOrFilter } from './validation'
import type { GuestOrderRow } from './types'

export async function resolveGuestRestaurantId(restaurantIdInput: string): Promise<string> {
  return resolveRestaurantUuid(restaurantIdInput)
}

export async function fetchGuestOrderById(
  orderId: string,
  params: { tableNumber?: number | null; sessionId?: string | null },
): Promise<{ order: GuestOrderRow | null; denied: boolean }> {
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle()

  if (error) throw error
  if (!data) return { order: null, denied: false }

  const order = { id: String(data.id), ...data } as GuestOrderRow
  if (!guestCanAccessOrder(order, params)) {
    return { order: null, denied: true }
  }

  return { order, denied: false }
}

export async function fetchGuestOrdersBySession(params: {
  restaurantId: string
  sessionId?: string | null
  tabId?: string | null
  excludeSettlement?: boolean
  countOnly?: boolean
}): Promise<{ orders: GuestOrderRow[]; count: number }> {
  const supabase = createServerSupabaseClient()
  const restaurantUuid = await resolveGuestRestaurantId(params.restaurantId)

  let query = supabase.from('orders').select('*', params.countOnly ? { count: 'exact', head: true } : undefined)

  query = query.eq('restaurant_id', restaurantUuid)

  const sessionId = String(params.sessionId || '').trim()
  const tabId = String(params.tabId || '').trim()

  if (sessionId) {
    query = query.eq('session_id', sessionId)
  }
  if (tabId) {
    query = query.eq('tab_id', tabId)
  }

  if (params.excludeSettlement !== false) {
    query = query.is('tab_settlement_for_tab_id', null)
  }

  if (params.countOnly) {
    const { count, error } = await query
    if (error) throw error
    return { orders: [], count: count ?? 0 }
  }

  const { data, error } = await query.order('placed_at', { ascending: false })
  if (error) throw error

  const orders = (data ?? []).map((row) => ({ id: String(row.id), ...row })) as GuestOrderRow[]
  return { orders, count: orders.length }
}

export async function fetchGuestActiveTableOrders(params: {
  restaurantId: string
  tableNumber: number
  sessionId?: string | null
  isClosed?: boolean
  paymentStatus?: string | null
  paymentChannel?: string | null
  placedAfter?: string | null
  placedBefore?: string | null
  countOnly?: boolean
}): Promise<{ orders: GuestOrderRow[]; count: number }> {
  const supabase = createServerSupabaseClient()
  const restaurantUuid = await resolveGuestRestaurantId(params.restaurantId)

  let query = supabase.from('orders').select('*', params.countOnly ? { count: 'exact', head: true } : undefined)

  query = query
    .eq('restaurant_id', restaurantUuid)
    .eq('table_number', params.tableNumber)
    .eq('is_closed', params.isClosed ?? false)

  const sessionId = String(params.sessionId || '').trim()
  if (sessionId) {
    query = query.eq('session_id', sessionId)
  }

  if (params.paymentStatus) {
    query = query.eq('payment_status', params.paymentStatus)
  }
  if (params.paymentChannel) {
    query = query.eq('payment_channel', params.paymentChannel)
  }
  if (params.placedAfter) {
    query = query.gte('placed_at', params.placedAfter)
  }
  if (params.placedBefore) {
    query = query.lt('placed_at', params.placedBefore)
  }

  if (params.countOnly) {
    const { count, error } = await query
    if (error) throw error
    return { orders: [], count: count ?? 0 }
  }

  const { data, error } = await query.order('placed_at', { ascending: false })
  if (error) throw error

  const orders = (data ?? []).map((row) => ({ id: String(row.id), ...row })) as GuestOrderRow[]
  return { orders, count: orders.length }
}

export async function fetchGuestOrdersByPaymentRef(params: {
  paymentRef: string
  restaurantId?: string | null
}): Promise<GuestOrderRow[]> {
  const supabase = createServerSupabaseClient()
  const ref = params.paymentRef.trim()
  if (!ref) return []

  let query = supabase.from('orders').select('*').or(paymentRefOrFilter(ref)).limit(15)

  if (params.restaurantId?.trim()) {
    const restaurantUuid = await resolveGuestRestaurantId(params.restaurantId.trim())
    query = query.eq('restaurant_id', restaurantUuid)
  }

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map((row) => ({ id: String(row.id), ...row })) as GuestOrderRow[]
}
