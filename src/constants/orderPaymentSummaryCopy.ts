/**
 * ORDER-LEVEL PAYMENT SUMMARY -- the line above a group of items on Take Payment.
 *
 * ==================================================================================================
 * WHY THIS IS NOT IN takePaymentCopy.ts
 * ==================================================================================================
 *
 * That file is LOCKED. `takePaymentCopySignedOff.test.ts` asserts `Object.keys(Copy)` equals the
 * ten strings the owner signed on 2026-09-04, exactly -- "they must not move in either direction
 * without a decision", and adding an eleventh export is a move in one of those directions.
 *
 * Quietly widening the signed list to fit new copy in would defeat the lock, so these live here
 * instead, on their own signature.
 *
 * SIGNED BY THE OWNER 2026-09-22 and pinned by `orderPaymentSummaryCopySignedOff.test.ts` on the
 * same terms: four strings, locked in both directions, and nothing exported that was not signed.
 *
 * The per-item labels are untouched: TAKE_PAYMENT_LINE_PAID and TAKE_PAYMENT_LINE_PART_PAID still
 * say Paid and "{amount} still owed" on each row. This is the ORDER-level reading that sat above
 * them and said only "Order #12".
 */

/** Nothing on the order has been collected. `{amount}` is the whole order. */
export const ORDER_SUMMARY_UNPAID = 'UNPAID · {amount} remaining';

/**
 * Some items are settled and some are not -- the reading that used to be invisible.
 * `{paid}` of `{total}` items, and what is still to collect.
 */
export const ORDER_SUMMARY_PARTIAL = '{paid}/{total} PAID · {amount} remaining';

/** Everything on the order is collected. `{amount}` is what was collected, not a remainder. */
export const ORDER_SUMMARY_PAID = 'PAID · {amount}';

/**
 * The count WITHOUT a figure, for an order carrying a line the server could not price.
 *
 * A remainder containing an unknown is not a remainder: showing "NAD 0.00 remaining" next to an
 * unpriced item would read as nothing owed. The row itself already says
 * "No price — settle this order whole", so the heading states only what it knows.
 */
export const ORDER_SUMMARY_COUNT_ONLY = '{paid}/{total} PAID · amount not known';
