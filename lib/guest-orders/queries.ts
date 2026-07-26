import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { guestCanAccessOrder, paymentRefOrFilter } from './validation'
import type { GuestOrderRow } from './types'

export async function resolveGuestRestaurantId(restaurantIdInput: string): Promise<string> {
  return resolveRestaurantUuid(restaurantIdInput)
}

/**
 * order_requests rows are not real orders (see Order Request / Accept model), so this maps
 * one into the same GuestOrderRow shape the confirmation screen already knows how to render,
 * with status set to a value the UI treats as pre-order ('waiting_review' or 'declined').
 * If the request has already been accepted, the caller re-fetches the real order instead --
 * a customer's confirmation link should transparently "graduate" from request to order
 * without changing URL.
 */
function mapOrderRequestToGuestRow(row: Record<string, unknown>): GuestOrderRow {
  const status = String(row.status || 'waiting_review')
  const items = Array.isArray(row.items_reviewed) ? row.items_reviewed : row.items
  const subtotal = row.subtotal_reviewed ?? row.subtotal
  const tax = row.tax_reviewed ?? row.tax
  const total = row.total_reviewed ?? row.total

  return {
    id: String(row.id),
    restaurant_id: row.restaurant_id as string | null,
    table_number: row.table_number as number | null,
    session_id: row.session_id as string | null,
    is_closed: false,
    status,
    payment_status: status,
    payment_method: row.payment_method,
    payment_channel: row.payment_channel as string | null,
    tab_id: row.tab_id as string | null,
    tab_settlement_for_tab_id: row.tab_settlement_for_tab_id as string | null,
    order_number: 0,
    placed_at: row.placed_at,
    items,
    subtotal,
    tax,
    total,
    customer_ready_to_pay: false,
  } as GuestOrderRow
}

export async function fetchGuestOrderById(
  orderId: string,
  params: { tableNumber?: number | null; sessionId?: string | null },
): Promise<{ order: GuestOrderRow | null; denied: boolean }> {
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle()

  if (error) throw error

  if (data) {
    const order = { id: String(data.id), ...data } as GuestOrderRow
    if (!guestCanAccessOrder(order, params)) {
      return { order: null, denied: true }
    }
    return { order, denied: false }
  }

  const { data: request, error: requestError } = await supabase
    .from('order_requests')
    .select('*')
    .eq('id', orderId)
    .maybeSingle()

  if (requestError) throw requestError
  if (!request) return { order: null, denied: false }

  const requestRow = { id: String(request.id), ...request } as GuestOrderRow
  if (!guestCanAccessOrder(requestRow, params)) {
    return { order: null, denied: true }
  }

  if (request.status === 'accepted' && request.accepted_order_id) {
    return fetchGuestOrderById(String(request.accepted_order_id), params)
  }

  return { order: mapOrderRequestToGuestRow(request), denied: false }
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
  const sessionId = String(params.sessionId || '').trim()

  // Fail closed for open-table polling: require session scope so one guest never
  // sees another customer's open orders/requests at the same table.
  if (!sessionId && !params.countOnly) {
    return { orders: [], count: 0 }
  }

  let query = supabase.from('orders').select('*', params.countOnly ? { count: 'exact', head: true } : undefined)

  query = query
    .eq('restaurant_id', restaurantUuid)
    .eq('table_number', params.tableNumber)
    .eq('is_closed', params.isClosed ?? false)

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

  // Also surface waiting_review order_requests for this session (Order Request model).
  let requestQuery = supabase
    .from('order_requests')
    .select('*')
    .eq('restaurant_id', restaurantUuid)
    .eq('table_number', params.tableNumber)
    .eq('status', 'waiting_review')
    .eq('session_id', sessionId)

  if (params.placedAfter) {
    requestQuery = requestQuery.gte('placed_at', params.placedAfter)
  }
  if (params.placedBefore) {
    requestQuery = requestQuery.lt('placed_at', params.placedBefore)
  }

  const { data: requests, error: requestError } = await requestQuery.order('placed_at', {
    ascending: false,
  })
  if (requestError) throw requestError

  const requestRows = (requests ?? []).map((row) => mapOrderRequestToGuestRow(row as Record<string, unknown>))
  const merged = [...requestRows, ...orders].sort((a, b) => {
    const aMs = a.placed_at ? new Date(String(a.placed_at)).getTime() : 0
    const bMs = b.placed_at ? new Date(String(b.placed_at)).getTime() : 0
    return bMs - aMs
  })

  return { orders: merged, count: merged.length }
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
