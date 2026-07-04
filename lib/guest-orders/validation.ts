import type { GuestOrderRow } from './types'

export function parseOptionalInt(value: string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Open orders require table_number or session_id binding.
 * Closed/paid/completed receipt links use UUID alone (shareable link pattern).
 */
export function guestCanAccessOrder(
  order: GuestOrderRow,
  params: { tableNumber?: number | null; sessionId?: string | null },
): boolean {
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
