import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { guestCanAccessOrder, paymentRefOrFilter } from './validation'
import { normalizeOrderStatusForDisplay } from '@/lib/orders/active-order-visibility'
import { redactGuestOrderMemberIds } from '@/lib/tab-member-key'
import type { GuestOrderRow } from './types'

/**
 * order_requests statuses that are still the customer's business.
 *
 * `accepting` is the transient claim Accept takes before the order row exists
 * (app/api/order-requests/[requestId]/accept/route.ts), and it is already in
 * ACTIVE_ORDER_STATUSES for the same reason it belongs here: a request in that window has not
 * been accepted, has not been declined, and is emphatically not gone. Filtering it out at the
 * database is what let one request read "Waiting for Review" on its own page while being absent
 * from every list that should contain it (#219).
 */
const LIVE_REQUEST_STATUSES = ['waiting_review', 'accepting'] as const

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
  // Normalised, because the sentence above is a contract this function did not keep: `accepting`
  // is neither 'waiting_review' nor 'declined', and it reached renderers that had never heard of
  // it. my-orders/page.tsx ends `configs[status] || configs.pending`, so a request still awaiting
  // review was about to be labelled "New" -- the exact defect the comment above that table
  // records having already fixed once. normalizeOrderStatusForDisplay owns this vocabulary and
  // says in terms that anything making a status VISIBLE must run through it.
  const status = normalizeOrderStatusForDisplay(String(row.status || 'waiting_review'))
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
  params: {
    tableNumber?: number | null
    sessionId?: string | null
    restaurantId?: string | null
  },
): Promise<{ order: GuestOrderRow | null; denied: boolean }> {
  const supabase = createServerSupabaseClient()
  const restaurantUuid = params.restaurantId
    ? await resolveGuestRestaurantId(String(params.restaurantId))
    : null
  const accessParams = { ...params, restaurantId: restaurantUuid }

  let orderQuery = supabase.from('orders').select('*').eq('id', orderId)
  if (restaurantUuid) orderQuery = orderQuery.eq('restaurant_id', restaurantUuid)
  const { data, error } = await orderQuery.maybeSingle()

  if (error) throw error

  if (data) {
    const order = { id: String(data.id), ...data } as GuestOrderRow
    if (!guestCanAccessOrder(order, accessParams)) {
      return { order: null, denied: true }
    }
    // Same read-time redaction as fetchGuestOrdersBySession -- see the note there (#262).
    // #302/#305: the caller's own ids, so their OWN row keeps its raw values while every other
    // row is stripped. Only `sessionId` exists on this signature.
    const [redacted] = await redactGuestOrderMemberIds(
      [order],
      [params.sessionId].map((v) => String(v ?? '')).filter(Boolean),
    )
    return { order: redacted, denied: false }
  }

  let requestQuery = supabase.from('order_requests').select('*').eq('id', orderId)
  if (restaurantUuid) requestQuery = requestQuery.eq('restaurant_id', restaurantUuid)
  const { data: request, error: requestError } = await requestQuery.maybeSingle()

  if (requestError) throw requestError
  if (!request) return { order: null, denied: false }

  const requestRow = { id: String(request.id), ...request } as GuestOrderRow
  if (!guestCanAccessOrder(requestRow, accessParams)) {
    return { order: null, denied: true }
  }

  if (request.status === 'accepted' && request.accepted_order_id) {
    return fetchGuestOrderById(String(request.accepted_order_id), accessParams)
  }

  return { order: mapOrderRequestToGuestRow(request), denied: false }
}

export async function fetchGuestOrdersBySession(params: {
  restaurantId: string
  sessionId?: string | null
  /**
   * Additional session ids to match. The customer app mints two, in different storages and
   * different formats, and nothing syncs them:
   *   lib/session.ts        -> flashtap_session_v1 (localStorage)  `sess_<uuid>`
   *   contexts/tab-context  -> tab_session_id      (sessionStorage) `session_<ts>_<rand>`
   * Orders are submitted with whichever the placing screen held, so a lookup that knows only
   * one of them silently returns nothing. Callers pass every id they have.
   */
  sessionIds?: Array<string | null | undefined>
  tabId?: string | null
  excludeSettlement?: boolean
  countOnly?: boolean
  /**
   * Include requests staff have DECLINED. Default false, because this function serves two
   * different audiences and only one of them wants them -- see the status filter below.
   */
  includeDeclined?: boolean
}): Promise<{ orders: GuestOrderRow[]; count: number }> {
  const supabase = createServerSupabaseClient()
  const restaurantUuid = await resolveGuestRestaurantId(params.restaurantId)

  const sessionIds = [...new Set(
    [params.sessionId, ...(params.sessionIds ?? [])]
      .map((s) => String(s || '').trim())
      .filter(Boolean),
  )]
  const tabId = String(params.tabId || '').trim()

  // Fail closed: never dump a full tab by UUID alone. Require session scope
  // (same pattern as active-table). Tab id may still refine the filter.
  if (sessionIds.length === 0) {
    return { orders: [], count: 0 }
  }

  let query = supabase.from('orders').select('*', params.countOnly ? { count: 'exact', head: true } : undefined)

  query = query.eq('restaurant_id', restaurantUuid).in('session_id', sessionIds)

  if (tabId) {
    query = query.eq('tab_id', tabId)
  }

  if (params.excludeSettlement !== false) {
    query = query.is('tab_settlement_for_tab_id', null)
  }

  // A QR submission lives in order_requests until staff Accept, so counting `orders` alone
  // reports 0 for a customer who has just ordered. Mirrors the fallback that
  // fetchGuestOrderById and fetchGuestActiveTableOrders already do.
  //
  /*
   * A DECLINED REQUEST IS PART OF THE RECORD, BUT IT IS NOT LIVE.
   *
   * This function has two kinds of caller and they disagree about declined requests:
   *
   *  - The LIVE view -- the status tracker, the active-order banner, and the `countOnly`
   *    callers that really ask "does this session have orders?" (useTabHasOrders, and the cart
   *    page's stale-tab cleanup). For them a declined request is over:
   *    lib/orders/active-order-visibility.ts classifies `declined` as TERMINAL alongside
   *    `completed` and `cancelled`. Counting one would keep a dead tab alive and suppress the
   *    cleanup that returns the customer to the menu.
   *
   *  - The RECORD view -- the my-orders list. Filtering a declined request out of that list
   *    deleted the customer's only evidence they had ordered at all: by direct link they were
   *    told (fetchGuestOrderById applies no status filter), but on the list the row was simply
   *    gone, while the staff decline dialog promised "The customer will see it was declined".
   *
   * So the default is unchanged and the record view opts in, rather than widening the filter
   * for eight callers to serve one. Nothing here relaxes the session scope above: a declined
   * request is returned to the session that placed it and to nobody else.
   */
  const requestStatuses = params.includeDeclined
    ? [...LIVE_REQUEST_STATUSES, 'declined']
    : [...LIVE_REQUEST_STATUSES]

  let pendingQuery = supabase
    .from('order_requests')
    .select('*', params.countOnly ? { count: 'exact', head: true } : undefined)
    .eq('restaurant_id', restaurantUuid)
    .in('session_id', sessionIds)
    .in('status', requestStatuses)

  if (tabId) {
    pendingQuery = pendingQuery.eq('tab_id', tabId)
  }

  if (params.countOnly) {
    const [{ count, error }, { count: pendingCount, error: pendingError }] = await Promise.all([
      query,
      pendingQuery,
    ])
    if (error) throw error
    if (pendingError) throw pendingError
    return { orders: [], count: (count ?? 0) + (pendingCount ?? 0) }
  }

  const [{ data, error }, { data: pending, error: pendingError }] = await Promise.all([
    query.order('placed_at', { ascending: false }),
    pendingQuery.order('placed_at', { ascending: false }),
  ])
  if (error) throw error
  if (pendingError) throw pendingError

  // #262. `member_session_id` is the value the tab and receipt screens join against the members
  // array, and the members array no longer carries raw session ids -- so this side has to travel
  // through the same per-tab derivation or the pairing silently degrades to "Guest" for
  // everybody. Read-time only: the stored column is untouched, and staff tooling, Accept and
  // settle all still see the real id.
  //
  // order_requests rows are not mapped because mapOrderRequestToGuestRow builds a fixed shape
  // that has never included member_session_id.
  const orders = await redactGuestOrderMemberIds(
    (data ?? []).map((row) => ({ id: String(row.id), ...row })) as GuestOrderRow[],
    // #302/#305. Every id the client holds — this signature carries both.
    [params.sessionId, ...(params.sessionIds ?? [])].map((v) => String(v ?? '')).filter(Boolean),
  )
  const pendingRows = (pending ?? []).map((row) =>
    mapOrderRequestToGuestRow(row as Record<string, unknown>),
  )

  const merged = [...pendingRows, ...orders].sort((a, b) => {
    const aMs = a.placed_at ? new Date(String(a.placed_at)).getTime() : 0
    const bMs = b.placed_at ? new Date(String(b.placed_at)).getTime() : 0
    return bMs - aMs
  })

  return { orders: merged, count: merged.length }
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

  // Same read-time redaction as fetchGuestOrdersBySession -- see the note there (#262).
  const orders = await redactGuestOrderMemberIds(
    (data ?? []).map((row) => ({ id: String(row.id), ...row })) as GuestOrderRow[],
    // #302/#305. A table read returns EVERY diner's order, so this is where the ownership
    // scoping does the most work.
    [params.sessionId].map((v) => String(v ?? '')).filter(Boolean),
  )

  // Also surface still-live order_requests for this session (Order Request model). `accepting`
  // is included for the same reason as in fetchGuestOrdersBySession -- see
  // LIVE_REQUEST_STATUSES.
  let requestQuery = supabase
    .from('order_requests')
    .select('*')
    .eq('restaurant_id', restaurantUuid)
    .eq('table_number', params.tableNumber)
    .in('status', [...LIVE_REQUEST_STATUSES])
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

/**
 * Guest lookup of the orders behind a payment reference.
 *
 * THREE INDEPENDENT DOORS, and this function is the only place all three are shut (#122).
 * Production carried the first, staging carried the other two, and neither branch had the set --
 * so the union is written here rather than either side being promoted over the other.
 *
 *   1. VALIDATED FILTER. `paymentRefOrFilter` returns null for anything that is not a
 *      well-formed reference, and this fails CLOSED on null. The `.or()` string is PARSED by
 *      PostgREST, so a comma in the caller's input adds OR terms -- "exact equality, never
 *      parsed" is true of SQL and false here. `?ref=zzz,total.gte.0` returned 15 full order
 *      rows across ALL restaurants, unauthenticated, without knowing any reference.
 *      Reproduced read-only on staging 2026-08-08.
 *
 *   2. REQUIRED restaurantId. Without it the query spans every tenant, so a reference that IS
 *      known -- printed on a receipt, carried on a gateway return URL -- reads any restaurant's
 *      order. The route rejects an absent one with 400; this returns [] as a second line.
 *
 *   3. PER-ROW guestCanAccessOrder. Restaurant scope alone is not authorisation: an OPEN order
 *      needs the table or session that placed it, while a paid/closed one is reachable on
 *      restaurant scope (the shareable receipt-link pattern the sibling guest routes use).
 *
 * They close different doors and none subsumes another. Validation stops the filter being
 * widened; the scope stops a known reference crossing tenants; the per-row gate stops a
 * correctly-scoped caller reading someone else's live order. Dropping any one of the three
 * leaves a hole the other two do not cover, which is why each has its own test.
 */
export async function fetchGuestOrdersByPaymentRef(params: {
  paymentRef: string
  restaurantId: string
  tableNumber?: number | null
  sessionId?: string | null
}): Promise<GuestOrderRow[]> {
  const supabase = createServerSupabaseClient()
  const ref = params.paymentRef.trim()
  if (!ref || !params.restaurantId.trim()) return []

  // DOOR 1. A string carrying PostgREST filter syntax is not a reference that failed to match --
  // it is an attempt to widen the query, and it must return nothing rather than everything.
  const refFilter = paymentRefOrFilter(ref)
  if (!refFilter) return []

  // DOOR 2.
  const restaurantUuid = await resolveGuestRestaurantId(params.restaurantId.trim())

  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .or(refFilter)
    .limit(15)
    .eq('restaurant_id', restaurantUuid)

  if (error) throw error

  // DOOR 3.
  const accessParams = {
    restaurantId: restaurantUuid,
    tableNumber: params.tableNumber ?? null,
    sessionId: params.sessionId ?? null,
  }

  // Same read-time redaction as fetchGuestOrdersBySession -- see the note there (#262). It
  // matters more here than anywhere else: DOOR 3 lets a PAID order through on restaurant scope
  // alone, so without this a known payment reference reads back another diner's session id.
  return redactGuestOrderMemberIds(
    (data ?? [])
      .map((row) => ({ id: String(row.id), ...row }) as GuestOrderRow)
      .filter((order) => guestCanAccessOrder(order, accessParams)),
    // #302/#305, and DOOR 3 above is why: a PAID order is reachable on restaurant scope alone.
    [params.sessionId].map((v) => String(v ?? '')).filter(Boolean),
  )
}
