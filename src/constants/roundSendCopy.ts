/**
 * EVERY STRING THE ROUND SEND PATH SHOWS WHEN THE ANSWER IS NOT A PLAIN "SENT".
 *
 * Sprint 2026-09-28 brief (Riviera Table 1, order #160). Drafted under the owner's standing
 * instruction to draft rather than ask; house style as signed 2026-08-28 — say what happens, say
 * the consequence AND what to do, never imply something is settled when it is not.
 *
 * THE INCIDENT THESE EXIST FOR. A round timed out. The waiter took Modena Pasta out of the basket
 * and pressed Send again. The server, correctly, replayed the ORIGINAL round under the same key —
 * Modena included — and the terminal showed a green "Round sent" over the edited basket. The
 * kitchen cooked the Modena. Every string below is one of the answers that screen could not give.
 */

/** A timeout, a dropped connection or a 5xx. The round may or may not be on the tab. */
export const ROUND_UNKNOWN_TITLE = 'Not sure the round was sent';
export const ROUND_UNKNOWN_BODY =
  'We did not get an answer from the server, so this round may already be with the kitchen. The basket is locked so it cannot change. Retry the same round — it cannot be added twice — or check the table.';
export const ROUND_RETRY_SAME = 'Retry the same round';
export const ROUND_CHECK_TABLE = 'Check the table';

/** C4 duplicate: true. Nothing new was created; this is the round from the first Send. */
export const ROUND_ALREADY_SENT_TITLE = 'Already sent — this is what the kitchen has';
export const ROUND_ALREADY_SENT_BODY =
  'The first Send reached the kitchen. Nothing was added twice.';
/** Old server: duplicate without items, and the table could not be read either. */
export const ROUND_ITEMS_UNAVAILABLE =
  'Could not load what the kitchen has for this order. Check the table before telling the customer.';

/** C4 409 IDEMPOTENCY_KEY_BODY_MISMATCH. */
export const ROUND_MISMATCH_TITLE = 'The kitchen has the ORIGINAL round, not this one';
export const ROUND_MISMATCH_BODY =
  'This round was already sent before it was changed. The list below is what the kitchen has and what is on the bill. Anything else in your basket was NOT sent — add it as a new round. Taking a listed item off now needs a manager void from the table screen.';

/** C5 400. Nothing was created. The basket needs changing; sending it again as it is will fail. */
export const ROUND_PRICING_TITLE = 'This round was NOT sent';
export const ROUND_PRICING_BODY =
  'The server would not price it, so nothing went to the kitchen and nothing is on the bill. Change these items, then send again:';
export const ROUND_PRICING_FIX = 'Change the round';

/** Check the table: an order that looks like this round, placed since the first Send. */
export const ROUND_CHECK_FOUND =
  'Order #{number} was placed since you pressed Send and has these items. Retry the same round to confirm it — the server will answer "already sent" and nothing is added twice.';
export const ROUND_CHECK_NOT_FOUND =
  'Nothing new is on this table since you pressed Send. Retry the same round — if it did arrive after all, it will not be added twice.';
export const ROUND_CHECK_FAILED = 'Could not read the table either. Try again in a moment.';
