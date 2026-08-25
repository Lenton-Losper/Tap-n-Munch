/**
 * SIGNED COPY — approved by the owner 2026-08-25. #327 / #326.
 *
 * Every string the payment-result screens show for the two states added by #327 and #326 lives
 * here and NOWHERE ELSE, so that reviewing the wording is one file and one review rather than a
 * hunt through three screens.
 *
 * THE STRINGS BELOW ARE SIGNED OFF AND ARE NOT TO BE EDITED WITHOUT THE OWNER. They replaced
 * placeholders on 2026-08-25. Sentence case, staff-facing. What each string has to CONVEY is
 * written above it as a requirement; the requirement is the specification and the string satisfies
 * it. If a requirement ever has to change, the string changes with the owner, not around them.
 *
 * THREE OWNER DECISIONS RECORDED SO THEY ARE NOT RE-LITIGATED OR UNDONE BY ACCIDENT. Each is also
 * repeated on the constant it governs, because that is where someone editing will actually be
 * looking:
 *
 *   1. UNCONFIRMED_EXPLANATION DROPS THE WORD "yet", DELIBERATELY. "yet" implied the situation
 *      resolves itself. It does not: the stale-order cron partitions on
 *      paycloud_merchant_order_no, so an order CARRYING a merchant reference goes to the Finatic
 *      branch, is answered E04111, and is skipped on every run with no terminating condition.
 *      A promise that something will resolve later is exactly the false comfort — in a server-side
 *      comment rather than a string — that let order #868 stay invisible.
 *
 *   2. UNCONFIRMED_CHECK_FAILED says "could not reach the payment provider", not "could not check",
 *      so that it cannot be misread as the PAYMENT having failed. The check failing and the payment
 *      failing are different facts and this screen exists because they were being conflated.
 *
 *   3. UNCONFIRMED_NOT_REPORTED AND UNCONFIRMED_INTERRUPTED BOTH STATE THAT THE CARD MAY HAVE BEEN
 *      CHARGED. That is the entire point of #327 and it must survive any future edit. Do not
 *      shorten either string by removing it.
 *
 * WHY THERE IS A REQUIREMENT COMMENT AND NOT JUST A STRING. #326's first defect was two independent
 * messages glued together with a floating em dash — `${baseError} — could not notify the system.` —
 * which happened because no single place owned the sentence. Each constant below is ONE complete
 * message. Nothing concatenates them with anything, and nothing appends a fragment to a message
 * that already ends in a full stop. paymentReportOutcome.test.ts pins that property.
 */

/**
 * REQUIREMENT — the UNCONFIRMED headline. One or two words, in the same register as the existing
 * 'FAILED' / 'Payment successful' headlines. It must NOT read as either a success or a decline.
 * This is the word the operator sees from arm's length and acts on.
 */
export const UNCONFIRMED_TITLE = 'Not confirmed';

/**
 * REQUIREMENT — the instruction. This is the string #327 exists for and the only one on the screen
 * that prevents the incident: it must tell the operator, unambiguously, NOT to hand over the food.
 * It must not hedge and it must not offer "or" branches. One sentence, imperative.
 */
export const UNCONFIRMED_INSTRUCTION =
  'Do not release this order. The payment has not been confirmed.';

/**
 * REQUIREMENT — the explanation, shown under the instruction. It must convey that the result is
 * genuinely unknown rather than known-bad, and that checking is what resolves it.
 *
 * OWNER DECISION 1, 2026-08-25 — THE WORD "yet" WAS REMOVED AND MUST NOT COME BACK. It implied the
 * situation resolves itself. Nothing resolves these today: the stale-order cron partitions on
 * paycloud_merchant_order_no, an order carrying a merchant reference goes to the Finatic branch, is
 * answered E04111, and is skipped forever with no terminating condition. This string must not
 * promise that anything will sort itself out.
 */
export const UNCONFIRMED_EXPLANATION =
  'The card reader and the payment provider do not agree. Check the payment status before doing anything else.';

/**
 * REQUIREMENT — the PRIMARY action's label. Per #327 the primary action is checking the payment
 * status, not retrying. It must read as safe to press, because it is: the endpoint is idempotent.
 */
export const UNCONFIRMED_CHECK_ACTION = 'Check payment status';

/**
 * REQUIREMENT — shown on the primary action while the check is in flight.
 *
 * THREE ASCII FULL STOPS, NOT THE SINGLE-CHARACTER ELLIPSIS (U+2026). Signed that way deliberately.
 * A formatter or an editor "tidying" this to '…' is changing signed copy, so if a tool rewrites it,
 * fix the tool.
 */
export const UNCONFIRMED_CHECK_IN_PROGRESS = 'Checking...';

/**
 * REQUIREMENT — the result of a check that came back still unresolved. It must NOT read as a
 * failure of the check, and must not imply the payment failed. Checking again later is legitimate.
 */
export const UNCONFIRMED_STILL_UNRESOLVED =
  'Still not confirmed. The payment provider has no answer for this order yet.';

/**
 * REQUIREMENT — the result of a check that could not reach the provider at all (network, 502).
 * Distinct from the above: this one says the CHECK failed, not that the payment is unresolved.
 *
 * OWNER DECISION 2, 2026-08-25 — it names the PROVIDER as what could not be reached, rather than
 * saying "could not check the payment status", precisely so it cannot be misread as the payment
 * having failed. Conflating those two is the family of defect this whole screen exists to end.
 */
export const UNCONFIRMED_CHECK_FAILED =
  'Could not reach the payment provider. Try the check again.';

/**
 * REQUIREMENT — the SECONDARY action's label. #327: retry is secondary, and it re-presents the card
 * for the SAME order — it never creates a new sale. The label must not invite a casual second tap.
 */
export const UNCONFIRMED_RETRY_ACTION = 'Take payment again';

/**
 * REQUIREMENT — the standalone message for "the device tried, and the server was never told".
 * Replaces the concatenated `${baseError} — could not notify the system. Contact support before
 * retrying.` It must convey: the attempt happened, we could not record it, and someone must check
 * rather than retry blindly.
 *
 * OWNER DECISION 3, 2026-08-25 — "The card may have been charged." IS LOAD-BEARING AND MUST SURVIVE
 * ANY FUTURE EDIT. It is the entire point of #327. Do not shorten this string by removing it.
 */
export const UNCONFIRMED_NOT_REPORTED =
  'This payment attempt was not recorded. The card may have been charged. Check the payment status before taking payment again.';

/**
 * REQUIREMENT — the standalone message for a payment that was in flight when the app died. It must
 * convey that the attempt's result was never seen, so it is unknown rather than failed, and that
 * checking — not retrying — is the next step. The string it replaces was "Payment was interrupted.
 * Please retry.", which asserted the money did not move and then invited a second charge; the
 * replacement must do neither.
 *
 * OWNER DECISION 3, 2026-08-25 — "The card may have been charged." IS LOAD-BEARING AND MUST SURVIVE
 * ANY FUTURE EDIT. It is the entire point of #327. Do not shorten this string by removing it.
 */
export const UNCONFIRMED_INTERRUPTED =
  'This payment was interrupted before the result was known. The card may have been charged. Check the payment status before taking payment again.';

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
  'This payment did go through. Refresh the table to see what is still owed before taking any more payment.';

/**
 * REQUIREMENT — #326. Shown when the order turns out to have been paid ALREADY, by a route other
 * than this attempt (almost always our own webhook fallback, seconds earlier). It must read as a
 * settled, finished, GOOD outcome — never as an error, and never with a retry prompt attached.
 * The money is not at risk; only the terminal's picture of it was stale.
 */
export const ALREADY_SETTLED_MESSAGE =
  'This order is already paid. No further payment is needed.';
