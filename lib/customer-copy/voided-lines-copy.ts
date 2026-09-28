/**
 * Customer wording for an order whose lines staff voided (Sprint 2026-09-28).
 *
 * amend_order_lines never rewrites an order, so a voided line stays on it and in its stored total.
 * These are the words a customer reads when that has happened: the line stays visible but is marked
 * as cancelled, and the order shows what it originally came to beside what it is worth now.
 *
 * Lives in lib/customer-copy so the owner sees it before it ships (#334). `{original}` and `{live}`
 * are substituted at the render site by plain `.replace()` with already-formatted amounts.
 */
export const VOIDED_LINES_COPY = {
  /** Under (or beside) a line staff voided. */
  lineVoidedByStaff: 'Cancelled by staff',
  /** In the order summary, the row above "Total" when voids moved it. */
  summaryOriginalTotal: 'Originally',
  /** One line, beside an order's figure: "N$1945.00 original · N$465.00 after voids". */
  originalAndLive: '{original} original · {live} after voids',
} as const
