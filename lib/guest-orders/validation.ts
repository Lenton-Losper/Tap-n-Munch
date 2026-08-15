import type { GuestOrderRow } from './types'

export function parseOptionalInt(value: string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Open orders require restaurant binding PLUS table_number or session_id.
 * Closed/paid/completed receipt links still use UUID + restaurant_id (shareable
 * link pattern scoped to the restaurant the guest is browsing).
 */
export function guestCanAccessOrder(
  order: GuestOrderRow,
  params: {
    tableNumber?: number | null
    sessionId?: string | null
    /** Every OTHER id the client holds. See ownsOrder: one id is never the whole answer. */
    sessionIds?: Array<string | null | undefined>
    restaurantId?: string | null
  },
): boolean {
  const orderRestaurant = String(order.restaurant_id || '').trim()
  const wantRestaurant = String(params.restaurantId || '').trim()
  if (!wantRestaurant || !orderRestaurant || wantRestaurant !== orderRestaurant) {
    return false
  }

  if (order.is_closed === true) {
    return true
  }

  const paymentStatus = String(order.payment_status || '').toLowerCase()
  const status = String(order.status || '').toLowerCase()
  if (paymentStatus === 'paid' || status === 'completed' || status === 'cancelled') {
    return true
  }

  const table = params.tableNumber
  const session = String(params.sessionId || '').trim()

  if (table != null && Number.isFinite(table) && Number(order.table_number) === table) {
    return true
  }

  // Delegated rather than restated. This used to compare `params.sessionId` against
  // `order.session_id` only — one id, one column — which is what made it the ROOT of the three
  // session-id bugs rather than a fourth instance of them.
  //
  // Adding member_session_id is a NEW true path, so it is structurally more permissive. MEASURED
  // before shipping, on both environments: ZERO rows have a member_session_id that differs from
  // their session_id — 0 of 213 on staging, 0 of 1000 on production. So it admits nothing today
  // that was not already admitted. #262's seam does not change that either: it substitutes the
  // opaque member_key on the way OUT, in the response, and never writes it to the column this
  // reads.
  if (ownsOrder(order, [session, ...(params.sessionIds ?? [])])) {
    return true
  }

  return false
}

/**
 * The access question for actions that SEND the order somewhere, rather than answering the
 * caller who already holds its id.
 *
 * WHY THIS IS NOT `guestCanAccessOrder` (QRA-19). That helper short-circuits to `true` on
 * `is_closed`, `payment_status = 'paid'`, `status = 'completed'` and `status = 'cancelled'` —
 * the shareable-receipt-link pattern, and a deliberate decision. It is defensible for a READ,
 * where the caller already possesses the order UUID and learns nothing they could not learn by
 * opening the link they were given.
 *
 * It is not defensible for `POST /api/guest/orders/[orderId]/receipt/email`, which is a
 * different kind of act: it takes an attacker-chosen address and has the restaurant send that
 * customer's itemised receipt to it. Under the read rule the whole gate for a PAID order was
 * restaurant scope alone — and the restaurant uuid is in every menu URL. It also has a write
 * side effect: `issueReceiptForOrder` allocates a document number and inserts a
 * `receipt_documents` row for an order that had none, stamping today's numbering context onto
 * an older sale.
 *
 * So delivery requires what a READ of an OPEN order requires: the restaurant, plus either the
 * table the order sits at or a session id it was placed under. Concretely, the same predicate
 * with the terminal-state short-circuit removed.
 *
 * `guestCanAccessOrder` is deliberately left exactly as it is. Narrowing its table branch is
 * #279, it is sequenced behind a measurement, and `__tests__/owns-order-both-columns.test.ts`
 * pins the current behaviour by name — "recorded, not endorsed". A recorded decision is a
 * ruling already made, so this adds a stricter sibling rather than editing it.
 */
export function guestCanReceiveOrderDelivery(
  order: GuestOrderRow,
  params: {
    tableNumber?: number | null
    sessionId?: string | null
    sessionIds?: Array<string | null | undefined>
    restaurantId?: string | null
  },
): boolean {
  const orderRestaurant = String(order.restaurant_id || '').trim()
  const wantRestaurant = String(params.restaurantId || '').trim()
  if (!wantRestaurant || !orderRestaurant || wantRestaurant !== orderRestaurant) {
    return false
  }

  const table = params.tableNumber
  if (table != null && Number.isFinite(table) && Number(order.table_number) === table) {
    return true
  }

  return ownsOrder(order, [params.sessionId, ...(params.sessionIds ?? [])])
}

/**
 * THE ownership predicate. "Is this the customer's own order?" — asked in exactly one place.
 *
 * Two facts make this necessary, and both cost a bug on 2026-08-13 alone:
 *
 * 1. The app mints TWO session ids and nothing syncs them —
 *      lib/session.ts     flashtap_session_v1  localStorage  `sess_<uuid>`
 *      lib/tab-storage.ts tab_session_id       mirrored      `session_<ts>_<rand>`
 *    An order carries whichever the placing screen held, and the cart submits the TAB one. So
 *    the answer depends on EVERY id the client holds, never one. Use heldSessionIds() to build
 *    the list; do not assemble it per call site.
 *
 * 2. An order records the placer in TWO columns, `session_id` and `member_session_id`. Checking
 *    one was the third bug: guest queries had a sessionIds parameter for (1) but still compared
 *    a single column, My Orders showed an empty list, and the edit route answered 404 to the
 *    customer's own order.
 *
 * The rule is therefore: EVERY id, against BOTH columns. Any caller that restates it instead of
 * importing it is the fourth bug waiting to happen.
 *
 * NOT a credential check. A session id is a bearer value the client supplies, so this answers
 * "does the caller know an id this row was placed under", nothing stronger. What makes that
 * acceptable is that the ids are unguessable — see the note on `session_<ts>_<rand>` in the
 * issue filed alongside this, because that one is Math.random and weaker than it looks.
 */
export function ownsOrder(
  order: { session_id?: unknown; member_session_id?: unknown },
  sessionIds: Array<string | null | undefined>,
): boolean {
  const held = new Set(
    (sessionIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean),
  )
  if (held.size === 0) return false
  const rowIds = [
    String(order.session_id ?? '').trim(),
    String(order.member_session_id ?? '').trim(),
  ].filter(Boolean)
  return rowIds.some((rowId) => held.has(rowId))
}

/**
 * Strip the edit-lock token from any row about to leave for a guest, replacing it with the
 * boolean the UI actually needs.
 *
 * This is not tidiness, it is the hole customer order editing would otherwise open.
 * `edit_lock_token` is a CAPABILITY: PATCH /api/guest/orders/[orderId]/edit accepts it as proof
 * that the caller holds the lock. Every guest read path selects `*`, and guestCanAccessOrder
 * above deliberately admits an OPEN order on table_number alone — correct for a read on a
 * shared table, and the reason a second diner could otherwise fetch someone else's order, read
 * the token out of the response, and commit an edit to it despite the edit route's own session
 * check.
 *
 * So the token is returned exactly once, by the POST that mints it, to the session that
 * acquired it. Never by a read.
 *
 * Lives here rather than in queries.ts so it can be tested without a Supabase client: that
 * module builds one at import time, which turns any hermetic suite importing it into
 * `Tests: 0 total` — a suite that fails to LOAD looks like a failing test and is not one.
 */
export function redactGuestOrderRow(
  row: Record<string, unknown>,
  /**
   * Which table the row came from, stated rather than inferred. The customer's edit panel has
   * to pick between two status vocabularies, and every way of guessing from the row's own
   * contents is wrong for some row — `order_number` is 0 for a request AND for an order whose
   * number has not been allocated, and a request carries a payment_method like an order does.
   */
  surface: 'orders' | 'order_requests' = 'orders',
): Record<string, unknown> {
  const { edit_lock_token: token, ...rest } = row
  return { ...rest, surface, edit_lock_held: Boolean(String(token ?? '').trim()) }
}

/**
 * Payment references and merchant order numbers as this system issues them.
 *
 *   payment_reference          PAY-20260808-K7M2QRTZ   (lib/payment-reference.ts)
 *   paycloud_merchant_order_no FT17851579657531677     (lib/payments/terminal-merchant-order.ts)
 *
 * Both are alphanumeric with hyphens. Nothing legitimate contains a comma, a dot, or a bracket.
 */
const PAYMENT_REF_PATTERN = /^[A-Za-z0-9-]{1,64}$/

export function isWellFormedPaymentRef(ref: string): boolean {
  return PAYMENT_REF_PATTERN.test(String(ref ?? '').trim())
}

/**
 * PostgREST `.or()` filter for a payment reference — or `null` when the input is not a reference.
 *
 * THE DEFECT THIS CLOSES — unauthenticated cross-tenant order disclosure.
 *
 * This function used to interpolate the caller's string straight into the filter:
 *
 *     `paycloud_merchant_order_no.eq.${trimmed},payment_reference.eq.${trimmed}`
 *
 * The comma is PostgREST's term separator, so a reference containing one adds OR terms. The
 * filter string is PARSED by PostgREST — "exact equality, never parsed" is true of SQL and false
 * here. `/api/guest/orders/by-payment-ref` has no authentication of its own (middleware guards
 * `/admin/*` only), and when the incident was found the restaurant scope was optional too, so:
 *
 *     GET /api/guest/orders/by-payment-ref?ref=zzz,total.gte.0
 *
 * returned up to 15 full order rows -- customer_name, items, totals, session_id -- across ALL
 * restaurants, with no credential and without knowing any reference.
 *
 * Reproduced read-only on staging 2026-08-08: benign unguessable ref -> 0 rows; the injected ref
 * above -> 15 rows, which was that restaurant's entire order table. Re-measured on staging
 * 2026-08-11 against this branch's code, still read-only: benign -> 0 rows,
 * `<benign>,id.not.is.null` -> 213 rows across 2 restaurants before the fix, 0 after.
 *
 * On THIS branch the restaurant scope and the per-row `guestCanAccessOrder` gate are already
 * present (wave-2's #122), so the widening is bounded by them -- but neither stops the filter
 * being widened WITHIN a tenant, and a paid/closed row is reachable on restaurant scope alone.
 * The three doors close different holes; see fetchGuestOrdersByPaymentRef.
 *
 * This also made the CSPRNG hardening of payment references moot for this endpoint. There is no
 * need to guess a reference you can bypass.
 *
 * WHY VALIDATE RATHER THAN ESCAPE: PostgREST's quoting rules inside `or=()` are a second parser
 * to get right, and getting them subtly wrong fails open. The set of legitimate references is a
 * narrow, known charset, so rejecting everything else needs no parser at all. Returning `null`
 * rather than throwing lets the caller fail CLOSED -- an unparseable reference matches nothing,
 * which is what a lookup by a reference that cannot exist should do anyway.
 */
export function paymentRefOrFilter(ref: string): string | null {
  const trimmed = String(ref ?? '').trim()
  if (!isWellFormedPaymentRef(trimmed)) return null
  return `paycloud_merchant_order_no.eq.${trimmed},payment_reference.eq.${trimmed}`
}
