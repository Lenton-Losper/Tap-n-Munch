/**
 * LIVE TOTALS -- what an order or tab is worth after voids, and what the device says when it does
 * not know.
 *
 * ==================================================================================================
 * WHY THIS EXISTS (sprint 2026-09-28)
 * ==================================================================================================
 *
 * `orders.total` is never rewritten by a void, so every surface that showed it kept charging and
 * displaying voided food. The payable figure is now the LIVE outstanding amount (see
 * lib/settlementAmount.ts); where the stored original differs, both are shown so a waiter holding
 * the customer's printed docket can see why the number went down.
 *
 * NOT YET SIGNED BY THE OWNER. The wording follows the sprint brief's own example
 * ("N$1,945 original · N$465 after voids"). Listed for sign-off in the sprint report; it lives in
 * its own file so none of the locked copy files (takePaymentCopy, orderPaymentSummaryCopy, ...)
 * had to be widened to hold it.
 */

/** `{original}` is the stored order total; `{live}` is what it is worth after voids. */
export const LIVE_TOTAL_AFTER_VOIDS = '{original} original · {live} after voids';

/** In place of a figure the device cannot prove. Never shown as N$0.00. */
export const LIVE_TOTAL_UNAVAILABLE = 'Amount unavailable — refresh';

/** The alert raised instead of charging, when what is owed cannot be known. */
export const LIVE_TOTAL_UNAVAILABLE_TITLE = 'Amount unavailable';
export const LIVE_TOTAL_UNAVAILABLE_BODY =
  'The bill for this table could not be read, so the amount to collect is not known. Pull down to refresh, then try again.';
