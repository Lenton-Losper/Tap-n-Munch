import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { guestCanAccessOrder, paymentRefOrFilter, redactGuestOrderRow } from './validation'
import { normalizeOrderStatusForDisplay } from '@/lib/orders/active-order-visibility'
import { effectiveRequestPricing } from '@/lib/orders/order-request-pricing'
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
  // Precedence imported rather than restated. The Accept route charges from this same helper,
  // and the customer's confirmation screen must never show a figure different from the one
  // that gets charged — two copies of the rule is exactly how they come to disagree. Adds the
  // customer's own amendment as a third tier (order editing, 20260813120000).
  const { items, subtotal, tax, total } = effectiveRequestPricing(row)

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
    surface: 'order_requests',
    // Edit state. This mapper builds an explicit object rather than spreading the row, so
    // anything the customer's own screens need has to be named here — a pass-through-by-spread
    // would be quietly wrong the other way, exposing decided_by and idempotency_key to a guest.
    edit_lock_session_id: row.edit_lock_session_id ?? null,
    edit_lock_expires_at: row.edit_lock_expires_at ?? null,
    // Presence, not the token. The token is a capability: whoever holds it can commit an edit,
    // so it is returned once to the session that acquired it and never again by a read path.
    edit_lock_held: Boolean(String(row.edit_lock_token ?? '').trim()),
    customer_edited_at: row.customer_edited_at ?? null,
    customer_edit_count: Number(row.customer_edit_count) || 0,
    total_before_edit: row.total_before_edit ?? null,
  } as GuestOrderRow
}

export async function fetchGuestOrderById(
  orderId: string,
  params: {
    tableNumber?: number | null
    sessionId?: string | null
    /** Every id the client holds; forwarded to guestCanAccessOrder -> ownsOrder. */
    sessionIds?: Array<string | null | undefined>
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
    const order = redactGuestOrderRow({ id: String(data.id), ...data }) as GuestOrderRow
    if (!guestCanAccessOrder(order, accessParams)) {
      return { order: null, denied: true }
    }
    // Same read-time redaction as fetchGuestOrdersBySession -- see the note there (#262).
    const [redacted] = await redactGuestOrderMemberIds([order])
    return { order: redacted, denied: false }
  }

  let requestQuery = supabase.from('order_requests').select('*').eq('id', orderId)
  if (restaurantUuid) requestQuery = requestQuery.eq('restaurant_id', restaurantUuid)
  const { data: request, error: requestError } = await requestQuery.maybeSingle()

  if (requestError) throw requestError
  if (!request) return { order: null, denied: false }

  const requestRow = redactGuestOrderRow(
    { id: String(request.id), ...request },
    'order_requests',
  ) as GuestOrderRow
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

  /**
   * One query per PLACER COLUMN, merged in JS — never a single `.or()`.
   *
   * An order records who placed it in `session_id` OR `member_session_id` (see ownsOrder in
   * ./validation), so filtering one column is half an answer. The obvious one-query form is
   * `.or('session_id.in.(…),member_session_id.in.(…)')`, and that is exactly the #242/#254 shape:
   * the filter string is PARSED by PostgREST, the comma is its term separator, and these ids come
   * from the client. Two parser-free `.in()` calls and a Map cost one extra round trip and
   * reintroduce nothing.
   */
  const ordersQueryFor = (column: 'session_id' | 'member_session_id') => {
    let q = supabase
      .from('orders')
      .select('*', params.countOnly ? { count: 'exact', head: true } : undefined)
      .eq('restaurant_id', restaurantUuid)
      .in(column, sessionIds)
    if (tabId) q = q.eq('tab_id', tabId)
    if (params.excludeSettlement !== false) q = q.is('tab_settlement_for_tab_id', null)
    return q
  }

  /**
   * `countOnly` stays SINGLE-COLUMN, deliberately, and this is the measurement that makes it safe
   * rather than an assumption: on 2026-08-13, ZERO rows had a `member_session_id` differing from
   * their `session_id` — 0 of 213 on staging, 0 of 1000 on production — because
   * app/menu/[restaurantId]/cart/page.tsx:286 writes the one value into both columns.
   *
   * So the second query cannot add a row here today. It is omitted because counts CANNOT be
   * merged the way rows can: `count` comes back as a number with no ids, so adding the two counts
   * double-counts every row both columns match, which today is every row. A wrong count is worse
   * than a narrow one — these callers ask "does this session have orders?" and drive the stale-tab
   * cleanup that returns a customer to the menu.
   *
   * If that measurement ever stops holding, this needs ids rather than counts. Re-measure before
   * assuming it still does.
   */
  const query = ordersQueryFor('session_id')

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

  // Same both-columns treatment as orders above, same reason, same no- rule.
  const requestsQueryFor = (column: 'session_id' | 'member_session_id') => {
    let q = supabase
      .from('order_requests')
      .select('*', params.countOnly ? { count: 'exact', head: true } : undefined)
      .eq('restaurant_id', restaurantUuid)
      .in(column, sessionIds)
      .in('status', requestStatuses)
    if (tabId) q = q.eq('tab_id', tabId)
    return q
  }

  // countOnly: single column, for the reason measured above.
  const pendingQuery = requestsQueryFor('session_id')

  if (params.countOnly) {
    const [{ count, error }, { count: pendingCount, error: pendingError }] = await Promise.all([
      query,
      pendingQuery,
    ])
    if (error) throw error
    if (pendingError) throw pendingError
    return { orders: [], count: (count ?? 0) + (pendingCount ?? 0) }
  }

  // The row paths DO merge both placer columns — see ordersQueryFor / requestsQueryFor above.
  const [bySession, byMember, reqBySession, reqByMember] = await Promise.all([
    ordersQueryFor('session_id').order('placed_at', { ascending: false }),
    ordersQueryFor('member_session_id').order('placed_at', { ascending: false }),
    requestsQueryFor('session_id').order('placed_at', { ascending: false }),
    requestsQueryFor('member_session_id').order('placed_at', { ascending: false }),
  ])
  for (const result of [bySession, byMember, reqBySession, reqByMember]) {
    if (result.error) throw result.error
  }

  /** Merged by id, so a row that both columns match appears once rather than twice. */
  const mergeById = (...sets: Array<unknown[] | null>) => {
    const byId = new Map<string, Record<string, unknown>>()
    for (const set of sets) {
      for (const row of (set ?? []) as Record<string, unknown>[]) {
        byId.set(String(row.id), row)
      }
    }
    return [...byId.values()]
  }

  const data = mergeById(bySession.data, byMember.data)
  const pending = mergeById(reqBySession.data, reqByMember.data)

  // TWO read-time redactions, and neither replaces the other.
  //
  //   redactGuestOrderRow       strips edit_lock_token -- a CAPABILITY: whoever holds it can
  //                             commit an edit to the order.
  //   redactGuestOrderMemberIds substitutes member_session_id with an opaque per-tab key (#262),
  //                             because the tab and receipt screens join against the members
  //                             array and that array no longer carries raw session ids. Read-time
  //                             only: the stored column is untouched, and staff tooling, Accept
  //                             and settle all still see the real id.
  //
  // WHAT THE #262 REDACTION DOES NOT COVER -- corrected here rather than inherited, because the
  // comment this replaces claimed it stopped a reader getting "another diner's session id" and it
  // does not. It rewrites member_session_id ONLY; session_id is never touched. It also skips any
  // row with no tab_id -- measured on staging 2026-08-14, 104 of 213 orders (49%). And since the
  // cart writes ONE value into BOTH columns, the raw value still leaves in session_id on every
  // path, including by-payment-ref where a PAID order is admitted on restaurant scope alone.
  //
  // Redacting session_id as well was considered and RULED AGAINST: the client matches ownership
  // on the real value via heldSessionIds (see ownsOrder), so substituting it would break the
  // customer's own screens. Filed as a design question instead.
  const orders = await redactGuestOrderMemberIds(
    (data ?? []).map((row) => redactGuestOrderRow({ id: String(row.id), ...row })) as GuestOrderRow[],
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

  // BOTH redactions, in the order fetchGuestOrdersBySession uses -- see the note there for what
  // the #262 half does and does not cover.
  const orders = await redactGuestOrderMemberIds(
    (data ?? []).map((row) => redactGuestOrderRow({ id: String(row.id), ...row })) as GuestOrderRow[],
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
 * THREE INDEPENDENT DOORS, and this function is the only place all three are shut (#122, #254).
 * This branch already carried doors 2 and 3 from wave-2's #122; door 1 landed on `main` only,
 * which is what #254 is — the reproduction environment ran the injectable filter for three days
 * after production stopped doing so.
 *
 *   1. VALIDATED FILTER. `paymentRefOrFilter` returns null for anything that is not a
 *      well-formed reference, and this fails CLOSED on null. The `.or()` string is PARSED by
 *      PostgREST, so a comma in the caller's input adds OR terms -- "exact equality, never
 *      parsed" is true of SQL and false here, and this docblock used to assert it.
 *      `?ref=zzz,total.gte.0` returned 15 full order rows across ALL restaurants,
 *      unauthenticated, without knowing any reference. Reproduced read-only on staging
 *      2026-08-08; re-measured against THIS branch's code on staging 2026-08-11.
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

  // BOTH redactions -- see the note in fetchGuestOrdersBySession.
  //
  // This path matters most and is ALSO where the #262 comment overstated itself. DOOR 3 admits a
  // PAID order on restaurant scope alone, so a known payment reference reads back a full row. The
  // member_session_id substitution below helps; it does NOT stop session_id leaving, because that
  // column is never rewritten. Stripping edit_lock_token here is what stops the same reference
  // handing over an edit capability.
  return redactGuestOrderMemberIds(
    (data ?? [])
      .map((row) => redactGuestOrderRow({ id: String(row.id), ...row }) as GuestOrderRow)
      .filter((order) => guestCanAccessOrder(order, accessParams)),
  )
}
