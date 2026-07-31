/**
 * Customer-facing status label for an order on the receipt / confirmation screens.
 *
 * Extracted from the receipt page so it can be tested directly: this is the code that decides
 * what a customer is told about their money, and it previously had a fallthrough that
 * rendered raw database enums ("WAITING_REVIEW") and the word "UNKNOWN" at them.
 *
 * Rules it must keep:
 *  - Never claim an outcome that has not happened. A QR submission sits in `waiting_review`
 *    until staff Accept, and nothing is charged before then, so it is neither paid nor failed.
 *  - Never surface a raw enum, an id, or "unknown".
 */

export type ReceiptStatusBadge = { label: string; className: string }

export function getReceiptStatusBadge(order: {
  status?: string | null
  payment_status?: string | null
}): ReceiptStatusBadge {
  const payment = String(order.payment_status || '').toLowerCase()
  const status = String(order.status || '').toLowerCase()

  if (payment === 'paid') {
    return { label: 'PAID', className: 'bg-green-100 text-green-800' }
  }
  // Still being confirmed: the restaurant has the order, no money has moved.
  if (payment === 'waiting_review' || status === 'waiting_review') {
    return { label: 'CONFIRMING PAYMENT…', className: 'bg-blue-50 text-blue-800' }
  }
  if (payment === 'cancelled' || payment === 'failed' || status === 'cancelled') {
    return { label: 'CANCELLED', className: 'bg-red-100 text-red-800' }
  }
  if (payment === 'pending') {
    return { label: 'PENDING', className: 'bg-yellow-100 text-yellow-800' }
  }
  if (status === 'accepted' || status === 'ready') {
    return {
      label: status === 'accepted' ? 'ACCEPTED' : 'PREPARING',
      className: 'bg-orange-100 text-orange-800',
    }
  }
  if (status === 'pending') {
    return { label: 'NEW', className: 'bg-muted text-foreground' }
  }
  // Anything we have no human label for is, from the customer's point of view, still being
  // worked out. Never echo the raw value back at them.
  return { label: 'CONFIRMING…', className: 'bg-muted text-foreground' }
}
