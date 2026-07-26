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

  const ref = String(maskedReference || '').trim()
  return ref ? `${methodLabel} ${ref}` : methodLabel
}
