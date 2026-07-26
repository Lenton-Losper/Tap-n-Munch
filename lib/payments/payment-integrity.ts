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
