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
  /** Every session id the client holds; see the server-side counterpart for why there are two. */
  sessionIds?: Array<string | null | undefined>
  tabId?: string
  excludeSettlement?: boolean
  countOnly?: boolean
}): Promise<GuestOrdersApiResponse> {
  const qs = new URLSearchParams({ restaurantId: params.restaurantId })
  const sessionIds = [...new Set(
    [params.sessionId, ...(params.sessionIds ?? [])]
      .map((s) => String(s || '').trim())
      .filter(Boolean),
  )]
  // Repeated params rather than one comma-joined value, so a session id containing a comma
  // could never be split into two bogus ids server-side.
  for (const sid of sessionIds) qs.append('session_id', sid)
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

/**
 * `restaurantId` is REQUIRED, because the route now requires it (#122): without a restaurant
 * the lookup spans every tenant, so a reference that is merely KNOWN -- printed on a receipt,
 * carried on a gateway return URL -- reads any restaurant's order.
 *
 * `tableNumber` and `sessionId` are optional but matter more than they look. The server gates
 * each row through guestCanAccessOrder, which lets a PAID or closed order through on restaurant
 * scope alone but requires the table or the session for one that is still OPEN. The confirmation
 * screen polls while a payment is pending -- i.e. exactly when the order is open and unpaid --
 * so omitting both makes the poll return nothing until the payment lands, and the customer
 * watches an empty screen. Pass them wherever the caller has them.
 */
export async function fetchGuestOrdersByPaymentRef(params: {
  paymentRef: string
  restaurantId: string
  tableNumber?: number | null
  sessionId?: string | null
}): Promise<GuestOrderRow[]> {
  const restaurantId = params.restaurantId?.trim() || ''
  if (!restaurantId) return []

  const qs = new URLSearchParams({ ref: params.paymentRef.trim(), restaurantId })
  if (params.tableNumber != null && Number.isFinite(params.tableNumber)) {
    qs.set('table_number', String(params.tableNumber))
  }
  if (params.sessionId?.trim()) qs.set('session_id', params.sessionId.trim())

  const res = await fetch(`/api/guest/orders/by-payment-ref?${qs.toString()}`)
  const body = await parseGuestOrdersResponse(res)
  return body.orders
}

export const GUEST_ORDER_POLL_MS = 5000
