/**
 * Shared helpers for terminal payment confirmation integrity.
 * Amounts are compared in major currency units (e.g. NAD) with cent tolerance.
 */

/** Max absolute difference allowed between client amount and server total (NAD cents ≈ 0.01). */
export const PAYMENT_AMOUNT_TOLERANCE = 0.01

export function amountsMatch(
  clientAmount: number,
  expectedAmount: number,
  tolerance = PAYMENT_AMOUNT_TOLERANCE,
): boolean {
  if (!Number.isFinite(clientAmount) || !Number.isFinite(expectedAmount)) {
    return false
  }
  return Math.abs(clientAmount - expectedAmount) <= tolerance
}

/** Payment statuses that may still be claimed as paid. */
export const CLAIMABLE_PAYMENT_STATUSES = ['unpaid', 'pending'] as const

export type ClaimablePaymentStatus = (typeof CLAIMABLE_PAYMENT_STATUSES)[number]

export function isClaimablePaymentStatus(status: unknown): boolean {
  const s = String(status ?? '')
    .trim()
    .toLowerCase()
  return (CLAIMABLE_PAYMENT_STATUSES as readonly string[]).includes(s)
}

/**
 * True only when an order has genuinely been paid.
 *
 * This is the counterpart to isClaimablePaymentStatus, which answers "may this still
 * be claimed" -- the wrong question when deciding whether money has actually been
 * collected. Normalised identically (trim + lowercase) so that a stray 'Paid' or
 * ' paid' can never be misclassified: a byte-exact SQL comparison such as
 * .eq('payment_status','paid') would get this wrong, so callers should read rows and
 * partition with this helper rather than filtering in the database.
 */
export function isPaidPaymentStatus(status: unknown): boolean {
  return String(status ?? '')
    .trim()
    .toLowerCase() === 'paid'
}
