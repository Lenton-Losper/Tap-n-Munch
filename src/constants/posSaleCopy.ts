/**
 * THE POS SALE'S ANSWER WHEN THE SERVER ALREADY HAS A DIFFERENT SALE UNDER THIS KEY.
 *
 * Sprint 2026-09-28 brief. DRAFTED, NOT YET SIGNED — house style as signed 2026-08-28: say what
 * happened, the consequence, and what to do.
 *
 * The server (C4) now answers 409 IDEMPOTENCY_KEY_BODY_MISMATCH when a POS sale is re-sent under
 * the key of an earlier attempt whose items were different. Before, it silently returned the
 * EARLIER order and the reader then charged the earlier items, not the ones on screen.
 */
export const POS_KEY_MISMATCH_TITLE = 'An earlier attempt already created an order';
export const POS_KEY_MISMATCH_BODY =
  'The first Charge reached the server with different items and created an order that has NOT been charged. This cart was not sent. Start a new sale to charge what is on screen.';
export const POS_KEY_MISMATCH_ORDER_PREFIX = 'Earlier order';
export const POS_START_NEW_SALE = 'Start a new sale';
export const POS_KEEP_CART = 'Keep this cart';
