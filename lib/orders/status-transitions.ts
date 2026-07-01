/** Status values staff may set via PATCH /api/orders/[orderId]/status */
export const STAFF_SETTABLE_STATUSES = new Set([
  'pending',
  'accepted',
  'preparing',
  'ready',
  'completed',
  'cancelled',
])

/**
 * Kitchen/dashboard workflow (uses "accepted", not terminal "confirmed").
 * Mirrors terminal isValidTransition() with dashboard vocabulary.
 */
export function isValidStaffStatusTransition(
  currentStatus: string,
  nextStatus: string,
): boolean {
  const current = String(currentStatus || '').trim()
  const next = String(nextStatus || '').trim()

  if (next === 'cancelled') {
    return current !== 'completed' && current !== 'cancelled'
  }

  const transitions: Record<string, string> = {
    pending: 'accepted',
    ready_for_terminal: 'accepted',
    accepted: 'preparing',
    preparing: 'ready',
    ready: 'completed',
  }

  return transitions[current] === next
}
