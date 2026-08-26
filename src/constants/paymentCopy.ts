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

// ─── #344: a recovered payment that was NOT applied to this order ─────────

/**
 * SIGNED COPY — approved by the owner 2026-08-26. #344. All five strings from here down to the
 * next signed banner: TITLE, BODY, BODY_UNKNOWN_ORDER, ACKNOWLEDGE, NEEDS_A_PERSON.
 *
 * This block was PROVISIONAL until 2026-08-26 and said so. Four of the five were signed at their
 * existing values, unchanged byte-for-byte; ACKNOWLEDGE was REPLACED — see the reasoning on that
 * constant. They are not to be edited without the owner, on the same terms as the #327/#326 set
 * signed on 2026-08-25.
 *
 * REQUIREMENT — the heading for a held payment. It must say a card payment was FOUND, and that it
 * belongs to a DIFFERENT order than the one on screen. It must not read as an error in the payment
 * the operator is taking right now — that payment is unaffected and may well have succeeded.
 */
export const HELD_ORPHAN_TITLE = 'A payment for another order was found';

/**
 * REQUIREMENT — the body. Three facts and nothing else: a card payment was recovered, it has NOT
 * been applied to this order, and it has been KEPT so someone can check it. It must not invite the
 * operator to retry anything, and it must not suggest the money is lost — it is not, which is the
 * entire reason the record exists.
 */
export const HELD_ORPHAN_BODY =
  'A card payment was recovered that belongs to a different order. It has not been applied here. It has been kept so it can be checked.';

/**
 * REQUIREMENT — the variant shown when the recovered payment names NO order at all. Same three
 * facts, but it must say the order could not be identified rather than naming a different one.
 * It must NOT imply the payment is invalid: unknown means unknown, not void.
 */
export const HELD_ORPHAN_BODY_UNKNOWN_ORDER =
  'A card payment was recovered but the order it belongs to could not be identified. It has not been applied here. It has been kept so it can be checked.';

/**
 * REQUIREMENT — the acknowledge action. It must name the ACTION the button performs, in the
 * operator's terms, and must not read as a claim the operator is making. "OK" or "Dismiss" remain
 * wrong: this disposes of the record of a real card transaction, not a message to be read past.
 *
 * REPLACED 2026-08-26, AND THE OLD LABEL IS NOT TO BE "RESTORED" AS CLEARER. It read "I have
 * checked this payment", which asserted what the OPERATOR DID while the button attempts a SERVER
 * WRITE THAT CAN FAIL. When that write fails, HELD_ORPHAN_NOT_SAVED then had to contradict a claim
 * the operator had, in their own reading, already made — the message landed as the terminal
 * disputing them rather than as one action not going through. In the owner's words: naming the
 * action makes "could not be saved" read as THAT ACTION failing.
 *
 * WHAT PRESSING IT DOES, so this comment cannot drift from the code again. Ruling 3 (2026-08-26):
 * a durable write IS the acknowledgement. storeAndReleaseHeldOrphan (lib/heldOrphanStore.ts:172-215)
 * stores FIRST and removes the local record only after the server has it (:203-209). It therefore
 * no longer deletes the last copy of anything, and a store that fails leaves the record untouched
 * and on screen — which is the whole reason the label had to stop claiming the checking was done.
 *
 * PINNED AGAINST THE OLD WORDING. heldOrphanCopy.test.ts asserts this exact value AND forbids
 * "I have checked", "dismiss" and "clear" across every held-orphan string: per the owner, any of
 * those is the discard we removed wearing a different word.
 */
export const HELD_ORPHAN_ACKNOWLEDGE = 'Send for checking';

/**
 * REQUIREMENT — #344, the case-3 line, shown when the recovered payment names NO order. Additional
 * to HELD_ORPHAN_BODY_UNKNOWN_ORDER, not a replacement for it.
 *
 * It must convey that this one CANNOT be resolved automatically and needs a person, because that is
 * the material difference between case 2 and case 3: a case-2 record is reported to the server on
 * every visit and disappears by itself once the order settles, and a case-3 record never will. It
 * must not read as an error and must not suggest the money is lost.
 */
export const HELD_ORPHAN_NEEDS_A_PERSON =
  'This one cannot be matched automatically and needs to be reconciled by hand.';

/**
 * SIGNED COPY — approved by the owner 2026-08-26. Both strings below. #344 ruling 3.
 *
 * They are NEW rather than a revision: they did not exist when the #346 set was signed earlier the
 * same day, because before ruling 3 acknowledging could not fail. Storing is now what releases a
 * record, so storing can now not happen, and the operator has to be told.
 *
 * REQUIREMENT — shown on the acknowledge button while the record is being stored. It must say that
 * something is being SAVED, not merely that the app is busy, because what the operator is waiting
 * for is the record existing somewhere other than this device.
 *
 * THREE ASCII FULL STOPS, matching UNCONFIRMED_CHECK_IN_PROGRESS. Not U+2026. If a formatter
 * rewrites it, fix the formatter.
 */
export const HELD_ORPHAN_SAVING = 'Saving...';

/**
 * SIGNED COPY — approved by the owner 2026-08-26. #344 ruling 3.
 *
 * REQUIREMENT — shown when the store did NOT succeed, so the record was kept. This is the string
 * that stops the button being a silent no-op, and it has three things to convey: nothing was
 * deleted, the payment is still safe on this device, and trying again later is the action.
 *
 * OWNER DECISION 1, 2026-08-26 — IT NAMES THE SAVING AS WHAT FAILED, NOT THE PAYMENT. Nothing about
 * the card transaction changed; a save did not go through. Conflating those two is the same family
 * of defect as #327's UNCONFIRMED_CHECK_FAILED, which says "could not reach the payment provider"
 * rather than "could not check" for exactly this reason. Do not reword this string in a way that
 * makes the PAYMENT the subject of the failure.
 *
 * OWNER DECISION 2, 2026-08-26 — IT OFFERS NO OVERRIDE, AND NOBODY MAY ADD ONE. In the owner's
 * words: *an override is the discard we removed wearing a confirmation dialog.* Ruling 1 is that a
 * durable write IS the acknowledgement; a "clear anyway" button would let an operator delete the
 * only remaining record of a card transaction on the strength of having read a message, which is
 * precisely the behaviour #344 exists to end. `heldOrphanCopy.test.ts` pins this — the string may
 * not acquire an escape hatch, and no held-orphan constant may read like a second, destructive
 * action.
 */
export const HELD_ORPHAN_NOT_SAVED =
  'This payment could not be saved yet, so it has been kept here. Nothing was lost. Try again when the terminal is back online.';

// ─── #346: the 42 seconds — what the operator sees while a card payment runs ───

/**
 * SIGNED COPY — approved by the owner 2026-08-26. All five strings below.
 *
 * TWO LOAD-BEARING HALVES ARE PINNED BY THE OWNER AND ARE NOT EDITORIAL. "The card may
 * already/still have been charged" and "Do not ring this sale up again" appear in both
 * PAYMENT_OVER_CEILING_BODY and PAYMENT_TIMED_OUT_MESSAGE. In the owner's words: *anyone editing
 * them out is reintroducing the defect.* They are the same rule that governs #327's
 * UNCONFIRMED_NOT_REPORTED and UNCONFIRMED_INTERRUPTED. Do not shorten either string by removing
 * either half.
 *
 * OWNER DECISION, 2026-08-26 — NO EM DASH ON A PAYMENT SCREEN. The signed PAYMENT_TIMED_OUT_MESSAGE
 * splits what was one em-dash clause into two sentences, and the elapsed pill uses a plain ASCII
 * hyphen. The reasoning, recorded so it is not undone by a formatter or a tidy-up: *an em dash on a
 * payment screen is exactly the concatenation shape #326 was.* #326's defect was
 * `${baseError} — could not notify the system.` — two independent messages glued with a floating
 * dash because no single place owned the sentence. Every string here is one complete message, and
 * no dash joins two of them. If a tool rewrites the hyphen to '—' or '–', fix the tool.
 *
 * WHY THIS BLOCK EXISTS, because it must not be softened later by someone who does not know.
 * Measured on production 2026-08-25: at Mingle, 61% of card sales that did not settle were rung up
 * again within five minutes, against a 3% coincidence floor — twenty-one times. The median gap
 * before staff re-rang was 42 seconds. At 42 seconds, 97.7% of payments that were going to succeed
 * already had. So staff are not careless: they are reading the situation correctly, from a screen
 * that told them nothing. The duplicate cash entry at Mingle and the N$180 rung on Finatic Cashier
 * are both this.
 *
 * The old copy was the single line "● PROCESSING / Please wait..." — no elapsed time, no ceiling,
 * no instruction, no cancel.
 */

/**
 * REQUIREMENT — the pill BELOW the ceiling. Must show elapsed seconds from the first second, and
 * must state the ceiling, because a bounded wait is a different experience from an open one. Must
 * stay calm: at 12 seconds nothing is wrong.
 *
 * ASCII HYPHEN, NOT AN EM DASH. Signed that way — see the owner decision at the top of this block.
 */
export const paymentProcessingElapsed = (elapsedS: number, ceilingS: number): string =>
  `Processing payment - ${elapsedS}s. Usually done within ${ceilingS}s.`;

/**
 * REQUIREMENT — the heading once the ceiling passes. Must NOT say the payment failed: it may still
 * succeed, and 1.8% of successful payments legitimately arrive after this point.
 */
export const PAYMENT_OVER_CEILING_TITLE = 'This payment is taking longer than usual';

/**
 * REQUIREMENT — the body, and the second sentence is the entire behavioural fix. It must tell staff
 * NOT to ring the sale up again, in plain words, because re-ringing is the thing that produces
 * duplicate charges and stranded orders. It must also say the card may already have been charged —
 * the same rule that governs #327's strings 9 and 10 and must survive any future edit.
 *
 * It must NOT offer to cancel. We cannot cancel a card at the reader from here, and offering an
 * action we cannot perform is worse than offering none.
 */
export const PAYMENT_OVER_CEILING_BODY =
  'The card may already have been charged. Do not ring this sale up again. Check the payment status below, or follow the prompts on the card machine.';

/** REQUIREMENT — the action. Idempotent: it asks the server what happened and charges nothing. */
export const PAYMENT_CHECK_STATUS_LABEL = 'Check payment status';

/**
 * REQUIREMENT — shown when the HARD timeout fires and the terminal stops waiting for the reader.
 *
 * IT MUST NOT READ AS A FAILURE. Nothing failed; we stopped waiting. The card may have been
 * charged, and the payment is still recorded and reported. Same rule as above: the "may have been
 * charged" half is the point and must survive any edit.
 *
 * FOUR SENTENCES, NOT THREE WITH A DASH. The draft read "...may still have been charged — this
 * payment has been kept and will be checked." The owner split it: an em dash joining two
 * independent clauses on a payment screen is #326's concatenation shape, and this is the one
 * message on the terminal where a reader skimming past a dash loses the instruction.
 */
export const PAYMENT_TIMED_OUT_MESSAGE =
  'The card machine did not report back in time. The card may still have been charged. This payment has been kept and will be checked. Do not ring this sale up again.';
