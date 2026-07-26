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

export function paymentRefOrFilter(ref: string): string {
  const trimmed = ref.trim()
  return `paycloud_merchant_order_no.eq.${trimmed},payment_reference.eq.${trimmed}`
}
