/**
 * SIGNED COPY — approved by the owner 2026-08-25. #120 residual.
 *
 * Table-management copy, deliberately a SIBLING of constants/paymentCopy rather than more entries
 * inside it. Same rule as that file — the strings are signed, the requirement comments are the
 * specification, and neither is edited without the owner — but the two surfaces answer to different
 * decisions and letting one file accumulate every signed string in the app is how a review of
 * "the payment copy" starts silently covering table management too.
 *
 * THE SAME TWO STRINGS EXIST ON THE WEB SIDE in lib/customer-copy/stranded-claim-copy.ts. Two
 * surfaces, one action, described identically on purpose: staff who release a stuck request from
 * the dashboard and staff who release it from a terminal must be told they did the same thing. If
 * one is ever reworded, the other has to move with it.
 */

/**
 * REQUIREMENT — the action label. It names what the button does to the REQUEST, not to the table,
 * because the operator's goal ("close this table") and the action ("put this round back in the
 * review list") are not the same thing and conflating them is how someone taps it expecting the
 * table to close.
 */
export const RELEASE_STUCK_REQUEST_LABEL = 'Release stuck request';

/**
 * REQUIREMENT — the explanation shown beside the action. It must say three things and no more:
 * the request is stuck part-way through being accepted, releasing puts it BACK in the review list
 * (so nothing a customer ordered is thrown away), and that this is what unblocks the close.
 *
 * "puts it back in the review list" is the load-bearing half. Without it the button reads as
 * "discard this order", which is the one thing it must never be mistaken for — a `waiting_review`
 * row is a real round a customer placed, and dismissing one is #120's own bug from the other side.
 */
export const RELEASE_STUCK_REQUEST_BODY =
  'This request is stuck mid-accept. Releasing it puts it back in the review list so this table can be closed.';
