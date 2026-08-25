/**
 * #327 / #326 — what the server's answer to a payment report actually MEANS.
 *
 * THE DEFECT THIS EXISTS TO FIX. `POST /api/terminal/orders/[orderId]/payment` answers with three
 * materially different facts and, until 2026-08-24, spelled all three `success: true`:
 *
 *     corrected_to_paid                the card DID clear. Release the order.
 *     cancelled                        the card did NOT clear, and that is now settled. Do not release.
 *     left_pending_finatic_uncertain   we CANNOT SAY. Do not release.
 *
 * The terminal read neither field. `completePayment` parsed exactly `{canClose}` out of the body and
 * threw the rest away, so all three outcomes reached the screen as the same value and rendered as
 * the same generic result. On 2026-08-21 order #868 was reported DECLINED by the reader, answered
 * `left_pending_finatic_uncertain`, and N$33 of food was released on a payment that never cleared.
 *
 * WHY THIS BRANCHES ON `outcome` AND NOT ON `success`. The server-side half (#329, live on main
 * 2026-08-24) changed the uncertain branch to `success: false`. Branching on `outcome` classifies
 * correctly against BOTH the old server and the new one, so the device is not dependent on which
 * build it is talking to; `success` is only ever consulted as a fallback when no outcome is present.
 *
 * WHY THE DEFAULT IS `unknown`. Every branch of the live route sets `outcome`, so the default is
 * unreachable in practice against production. It is `unknown` rather than `not_paid` because the
 * two mistakes are not symmetrical: calling an unknown payment "not paid" only annoys staff, and
 * calling it "paid" hands over food. When this module cannot tell, it must say so.
 *
 * `left_pending_finatic_uncertain` IS DELIBERATE AND MUST NOT BE "IMPROVED". It exists because
 * Finatic answering E04111 does not mean "not paid", it means "no record" — the 2026-08-05 ruling
 * is that E04111 alone must never authorise a cancel. Nothing here may map it to `settled`, and
 * nothing here may correct an order to paid on the strength of the order total.
 *
 * Kept free of React Native native modules so it is unit-testable in plain Node, same as
 * staffApiErrors.ts.
 */

/**
 * What the terminal now knows about the money, after reporting to the server.
 *
 * `unknown` is a THIRD state, not a flavour of failure. It is the whole point of the module: the
 * screen must be able to say "we cannot confirm this" without saying either "paid" or "declined".
 */
export type PaymentReportOutcome = 'settled' | 'not_paid' | 'unknown';

/** The fields of the payment route's 200 response that carry meaning. */
export type PaymentReportResponse = {
  /** The discriminator. Present on every branch of the live route. */
  outcome?: string;
  /** Only consulted when `outcome` is absent. */
  success?: boolean;
};

/**
 * Classify the server's answer to a report of a FAILED device payment.
 *
 * `null` means `completePaymentReliably` exhausted both attempts and the server never heard about
 * this attempt at all. That is `unknown`, not `not_paid`: the device's own view was "failed", but
 * the whole reason the Finatic recovery path exists is that a device-reported failure can still
 * have taken the money. With no server confirmation there is nothing that says otherwise.
 */
export function classifyFailureReport(
  response: PaymentReportResponse | null,
): PaymentReportOutcome {
  if (!response) {
    return 'unknown';
  }

  switch (response.outcome) {
    case 'corrected_to_paid':
      // The server verified with Finatic and found the money. The device was wrong.
      return 'settled';
    case 'cancelled':
      // Definitively not taken, and now resolved. Nothing is owed and nothing is pending.
      return 'not_paid';
    case 'left_pending_finatic_uncertain':
      return 'unknown';
    default:
      break;
  }

  // No outcome field: a server older than the discriminator. `success: false` is at least an
  // explicit "this did not work"; anything else is unclassifiable and must not be read as resolved.
  return 'unknown';
}

/**
 * Classify a THROWN error from reporting a payment the device believes SUCCEEDED.
 *
 * Returns null when the error says nothing about the money, in which case the caller keeps its
 * existing recovery path — this function must not swallow errors it has no opinion on.
 *
 * ALREADY_PAID IS NOT A FAILURE (#326). It is a 409 raised by the atomic claim in
 * markOrderPaidConfirmed because the order is ALREADY `paid` — most often because our own
 * webhook-signature fallback verified and settled it from Finatic seconds earlier (#107 makes that
 * the normal path, not an edge case). The card cleared. The order is correct. Rendering that as
 * FAILED with a retry prompt is one impatient operator away from a second card payment, which is
 * the expensive half of #326.
 *
 * PAYMENT_CLAIM_CONFLICT is deliberately NOT settled. Its own server-side message is "the order may
 * already be paid" — may. That is the definition of `unknown`.
 */
export function classifySuccessReportError(
  code: string | undefined,
): PaymentReportOutcome | null {
  switch (code) {
    case 'ALREADY_PAID':
      return 'settled';
    case 'PAYMENT_CLAIM_CONFLICT':
      return 'unknown';
    default:
      return null;
  }
}
