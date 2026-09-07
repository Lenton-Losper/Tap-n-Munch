/**
 * Single source of truth for how a payment line is labeled on receipts
 * (PDF / HTML / ESC-POS / SDK6). Cash never shows a card-style masked reference.
 */

export function formatPaymentLabel(
  method: string | null | undefined,
  maskedReference: string | null | undefined,
): string {
  const methodLabel = String(method || 'unknown').trim().toUpperCase() || 'UNKNOWN'
  const isCash =
    methodLabel === 'CASH' ||
    methodLabel === 'CASH_PENDING' ||
    methodLabel.startsWith('CASH')

  if (isCash) return 'CASH'

  /**
   * PAYTODAY PRINTS ITS OWN NAME AND NOTHING ELSE.
   *
   * The rule below is "anything that is not cash gets METHOD + a masked reference", which was true
   * while the only other method was card. PayToday has no gateway, so it has no reference to mask
   * -- and if anything ever populates payment_reference on such an order, this would print a
   * card-shaped artefact on a receipt for a payment no card was used for.
   *
   * Written as a display name rather than the raw upper-cased key so a customer's receipt says
   * "PAYTODAY" rather than the column value, and so a future method cannot inherit this branch by
   * accident.
   */
  if (methodLabel === 'PAYTODAY') return 'PAYTODAY'

  const ref = String(maskedReference || '').trim()
  return ref ? `${methodLabel} ${ref}` : methodLabel
}
