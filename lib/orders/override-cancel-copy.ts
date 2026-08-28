/**
 * EVERY STRING ON THE PER-ORDER MANUAL OVERRIDE.
 *
 * ================================================================================================
 * ALL FOUR ARE SIGNED — OWNER, 2026-08-28. NONE CARRY A `PENDING COPY:` MARKER.
 * ================================================================================================
 *
 * Pinned character for character by `__tests__/override-cancel-copy-signed-off.test.ts`, the same
 * way the twenty-six clear-all strings are pinned. Copy is signed as a literal, not as a gist: a
 * test that accepted any sentence about an uncertain charge would let a well-meaning reword through
 * without a second sign-off, and the reword is exactly what needs approving.
 *
 * THE OWNER CHANGED ONE CLAUSE AT SIGN-OFF AND THE REASON IS RECORDED HERE, because the next person
 * to tidy this will otherwise reverse it:
 *
 *     was:  "and it is recorded against you"
 *     is:   "and it will be recorded against your name"
 *
 * Same fact, different register. The point is that the action is ATTRIBUTABLE, not that the person
 * doing it is in trouble. Staff pressing this are doing something legitimate under uncertainty --
 * usually because they were standing at the card machine and know what happened. Copy that reads as
 * an accusation makes the safe action feel like the risky one, and the predictable result is that
 * nobody presses it and eight held orders sit on the board forever.
 *
 * ================================================================================================
 * ONE SENTENCE IS PINNED SEPARATELY, AT THE OWNER'S INSTRUCTION
 * ================================================================================================
 *
 * "The card may have been charged." — asserted on its own, not only as part of the whole-string
 * match, exactly as `allGatewayCallsFailed` pins "This does NOT mean they were unpaid".
 *
 * It is the one sentence in the dialog that states the actual risk. Every other sentence describes
 * process; that one describes money that may already have left a customer's account. It is also the
 * most shortenable: a tidier keeping "the provider has no record" and dropping this reads as
 * reassurance, and would turn a warning into a permission slip.
 *
 * WHY THIS IS ITS OWN MODULE rather than literals in the card: the confirm dialog is a client
 * component and the audit reason recorded server-side quotes the same wording, so both ends need
 * one vocabulary. A second copy of a signed string is a second string the moment either is edited.
 */

export const OVERRIDE_CANCEL_COPY = {
  /** The control on the held card. Deliberately not "Clear" -- see the panel. */
  button: 'Cancel this order anyway',

  title: 'Cancel this order?',

  body:
    'The payment provider still has no record of this order, and it is not old enough for us to ' +
    'be sure. The card may have been charged. Cancelling now is your decision, not the ' +
    "system's, and it will be recorded against your name. Only do this if you know what " +
    'happened at the card machine.',

  confirm: 'Yes, cancel it',
} as const

/**
 * The sentence the owner pinned by name. Exported so the test can assert it independently of the
 * whole-body match, and so a reader can see WHICH sentence carries the weight without diffing.
 */
export const OVERRIDE_CANCEL_PINNED_SENTENCE = 'The card may have been charged.'

/**
 * What the audit row says this was, in words, beside the machine-readable outcome.
 *
 * Not staff-facing. This is what someone reconstructing the decision months later reads, and it
 * has to say plainly that a human overruled a rule rather than that a rule fired.
 */
/**
 * The audit reason for the LIGHT path -- an order on which no payment was ever started.
 *
 * Deliberately does NOT reuse the provider wording below. That sentence describes a gateway that
 * was asked and had no record; this one describes a gateway that was never contacted. Recording
 * the first against the second would put a fiction in the audit trail, and an audit row is the
 * one place a fiction cannot later be corrected by looking at the data.
 */
export const OVERRIDE_CANCEL_NEVER_ATTEMPTED_AUDIT_REASON =
  'No payment was ever started on this order. It carried no payment provider reference and no ' +
  'payment attempt timestamp, so no charge could have been created and the provider was not ' +
  'queried. An operator cancelled it manually.'

export const OVERRIDE_CANCEL_AUDIT_REASON =
  'An operator cancelled this order manually, overruling the E04111 persistence rule, which had ' +
  'refused it. The gateway was re-queried immediately before the write and did not report the ' +
  'order as paid. The card may still have been charged; this was a human decision, not the ' +
  "system's."

/** Why the override was refused. Staff-facing, and each one says what to do next. */
export const OVERRIDE_CANCEL_REFUSAL_COPY = {
  /**
   * THE REFUSAL THAT MATTERS. An override is permission to overrule a TIMING rule, never
   * permission to cancel an order the provider says was paid.
   */
  gateway_reports_paid:
    'The payment provider now reports this order as PAID, so it has not been cancelled. Refund ' +
    'it instead if the customer is owed money.',

  gateway_unreachable:
    'The payment provider could not be reached, so nothing was changed. The card may have been ' +
    'charged. Try again in a moment.',

  gateway_status_unrecognised:
    'The payment provider returned a status we do not recognise, so nothing was changed. Do not ' +
    'assume this order is unpaid.',

  order_not_held:
    'This order is no longer held for review, so nothing was changed. Refresh the board.',

  order_not_found: 'This order could not be found at this venue, so nothing was changed.',

  no_gateway_reference:
    'This order has no payment provider reference, so there is nothing to re-check against. It ' +
    'cannot be cancelled this way.',

  payment_marker_present:
    'This order carries a payment marker from the card machine, so it cannot be cancelled this ' +
    'way. Check the card machine roll for this order.',
} as const

export type OverrideCancelRefusal = keyof typeof OVERRIDE_CANCEL_REFUSAL_COPY
