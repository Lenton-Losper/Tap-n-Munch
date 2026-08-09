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

  if (session && String(order.session_id || '').trim() === session) {
    return true
  }

  return false
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
 * here. `/api/guest/orders/by-payment-ref` has no authentication (middleware guards `/admin/*`
 * only), and on `main` its `restaurantId` is optional, so:
 *
 *     GET /api/guest/orders/by-payment-ref?ref=zzz,total.gte.0
 *
 * returned up to 15 full order rows -- customer_name, items, totals, session_id -- across ALL
 * restaurants, with no credential and without knowing any reference.
 *
 * Reproduced read-only on staging 2026-08-08: benign unguessable ref -> 0 rows; the injected ref
 * above -> 15 rows, which was that restaurant's entire order table.
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
