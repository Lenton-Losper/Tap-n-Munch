import type { ReportData } from './get-report-data'

/**
 * TAKINGS BY PAYMENT METHOD — the end-of-day cash-up, in one place.
 *
 * ================================================================================================
 * WHY THIS MODULE EXISTS
 * ================================================================================================
 *
 * `getReportData` has computed `paymentMethodSplit` — method, order count and gross — for as long
 * as the daily email has existed. The email rendered it. The PDF and the CSV, which are what a
 * venue actually downloads at the end of a day, called the same function and DISCARDED it: the PDF
 * drew three summary cards (revenue, orders, average) and the CSV wrote the same three lines.
 *
 * So a manager closing up could see how much came in, and not how much of it was cash. The only
 * way to get that was to export the CSV and total the Payment Method column by hand in a
 * spreadsheet — which is exactly what a cash-up is, done manually, from a report that already had
 * the answer.
 *
 * Three renderers now read one module. Three copies of "which methods, in what order, under what
 * labels" is how a PDF and an email come to disagree about the same day's takings.
 *
 * ================================================================================================
 * THE FIGURES ARE GROSS, AND THAT IS NOT A DETAIL
 * ================================================================================================
 *
 * `paymentMethodSplit` is GROSS OF REFUNDS by construction — see get-report-data, which says so
 * and explains why: it is built from the raw `orders.payment_method`, the only place the real
 * method is in scope. So the parts sum to what was TAKEN, not to `totalRevenue`, which already has
 * distinct refunds subtracted.
 *
 * A cash-up that shows the parts and the net without the bridge between them looks like an
 * arithmetic error to the person counting the drawer. `reconciliation()` is that bridge, and it is
 * why this returns more than the rows.
 */

/**
 * `unknown` is the bucket get-report-data assigns when `orders.payment_method` is empty. It is a
 * real answer — an order that was reported paid with no method recorded — and it must not be
 * silently folded into cash, which is what a manager counting a drawer would assume from any
 * wording less explicit than this.
 */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  card: 'Card',
  cash: 'Cash',
  unknown: 'Unrecorded',
}

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method] ?? method
}

export type CashUpRow = { method: string; label: string; orders: number; gross: number }

/** The split as rendered: highest takings first, which is the order get-report-data sorts in. */
export function cashUpRows(report: ReportData): CashUpRow[] {
  return report.summary.paymentMethodSplit.map((p) => ({
    method: p.method,
    label: paymentMethodLabel(p.method),
    orders: p.orders,
    gross: p.gross,
  }))
}

export type CashUpReconciliation = {
  /** Sum of the rows above. What was taken, before refunds. */
  grossTaken: number
  /** Order count across the rows — equals summary.totalOrders, and is asserted to. */
  orders: number
  /** Distinct refunds, already subtracted from totalRevenue by get-report-data. */
  refunded: number
  /** grossTaken - refunded. The same figure as summary.totalRevenue. */
  net: number
}

/**
 * The bridge from the parts to the headline. Computed from the ROWS rather than read from
 * `summary.totalRevenue`, so that if the two ever disagree the report shows it instead of hiding
 * it behind a figure that was never derived from what is printed above it.
 */
export function cashUpReconciliation(report: ReportData): CashUpReconciliation {
  const rows = cashUpRows(report)
  const grossTaken = round2(rows.reduce((sum, r) => sum + r.gross, 0))
  const orders = rows.reduce((sum, r) => sum + r.orders, 0)
  const refunded = round2(Number(report.summary.refundedTotal) || 0)
  return { grossTaken, orders, refunded, net: round2(grossTaken - refunded) }
}

/**
 * Shown in place of the rows when nothing was taken. A zero-order day is a real answer and must
 * not render as an empty section, which reads as a broken report rather than a quiet day.
 */
export const NO_PAYMENTS_RECORDED = 'No payments recorded'

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
}
