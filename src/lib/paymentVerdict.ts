/**
 * #354 — telling "never started" apart from the other reasons a verify comes back not-paid.
 *
 * WHAT THE TERMINAL ACTUALLY RECEIVES, checked before writing this rather than assumed.
 * `verifyTerminalPayment` throws on a non-2xx and otherwise returns the parsed body, so an E04111
 * arrives as a NORMAL 200 with `paid: false` — it does not reach the catch. Both existing pieces of
 * terminal documentation say so explicitly: orphanReporting's contract block ("paid:false — Finatic
 * has no record (E04111) or the order has no merchant order number") and PaymentScreen's own
 * comment on handleCheckPaymentStatus ("`paid: false` is not 'not paid' — E04111 means Finatic has
 * no record").
 *
 * THAT MATTERS BECAUSE IT MOVES THE BRANCH. The state was reported as rendering
 * UNCONFIRMED_CHECK_FAILED ("Could not reach the payment provider"); on this build it renders
 * UNCONFIRMED_STILL_UNRESOLVED ("the payment provider has no answer for this order yet"). Less
 * alarming than reported, but still wrong in the two ways the ruling names: it does not say nothing
 * was charged, and it invites the check that returns E04111 forever.
 *
 * AND `paid: false` ALONE CANNOT IDENTIFY E04111 — it is documented as covering at least two
 * causes, the other being an order with no merchant order number, which is NOT "never started" and
 * must keep the existing copy. So a discriminator has to come from the server.
 *
 * WHAT THE SERVER MUST SEND, and it does not today: an explicit `isE04111: boolean` on the
 * verify-payment 200 body. That name is the server's OWN vocabulary — it already appears in the
 * `payment.verification_uncertain` audit metadata — so this asks for a field to be surfaced, not
 * for a new concept to be invented.
 *
 * MATCHED ON A FLAG, NEVER ON THE MESSAGE. `error` carries provider prose ("Merchant order number
 * is invalid") which is a display string: it can be reworded, localised or truncated upstream at
 * any time. This is the same rule that keeps USER_CANCEL_RESULT_CODES matching WiseCashier's
 * `result` code rather than its `resultMsg`, and for the same reason — a copy change must never
 * silently reclassify a payment.
 *
 * UNTIL THE SERVER SENDS IT THIS RETURNS FALSE AND THE SCREEN IS UNCHANGED. That is deliberate: the
 * safe default is the existing "still unresolved" copy, never the reassuring one. Guessing "never
 * started" from an unidentified not-paid answer would tell staff nothing was charged when we do not
 * know that, which is the one direction this whole screen must never fail in.
 *
 * Kept free of React Native native modules so it is unit-testable in plain Node.
 */
import {
  UNCONFIRMED_NEVER_STARTED,
  UNCONFIRMED_STILL_UNRESOLVED,
} from '../constants/paymentCopy';

/** Only the fields the classification depends on. Structural, so it accepts the api result type. */
export interface NotPaidVerdictLike {
  paid: boolean;
  /**
   * The server's own E04111 discriminator. OPTIONAL because no deployed server sends it yet — see
   * the module comment. Absent is treated as "we cannot tell", not as "no".
   */
  isE04111?: boolean;
}

/**
 * Did the provider answer that this payment was NEVER CREATED?
 *
 * True only for an explicit `isE04111: true` on an unpaid verdict. A paid verdict can never be
 * "never started", and is rejected first so a server bug that set both could not produce the
 * reassuring copy for a payment that actually took money.
 */
export function isNeverStartedVerdict(verdict: NotPaidVerdictLike): boolean {
  if (verdict.paid) {
    return false;
  }
  return verdict.isE04111 === true;
}

/**
 * Should the screen record that it could not classify this not-paid answer?
 *
 * SHIPPING THE INSTRUMENT, because the branch above is unreachable until the server changes and an
 * inert fix that nobody notices is this repo's most repeated defect. A wiretap event on every
 * unclassifiable not-paid verdict means the first device on this build answers the question the
 * code cannot: whether the field arrives. Same approach as #156's ledger instrument.
 */
export function isUnclassifiedNotPaid(verdict: NotPaidVerdictLike): boolean {
  return !verdict.paid && verdict.isE04111 === undefined;
}

/**
 * WHICH MESSAGE THE UNCONFIRMED CARD SHOWS for a verify that did not come back paid.
 *
 * THE MAPPING LIVES HERE RATHER THAN IN THE SCREEN so it can be tested against the real constants.
 * The ruling's required mutation — "making the E04111 branch fall back to UNCONFIRMED_CHECK_FAILED
 * must turn a test red" — is a statement about this mapping, and it can only be made to fail if the
 * mapping is reachable from a test. Inlined in the screen it would not have been.
 *
 * UNCONFIRMED_CHECK_FAILED IS DELIBERATELY NOT REACHABLE FROM HERE. It means the check itself never
 * got an answer, which on this path is the catch block's business, not a 200 body's. Returning it
 * for any verdict would be the #354 defect exactly: the provider was reached and it answered.
 */
export function unconfirmedMessageForVerdict(
  verdict: NotPaidVerdictLike,
): string {
  return isNeverStartedVerdict(verdict)
    ? UNCONFIRMED_NEVER_STARTED
    : UNCONFIRMED_STILL_UNRESOLVED;
}
