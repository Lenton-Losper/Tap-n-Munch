/**
 * TAKE PAYMENT, BY ITEM (Ship 1b).
 *
 * ============================================================================================
 * NOT YET SIGNED -- PENDING THE OWNER'S SIGN-OFF
 * ============================================================================================
 *
 * Every string below is shown to a waiter at a table with a customer waiting. None of it ships in
 * a binary until the owner has read it. The lock test (takePaymentCopySignedOff.test.ts) is
 * written against these exact strings so a later edit cannot slip through unnoticed.
 *
 * The existing labels -- "Settle Selected", "Settle Entire Tab", "Take Cash" -- are UNCHANGED and
 * are deliberately not restated here. The interaction was already right; only what the list shows
 * is different, so only the new wording needs a decision.
 */

/** The heading above each order's items. {number} is the order number. */
export const TAKE_PAYMENT_ORDER_HEADING = 'Order #{number}';

/** A line that has already been collected in full. */
export const TAKE_PAYMENT_LINE_PAID = 'Paid';

/**
 * A line the server sent no price for. It is refused rather than treated as free -- see
 * takePaymentLines. The waiter's way out is the whole-order button, so the label says so.
 */
export const TAKE_PAYMENT_LINE_NO_PRICE = 'No price — settle this order whole';

/** A line on an order the terminal may not collect on: cancelled, refunded, already settled. */
export const TAKE_PAYMENT_LINE_NOT_CLAIMABLE = 'Cancelled';

/** A line somebody has already paid part of. {amount} is what is still owed on it. */
export const TAKE_PAYMENT_LINE_PART_PAID = '{amount} still owed';

/** The selection bar. {count} items, {amount} total. */
export const TAKE_PAYMENT_SELECTION = '{count} items — {amount}';
export const TAKE_PAYMENT_SELECTION_ONE = '1 item — {amount}';

/**
 * Card on a part-order selection.
 *
 * The card reader is driven by the whole-order settlement flow, which has the gateway fallbacks
 * for an ambiguous answer. Part-order payments settle through the item ledger, which does not
 * drive the reader -- so offering a card button there would record a card payment nobody took.
 * Cash is the honest answer, and ticking the whole order gets the card back.
 */
export const TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER =
  'Card takes a whole order. Tick everything on the order, or take cash.';

/**
 * Shown instead of the item list when the server cannot describe this tab line by line -- a tab
 * placed before waiter-led service was switched on. The screen falls back to the order list it
 * has always shown, and says why rather than presenting an empty bill.
 */
export const TAKE_PAYMENT_NOT_ITEMISED = 'This tab is not itemised. Paying by order.';

/** Nothing on the tab is still owed. */
export const TAKE_PAYMENT_ALL_PAID = 'Everything on this tab is paid.';
