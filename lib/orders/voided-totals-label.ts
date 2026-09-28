/**
 * The customer-facing words for an order whose value staff voids have moved:
 *
 *     "N$1945.00 original · N$465.00 after voids"
 *
 * Null when nothing on the order was voided, so a screen keeps showing its single figure exactly as
 * before. Reads the fields lib/guest-orders/guest-financials.ts attaches (`live_total`,
 * `financials.voided_cents`); a row without them -- an older server, a failed projection read -- is
 * treated as unamended and gets null.
 *
 * Imports only the copy module: it renders in client components.
 */
import { VOIDED_LINES_COPY } from '@/lib/customer-copy/voided-lines-copy'

export function voidedTotalsLabel(
  row: { total?: unknown; live_total?: unknown; financials?: { voided_cents?: unknown } | null },
  currency = 'N$',
): string | null {
  const voided = Number(row?.financials?.voided_cents)
  const original = Number(row?.total)
  const live = Number(row?.live_total)
  if (!(voided > 0) || !Number.isFinite(original) || !Number.isFinite(live)) return null
  return VOIDED_LINES_COPY.originalAndLive
    .replace('{original}', `${currency}${original.toFixed(2)}`)
    .replace('{live}', `${currency}${live.toFixed(2)}`)
}

/** The figure a customer screen should show as the order's value: live when known, else stored. */
export function displayOrderTotal(row: { total?: unknown; live_total?: unknown }): number {
  const live = Number(row?.live_total)
  if (row?.live_total != null && Number.isFinite(live)) return live
  const stored = Number(row?.total)
  return Number.isFinite(stored) ? stored : 0
}
