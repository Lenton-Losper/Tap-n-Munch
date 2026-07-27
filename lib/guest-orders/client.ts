import type { GuestOrderRow, GuestOrdersApiResponse } from './types'

type FetchGuestOrderParams = {
  restaurantId: string
  tableNumber?: number
  sessionId?: string
}

async function parseGuestOrdersResponse(res: Response): Promise<GuestOrdersApiResponse> {
  const body = (await res.json().catch(() => ({}))) as GuestOrdersApiResponse & { error?: string }
  if (!res.ok) {
    throw new Error(body.error || `Guest orders request failed (${res.status})`)
  }
  return body
}

export async function fetchGuestOrderById(
  orderId: string,
  params: FetchGuestOrderParams,
): Promise<GuestOrderRow | null> {
  const qs = new URLSearchParams({ restaurantId: params.restaurantId })
  if (params.tableNumber != null && Number.isFinite(params.tableNumber)) {
    qs.set('table_number', String(params.tableNumber))
  }
  if (params.sessionId?.trim()) {
    qs.set('session_id', params.sessionId.trim())
  }
  const res = await fetch(`/api/guest/orders/${encodeURIComponent(orderId)}?${qs.toString()}`)
  if (res.status === 404) return null
  const body = await parseGuestOrdersResponse(res)
  return body.orders[0] ?? null
}

export async function fetchGuestOrdersBySession(params: {
  restaurantId: string
  sessionId?: string
  tabId?: string
  excludeSettlement?: boolean
  countOnly?: boolean
}): Promise<GuestOrdersApiResponse> {
  const qs = new URLSearchParams({ restaurantId: params.restaurantId })
  if (params.sessionId?.trim()) qs.set('session_id', params.sessionId.trim())
  if (params.tabId?.trim()) qs.set('tabId', params.tabId.trim())
  if (params.excludeSettlement === false) qs.set('excludeSettlement', '0')
  if (params.countOnly) qs.set('countOnly', '1')

  const res = await fetch(`/api/guest/orders/by-session?${qs.toString()}`)
  return parseGuestOrdersResponse(res)
}

export async function fetchGuestActiveTableOrders(params: {
  restaurantId: string
  tableNumber: number
  sessionId?: string
  paymentStatus?: string
  paymentChannel?: string
  placedAfter?: string
  placedBefore?: string
  countOnly?: boolean
}): Promise<GuestOrdersApiResponse> {
  const qs = new URLSearchParams({
    restaurantId: params.restaurantId,
    table_number: String(params.tableNumber),
  })
  if (params.sessionId?.trim()) qs.set('session_id', params.sessionId.trim())
  if (params.paymentStatus) qs.set('payment_status', params.paymentStatus)
  if (params.paymentChannel) qs.set('payment_channel', params.paymentChannel)
  if (params.placedAfter) qs.set('placed_after', params.placedAfter)
  if (params.placedBefore) qs.set('placed_before', params.placedBefore)
  if (params.countOnly) qs.set('countOnly', '1')

  const res = await fetch(`/api/guest/orders/active-table?${qs.toString()}`)
  return parseGuestOrdersResponse(res)
}

export async function fetchGuestOrdersByPaymentRef(params: {
  paymentRef: string
  restaurantId?: string
}): Promise<GuestOrderRow[]> {
  const qs = new URLSearchParams({ ref: params.paymentRef.trim() })
  if (params.restaurantId?.trim()) qs.set('restaurantId', params.restaurantId.trim())
  const res = await fetch(`/api/guest/orders/by-payment-ref?${qs.toString()}`)
  const body = await parseGuestOrdersResponse(res)
  return body.orders
}

export const GUEST_ORDER_POLL_MS = 5000
