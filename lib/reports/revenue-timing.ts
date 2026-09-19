/**
 * WHEN DID THIS COUNT? — the date basis a report windows on.
 *
 * ==================================================================================================
 * THE TWO QUESTIONS, AND WHY ONE COLUMN CANNOT ANSWER BOTH
 * ==================================================================================================
 *
 *   "What did we SELL today?"      -> when the order was PLACED
 *   "What did we TAKE today?"      -> when the money ARRIVED
 *
 * `getReportData` windowed on `placed_at` for both, because there was only ever one report. There
 * are now two consumers with genuinely different meanings:
 *
 *   the sales/Order History export   legitimately about orders placed in a period
 *   the CASH-UP                      definitionally about money taken in a shift
 *
 * A cash-up on `placed_at` is wrong in a specific, recurring way. An order placed at 23:50 and paid
 * at 00:10 belongs to the second shift's drawer and the first shift's report -- so the till is
 * short by that amount and the next shift is over by it, every night, and neither operator can see
 * why. That is F8's midnight boundary.
 *
 * ==================================================================================================
 * THIS DOES NOT REDEFINE THE EXISTING REPORT
 * ==================================================================================================
 *
 * `'placed'` is the DEFAULT and is byte-identical to what shipped, so every existing caller --
 * the emailed report, the nightly cron, the Order History export -- is unchanged until it asks for
 * something else. Only the cash-up asks.
 *
 * The brief's instruction is explicit and is followed here: "Do not blindly replace every placed_at
 * reference. Only change reporting where the business meaning is payment/revenue timing."
 *
 * ==================================================================================================
 * WHAT A PAID BASIS EXCLUDES, DELIBERATELY
 * ==================================================================================================
 *
 * UNPAID ORDERS. They have no `paid_at`, so they fall outside a paid-basis window entirely. That is
 * correct for a cash-up: nothing was taken, so nothing belongs in the drawer. It is NOT correct for
 * a sales report, which is why the two bases exist.
 *
 * CANCELLED ORDERS are already excluded upstream by `status = 'completed'`; this changes nothing
 * about them.
 *
 * REFUNDS are not orders and never enter either window. They are reported from `payment_events`
 * through the payment projection, which is keyed on the refund's own timestamp -- a refund issued
 * today against last week's sale belongs to today's drawer and last week's revenue, and collapsing
 * those would be a different defect.
 *
 * ==================================================================================================
 * A HISTORICAL HAZARD, STATED SO IT IS NOT REDISCOVERED
 * ==================================================================================================
 *
 * `paid_at` IS NOT TRUSTWORTHY BEFORE 2026-07-30. Close Table bulk-stamped it across whole tables,
 * so a run of orders can share one timestamp that is not when any of them was paid. A cash-up is a
 * report about the current shift and never reaches back that far, which is what makes the paid
 * basis safe HERE. A historical revenue report on this basis would inherit that distortion, and
 * must not be built on it without correcting the data first.
 */

export const REPORT_DATE_BASES = ['placed', 'paid'] as const
export type ReportDateBasis = (typeof REPORT_DATE_BASES)[number]

/** The `orders` column a basis windows on. */
export function dateColumnForBasis(basis: ReportDateBasis): 'placed_at' | 'paid_at' {
  return basis === 'paid' ? 'paid_at' : 'placed_at'
}

export function normalizeReportDateBasis(value: unknown): ReportDateBasis {
  const s = String(value ?? '').trim().toLowerCase()
  // Anything unrecognised falls back to the shipped behaviour rather than to the newer one: an
  // unknown basis must not silently change what an existing report means.
  return s === 'paid' ? 'paid' : 'placed'
}

export type RevenueTimingRow = {
  placed_at?: unknown
  paid_at?: unknown
  payment_status?: unknown
}

/**
 * Does this order fall inside the window, on this basis?
 *
 * Exported and pure so the MIDNIGHT BOUNDARY can be tested directly rather than inferred from what
 * a query returned. The database applies the same rule as a filter; this is the same rule as a
 * predicate, and the tests assert they agree at the boundary.
 *
 * The window is HALF-OPEN: `start <= t < end`. An order paid at exactly 00:00:00 belongs to the
 * new day and to exactly one report -- the alternative, an inclusive end, double-counts every
 * transaction that lands on a midnight tick.
 */
export function fallsInWindow(
  row: RevenueTimingRow,
  basis: ReportDateBasis,
  startIso: string,
  endIsoExclusive: string,
): boolean {
  const raw = basis === 'paid' ? row?.paid_at : row?.placed_at
  if (raw == null || raw === '') return false

  const t = Date.parse(String(raw))
  if (!Number.isFinite(t)) return false

  const start = Date.parse(startIso)
  const end = Date.parse(endIsoExclusive)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false

  return t >= start && t < end
}

/**
 * Did this order's money arrive on a different calendar day from the one it was ordered on?
 *
 * Not a filter -- a FLAG. It is what makes a boundary crossing visible in a report instead of
 * being a discrepancy an operator has to reconstruct from two nights' figures.
 */
export function crossesDateBoundary(row: RevenueTimingRow, timeZone: string): boolean {
  const placed = row?.placed_at
  const paid = row?.paid_at
  if (placed == null || paid == null || placed === '' || paid === '') return false

  const a = new Date(String(placed))
  const b = new Date(String(paid))
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false

  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    return fmt.format(a) !== fmt.format(b)
  } catch {
    // An unknown timezone must not make this throw inside a report. Comparing in UTC is a weaker
    // answer than the venue's local day, and a weaker answer is better than a failed export.
    return a.toISOString().slice(0, 10) !== b.toISOString().slice(0, 10)
  }
}
