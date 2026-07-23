/**
 * Compact money for receipts. NAD / N$ → N$12.00; other codes → "USD 12.00".
 */
export function formatReceiptMoney(value: number, currency = 'NAD'): string {
  const amount = (Number.isFinite(value) ? value : 0).toFixed(2)
  const code = String(currency || 'NAD').trim() || 'NAD'
  if (code === 'NAD' || code === 'N$') return `N$${amount}`
  return `${code} ${amount}`
}
