/**
 * TAKE PAYMENT, BY ITEM (Ship 1b).
 *
 * ============================================================================================
 * SIGNED BY THE OWNER 2026-09-04. Ten strings, pinned as written.
 * ============================================================================================
 *
 * Every string below is shown to a waiter at a table with a customer waiting, which is why they
 * were signed before any binary. The lock test (takePaymentCopySignedOff.test.ts) is written
 * against these exact strings so a later edit cannot slip through unnoticed.
 *
 * SIGNED WITH ONE CHANGE, on TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER -- see the comment on it. The
 * other nine went in as proposed.
 *
 * The existing labels -- "Settle Selected", "Settle Entire Tab", "Take Cash" -- are UNCHANGED and
 * are deliberately not restated here. The interaction was already right; only what the list shows
 * is different, so only the new wording needed a decision.
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
 *
 * THE OWNER'S EDIT, 2026-09-04. Proposed as "Card takes a whole order. Tick everything on the
 * order, or take cash." Two faults, both real at a table:
 *
 *   - "Card takes a whole order" reads as though the CARD is doing the taking. It is the waiter
 *     who takes payment; the card is the method. "Card payments cover a whole order" states the
 *     constraint without making the instrument the actor.
 *   - "Tick everything on the order" is ambiguous the moment a tab carries several orders, which
 *     is the exact situation this message appears in -- the waiter has ticked across orders or
 *     part of one. "Tick the whole order" names the unit; "take cash for these items" names what
 *     is already selected, so both branches point at something the waiter can see.
 */
/**
 * ================================================================================================
 * RETIRED 2026-09-08 — SIGNED 2026-09-04, SHIPPED, AND NO LONGER TRUE.
 * ================================================================================================
 *
 * "Card payments cover a whole order" was a fact about OUR schema, not about the reader:
 * orders.paycloud_merchant_order_no is one value per order, minted once and never rotated, so a
 * second card charge on one order reused the first charge's reference and the webhook could not
 * tell the two settlements apart. terminal_payment_intents gives each charge its own reference, and
 * card now works on a part-order selection exactly as cash does.
 *
 * KEPT RATHER THAN DELETED because it was signed, and a signed string vanishing from the file makes
 * the signature unauditable. It is exported, referenced by the lock test, and rendered NOWHERE —
 * which is asserted, so nobody wires it back in without a fresh decision.
 */
export const TAKE_PAYMENT_CARD_NEEDS_WHOLE_ORDER =
  'Card payments cover a whole order. Tick the whole order, or take cash for these items.';

/**
 * Shown instead of the item list when the server cannot describe this tab line by line -- a tab
 * placed before waiter-led service was switched on. The screen falls back to the order list it
 * has always shown, and says why rather than presenting an empty bill.
 */
export const TAKE_PAYMENT_NOT_ITEMISED = 'This tab is not itemised. Paying by order.';

/** Nothing on the tab is still owed. */
export const TAKE_PAYMENT_ALL_PAID = 'Everything on this tab is paid.';
