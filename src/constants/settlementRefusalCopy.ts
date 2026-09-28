/**
 * WHAT THE WAITER IS TOLD WHEN THE SERVER REFUSES TO START A CARD PAYMENT.
 *
 * Sprint 2026-09-29 brief (F-TERMPAY, task 3). DRAFTED, NOT YET SIGNED — house style as signed
 * 2026-08-28: say what happened, the consequence, and what to do.
 *
 * prepare-payment runs BEFORE the card reader opens. When any order in the set is already paid,
 * cancelled or held for review it answers 409 SETTLEMENT_SET_NOT_CLAIMABLE with a reason per order;
 * when the orders owe nothing it answers ORDER_NOTHING_OWED / NOTHING_LEFT_TO_CHARGE. None of these
 * charged anything, and every one of them means the screen's picture of the tab is out of date — so
 * each says so, and the screen refreshes instead of retrying.
 */
export const PREPARE_REFUSAL_TITLE = 'Payment not started';

/** One reason for every refused order. Each ends with the refresh, which the screen then does. */
export const PREPARE_REFUSAL_PAID =
  'Payment could not start because one or more orders on this tab have already been paid. No card was charged. Refreshing the tab.';
export const PREPARE_REFUSAL_CANCELLED =
  'Payment could not start because one or more orders on this tab have been cancelled. No card was charged. Refreshing the tab.';
export const PREPARE_REFUSAL_HELD =
  'Payment could not start because one or more orders on this tab are held for review — a card payment for them is being checked. Do not take payment for them again. No card was charged. Refreshing the tab.';
/** Mixed reasons, or a reason this build does not recognise. */
export const PREPARE_REFUSAL_CHANGED =
  'Payment could not start because some orders on this tab have changed (paid, cancelled or held for review). No card was charged. Refreshing the tab.';
export const PREPARE_REFUSAL_NOTHING_OWED =
  'Payment could not start because there is nothing left to pay on the selected orders. No card was charged. Refreshing the tab.';

/**
 * 409 ORDER_CHANGED_DURING_PREPARE (Sprint 2026-09-29 follow-up): items were added, changed or
 * cancelled while the payment was being set up. The server released the preparation.
 */
export const PREPARE_REFUSAL_ORDER_CHANGED =
  'Payment could not start because the bill changed while it was being set up (items were added, changed or cancelled). No card was charged. Refreshing the tab — check the new total, then take payment again.';

/** Prefix for the list of orders named in the refusal, e.g. "Orders: #12 paid, #13 cancelled". */
export const PREPARE_REFUSAL_ORDERS_PREFIX = 'Orders:';
export const PREPARE_REFUSAL_REASON_WORD = {
  paid: 'paid',
  cancelled: 'cancelled',
  held: 'held for review',
  other: 'changed',
} as const;

/**
 * THE TAB SETTLE REFUSED AFTER THE CARD WAS CHARGED (409 NOTHING_LEFT_TO_CHARGE on /settle).
 *
 * Different from everything above: the reader HAS run and the card went through, but by the time the
 * settlement reached the server the items had been paid some other way. Saying "no card was charged"
 * here would be false and would invite a second charge.
 */
export const SETTLE_NOTHING_LEFT_AFTER_CARD_TITLE = 'Card charged — orders already paid';
export const SETTLE_NOTHING_LEFT_AFTER_CARD =
  'The card payment went through, but these orders had already been paid by the time it was recorded. Do not charge again. Tell a manager so the extra payment can be refunded. Refreshing the tab.';
/**
 * 409 ORDER_CHANGED_DURING_PAYMENT from the device's payment callback (Sprint 2026-09-29
 * follow-up). THE CARD WAS CHARGED. The bill changed while the reader was open, so the server held
 * the order for a manager to review (refund or collect the difference). It is not a failure and
 * must never lead to a second charge; the transaction reference stays on screen for the manager.
 */
export const PAYMENT_HELD_TITLE = 'Payment taken — held for review';
export const PAYMENT_HELD_BODY =
  'The card was charged, but the bill changed while it was being paid. The order is held for a manager to review so the difference can be refunded or collected. Do not charge again.';
/** `{ref}` is the card transaction reference (voucher number when the reader gave one). */
export const PAYMENT_HELD_REFERENCE = 'Transaction reference: {ref}';

/** The cash equivalent: nothing has been recorded, so the cash in hand should not be kept. */
export const SETTLE_NOTHING_LEFT_CASH =
  'There is nothing left to pay on these orders, so no cash was recorded. Do not take cash for them. Refreshing the tab.';
