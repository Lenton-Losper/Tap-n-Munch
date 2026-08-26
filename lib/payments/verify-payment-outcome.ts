/**
 * #153 — the three states the terminal's "Check payment status" button can land in, named, and
 * the ONE place their staff-facing wording lives.
 *
 * THE DEFECT THIS CLOSES. verify-payment answered two of these three with the same 502 and the
 * raw exception text. A venue with no Finatic credentials therefore got "cannot reach the payment
 * provider" — a network complaint about a network that is fine — and staff were told to wait for
 * something that will never happen. It is the same conflation as the cron's forever-retry, at the
 * other end of the system: unreachable and unconfigured are not the same fact and must not
 * produce the same instruction to a human.
 *
 * WHY A CODE AND A MESSAGE, RATHER THAN A MESSAGE. The APK cannot branch on prose. The `code` is
 * the stable contract a terminal build reads; the message is what it shows if it does not
 * recognise the code, which every build in the field today does not. Adding the code without a
 * message would leave the existing fleet showing nothing useful; adding the message without a code
 * would make future terminal behaviour depend on string matching.
 *
 * ============================================================================================
 * THE STRINGS BELOW ARE PLACEHOLDERS AND MUST BE REPLACED BEFORE THIS SHIPS TO A DEVICE.
 * ============================================================================================
 *
 * Owner-signed copy for these three states exists and is being supplied separately; it is not
 * invented here. Each placeholder is followed by what its replacement has to convey. They are
 * deliberately ugly so that an unreplaced one is obvious on a screen rather than plausible.
 */

export const VERIFY_PAYMENT_OUTCOME_CODES = {
  /**
   * The gateway was reached and answered, and there is no successful payment against this
   * reference. Includes E04111 ("no record of this merchant order number"), which is
   * time-dependent — order #149 answered E04111 at 13:58:48 and was confirmed PAID on the same
   * reference 22 seconds later — so this state must NOT be presented as a final "not paid".
   *
   * Copy must convey: no confirmation yet; this can still change; check again shortly; do not
   * take a second payment on the strength of this answer.
   */
  NOT_CONFIRMED: 'payment_not_confirmed',

  /**
   * The gateway could not be reached, or the check itself failed. TRANSIENT — retrying is the
   * correct action and the answer may differ in a minute.
   *
   * Copy must convey: we could not complete the check; the payment's state is unknown, not
   * failed; try again; do not assume the card was not charged.
   */
  PROVIDER_UNREACHABLE: 'payment_provider_unreachable',

  /**
   * This restaurant has no Finatic merchant/store credentials, so no query can be formed at all.
   * PERMANENT until someone configures them. Retrying achieves nothing.
   *
   * Copy must convey: this is a SETUP problem, not a network one; retrying will not help;
   * whoever administers the venue has to configure payment credentials; and — the part that must
   * not be dropped — the card may still have been charged on the reader, so this is not
   * permission to charge again.
   */
  CREDENTIALS_NOT_CONFIGURED: 'payment_credentials_not_configured',
} as const

export type VerifyPaymentOutcomeCode =
  (typeof VERIFY_PAYMENT_OUTCOME_CODES)[keyof typeof VERIFY_PAYMENT_OUTCOME_CODES]

/** PLACEHOLDER COPY — replace with the owner-signed strings. See the block comment above. */
export const VERIFY_PAYMENT_STAFF_MESSAGE: Record<VerifyPaymentOutcomeCode, string> = {
  [VERIFY_PAYMENT_OUTCOME_CODES.NOT_CONFIRMED]:
    '[COPY PENDING: payment_not_confirmed — no confirmation yet, may still change, check again]',
  [VERIFY_PAYMENT_OUTCOME_CODES.PROVIDER_UNREACHABLE]:
    '[COPY PENDING: payment_provider_unreachable — check could not be completed, state unknown, try again]',
  [VERIFY_PAYMENT_OUTCOME_CODES.CREDENTIALS_NOT_CONFIGURED]:
    '[COPY PENDING: payment_credentials_not_configured — setup problem not a network one, retrying will not help, the card may still have been charged]',
}
