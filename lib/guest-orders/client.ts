import type { GuestOrderRow, GuestOrdersApiResponse } from './types'

type FetchGuestOrderParams = {
  restaurantId: string
  tableNumber?: number
  sessionId?: string
  /** Every id the browser holds. Build it with heldSessionIds(); see ownsOrder for why. */
  sessionIds?: Array<string | null | undefined>
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
  // Repeated params, never comma-joined: a session id containing a comma could otherwise be
  // split into two bogus ids server-side. Same shape by-session already uses.
  for (const sid of [...new Set([params.sessionId, ...(params.sessionIds ?? [])]
    .map((v) => String(v ?? '').trim()).filter(Boolean))]) {
    qs.append('session_id', sid)
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
  /** Ask for declined requests too. Only the my-orders list does; see the server counterpart. */
  includeDeclined?: boolean
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
  if (params.includeDeclined) qs.set('includeDeclined', '1')

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
 * restaurantId is required, and the table/session binding is sent alongside it: the server gates
 * every row through guestCanAccessOrder, so an OPEN order only comes back to the table or session
 * that placed it. The gateway return URL carries both rid and table, so the confirmation screen
 * has them without asking the customer for anything.
 */
export async function fetchGuestOrdersByPaymentRef(params: {
  paymentRef: string
  restaurantId: string
  tableNumber?: number | null
  sessionId?: string | null
}): Promise<GuestOrderRow[]> {
  if (!params.restaurantId.trim()) return []
  const qs = new URLSearchParams({
    ref: params.paymentRef.trim(),
    restaurantId: params.restaurantId.trim(),
  })
  if (params.tableNumber != null && Number.isFinite(params.tableNumber)) {
    qs.set('table_number', String(params.tableNumber))
  }
  if (params.sessionId?.trim()) qs.set('session_id', params.sessionId.trim())

  const res = await fetch(`/api/guest/orders/by-payment-ref?${qs.toString()}`)
  const body = await parseGuestOrdersResponse(res)
  return body.orders
}

export const GUEST_ORDER_POLL_MS = 5000

// ---------------------------------------------------------------------------
// Order editing (before preparation starts)
// ---------------------------------------------------------------------------

export type EditLockGrant = {
  lockToken: string
  expiresAt: string
  surface: 'orders' | 'order_requests'
  items: Array<Record<string, unknown>>
  subtotal: number
  tax: number
  total: number
  orderInstructions: string | null
}

export type EditCommitResult = {
  totalChanged: boolean
  previousTotal: number
  total: number
  requiresReacceptance: boolean
  status?: string | null
  message: string
}

/**
 * A refusal the customer can be shown, carrying the server's own reason code. The reason
 * matters more than the status: 409 covers "the kitchen started", "someone else is editing"
 * and "your lock expired", and those are three different things to say.
 */
export class OrderEditRefused extends Error {
  readonly reason: string
  readonly httpStatus: number
  constructor(message: string, reason: string, httpStatus: number) {
    super(message)
    this.name = 'OrderEditRefused'
    this.reason = reason
    this.httpStatus = httpStatus
  }
}

async function editRequest<T>(
  orderId: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`/api/guest/orders/${encodeURIComponent(orderId)}/edit`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new OrderEditRefused(
      String(parsed.error || `Edit request failed (${res.status})`),
      String(parsed.reason || 'unknown'),
      res.status,
    )
  }
  return parsed as T
}

export function acquireOrderEditLock(params: {
  orderId: string
  restaurantId: string
  sessionIds: string[]
}): Promise<EditLockGrant> {
  return editRequest<EditLockGrant>(params.orderId, 'POST', {
    restaurantId: params.restaurantId,
    sessionIds: params.sessionIds,
  })
}

/**
 * `keep` names stored line indexes and the quantity remaining on each — never prices. The
 * server re-sums from its own priced lines, so nothing the customer's browser believes about
 * money reaches the order.
 */
export function commitOrderEdit(params: {
  orderId: string
  restaurantId: string
  sessionIds: string[]
  lockToken: string
  keep?: Array<{ index: number; quantity: number }>
  orderInstructions?: string | null
}): Promise<EditCommitResult> {
  return editRequest<EditCommitResult>(params.orderId, 'PATCH', {
    restaurantId: params.restaurantId,
    sessionIds: params.sessionIds,
    lockToken: params.lockToken,
    ...(params.keep ? { keep: params.keep } : {}),
    ...(params.orderInstructions !== undefined
      ? { orderInstructions: params.orderInstructions }
      : {}),
  })
}

export async function releaseOrderEditLock(params: {
  orderId: string
  restaurantId: string
  sessionIds: string[]
  lockToken: string
}): Promise<void> {
  // Best effort by design. The lock expires on its own after EDIT_LOCK_TTL_MS, so a release
  // that never lands costs the customer a wait and nothing else — throwing here would turn
  // closing an editor into an error the customer has to understand.
  try {
    await editRequest(params.orderId, 'DELETE', {
      restaurantId: params.restaurantId,
      sessionIds: params.sessionIds,
      lockToken: params.lockToken,
    })
  } catch {
    /* expired or already taken; nothing to report */
  }
}
