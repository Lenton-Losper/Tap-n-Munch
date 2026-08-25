/**
 * PROVISIONAL COPY — NOT SIGNED OFF. #327 / #326.
 *
 * Every string the payment-result screens show for the two states added by #327 and #326 lives
 * here and NOWHERE ELSE, so that signing off the wording is one file and one review rather than a
 * hunt through three screens.
 *
 * THESE WORDS ARE A PLACEHOLDER WRITTEN TO CARRY THE BEHAVIOUR, NOT A COPY DECISION. The owner
 * signs all customer- and staff-facing strings. What each string has to CONVEY is written above it
 * as a requirement; the requirement is the specification, the string is a stand-in that satisfies
 * it well enough to build and test an APK. Replace the strings, keep the requirements.
 *
 * WHY THERE IS A REQUIREMENT COMMENT AND NOT JUST A STRING. #326's first defect was two independent
 * messages glued together with a floating em dash — `${baseError} — could not notify the system.` —
 * which happened because no single place owned the sentence. Each constant below is ONE complete
 * message. Nothing concatenates them with anything, and nothing appends a fragment to a message
 * that already ends in a full stop.
 */

/**
 * REQUIREMENT — the UNCONFIRMED headline. One or two words, in the same register as the existing
 * 'FAILED' / 'Payment successful' headlines. It must NOT read as either a success or a decline.
 * This is the word the operator sees from arm's length and acts on.
 */
export const UNCONFIRMED_TITLE = 'NOT CONFIRMED';

/**
 * REQUIREMENT — the instruction. This is the string #327 exists for and the only one on the screen
 * that prevents the incident: it must tell the operator, unambiguously, NOT to hand over the food.
 * It must not hedge and it must not offer "or" branches. One sentence, imperative.
 */
export const UNCONFIRMED_INSTRUCTION =
  'Do not release this order. The payment has not been confirmed.';

/**
 * REQUIREMENT — the explanation, one sentence, shown under the instruction. It must convey that the
 * result is genuinely unknown rather than known-bad, and that checking is what resolves it. It must
 * not promise that anything will resolve on its own: the stale-order cron demonstrably does not
 * (an order carrying a merchant reference is answered E04111 and skipped forever), and the old
 * server-side comment promising exactly that is how #868 stayed invisible.
 */
export const UNCONFIRMED_EXPLANATION =
  'The card reader and the payment provider do not agree yet. Check the payment status before doing anything else.';

/**
 * REQUIREMENT — the PRIMARY action's label. Per #327 the primary action is checking the payment
 * status, not retrying. It must read as safe to press, because it is: the endpoint is idempotent.
 */
export const UNCONFIRMED_CHECK_ACTION = 'Check payment status';

/** REQUIREMENT — shown on the primary action while the check is in flight. */
export const UNCONFIRMED_CHECK_IN_PROGRESS = 'Checking…';

/**
 * REQUIREMENT — the result of a check that came back still unresolved. It must NOT read as a
 * failure of the check, and must not imply the payment failed. Checking again later is legitimate.
 */
export const UNCONFIRMED_STILL_UNRESOLVED =
  'Still not confirmed. The payment provider has no answer for this order yet.';

/**
 * REQUIREMENT — the result of a check that could not reach the provider at all (network, 502).
 * Distinct from the above: this one says the CHECK failed, not that the payment is unresolved.
 */
export const UNCONFIRMED_CHECK_FAILED =
  'Could not check the payment status. Try the check again.';

/**
 * REQUIREMENT — the SECONDARY action's label. #327: retry is secondary, and it re-presents the card
 * for the SAME order — it never creates a new sale. The label must not invite a casual second tap.
 */
export const UNCONFIRMED_RETRY_ACTION = 'Take payment again';

/**
 * REQUIREMENT — the standalone message for "the device tried, and the server was never told".
 * Replaces the concatenated `${baseError} — could not notify the system. Contact support before
 * retrying.` This is one complete sentence that must convey: the attempt happened, we could not
 * record it, and someone must check rather than retry blindly.
 */
export const UNCONFIRMED_NOT_REPORTED =
  'This payment attempt could not be recorded. Check the payment status before taking payment again.';

/**
 * REQUIREMENT — the standalone message for a payment that was in flight when the app died. One
 * sentence. It must convey that the attempt's result was never seen, so it is unknown rather than
 * failed, and that checking — not retrying — is the next step. The string it replaces was
 * "Payment was interrupted. Please retry.", which asserted the money did not move and then invited
 * a second charge; the replacement must do neither.
 */
export const UNCONFIRMED_INTERRUPTED =
  'This payment was interrupted before its result was known. Check the payment status before taking payment again.';

/**
 * REQUIREMENT — the UNCONFIRMED message on the TABLE SETTLE flow, which has no result screen of
 * its own and can only raise an alert. Because it is the whole message rather than a line on a
 * card, it must carry BOTH halves that the Payment screen splits across two lines: do not release
 * the order, and check the payment status. One short paragraph, imperative.
 */
export const UNCONFIRMED_SETTLE_INSTRUCTION =
  'The payment could not be confirmed. Do not release these orders. Check the payment status on the order before taking payment again.';

/**
 * REQUIREMENT — the settle flow found the money after all: the server verified with the provider
 * and corrected the order to paid, so this settle attempt stopped but a payment DID succeed. Must
 * convey that nothing further is owed for that order and that refreshing shows the true state. It
 * must not read as an error and must not invite another card payment.
 */
export const SETTLE_ORDER_ALREADY_PAID =
  'That payment did go through after all. Refresh the table to see what is still owed before taking any more payment.';

/**
 * REQUIREMENT — #326. Shown when the order turns out to have been paid ALREADY, by a route other
 * than this attempt (almost always our own webhook fallback, seconds earlier). It must read as a
 * settled, finished, GOOD outcome — never as an error, and never with a retry prompt attached.
 * The money is not at risk; only the terminal's picture of it was stale.
 */
export const ALREADY_SETTLED_MESSAGE =
  'This order was already paid. No further payment is needed.';
