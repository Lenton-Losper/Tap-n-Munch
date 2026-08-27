/**
 * EVERY STRING A STAFF MEMBER READS ON THE "CLEAR ALL" CONTROL. NOT ONE IS SIGNED OFF.
 *
 * Each carries the `PENDING COPY:` marker VERBATIM, and it renders verbatim. That is the point, and
 * it is the same ruling `unsignedCopy()` already encodes one file over: the alternative — inventing
 * plausible staff-facing prose and noting the fact only in a comment — is exactly how unsigned
 * wording ships. On 2026-08-21 five such strings reached production and the owner of a multi-location
 * account read `PENDING COPY — Location` on twenty staff screens. The lesson taken from that was not
 * "be more careful", it was "make the marker visible to a reviewer, a test AND a grep at once", which
 * is what `scripts/check-no-pending-copy.mjs` now enforces on the production deploy only.
 *
 * So this file is expected to FAIL that gate. It is meant to. It is why the marker exists.
 *
 * WHY THE COPY IS ITS OWN MODULE rather than string literals in the panel: the panel is a client
 * component and the summary this describes is produced on the server, so both ends need the same
 * vocabulary; and a `Record<ClearHeldOutcome, string>` is checked by tsc for exhaustiveness, which
 * means a new outcome added to `CLEAR_HELD_OUTCOMES` cannot reach a screen with no line at all. An
 * outcome with no copy is the invisible-skip failure this whole action exists to remove.
 *
 * THE MEANINGS BELOW ARE WHAT NEEDS SIGNING OFF, NOT THE WORDS. Each line is annotated with the
 * decision it has to make possible. Whoever signs these should read the intent comment and then
 * write the sentence; the placeholder text is a description of the job, not a draft.
 */
/**
 * IMPORTED FROM THE OUTCOMES MODULE, NEVER FROM THE ACTION. This file is read by a `'use client'`
 * component; the action module reaches Redis through the credentials chain. See
 * clear-held-for-review-outcomes.ts for the whole reason that file exists.
 */
import {
  CLEAR_HELD_OUTCOMES,
  type ClearHeldBanner,
  type ClearHeldOutcome,
} from './clear-held-for-review-outcomes'

/** The marker every unsigned string here begins with. Asserted by the copy test. */
export const CLEAR_HELD_PENDING_COPY_MARKER = 'PENDING COPY:'

export const CLEAR_HELD_CONTROL_COPY = {
  /**
   * INTENT: the button. It must say that it acts on ALL the rows above at once, and it must not
   * promise cancellation — the action asks the payment provider and does whatever the answer says,
   * which for some rows will be "this was actually paid".
   */
  button: 'PENDING COPY: check all of these with the payment provider and settle them',

  /**
   * INTENT: the confirmation heading. This is the last point at which a staff member can stop, and
   * the thing they need to know is that money statuses are about to change on N orders.
   */
  confirmHeading: 'PENDING COPY: check and settle all held orders',

  /**
   * INTENT: the confirmation body. Must convey three facts and no more: (1) each order is checked
   * with the payment provider first, (2) only orders the provider confirms were never paid are
   * cancelled, (3) anything that turns out to have been paid is kept and shown, not cancelled.
   * It takes the count and the amount so the staff member sees the blast radius before agreeing.
   */
  confirmBody:
    'PENDING COPY: each of these {count} orders ({amount}) will be checked with the payment ' +
    'provider first. Only the ones confirmed as never paid are cancelled. Anything that turns out ' +
    'to have been paid is kept and shown to you.',

  /** INTENT: the confirm button. */
  confirmAccept: 'PENDING COPY: yes, check them now',

  /** INTENT: the back-out button. */
  confirmCancel: 'PENDING COPY: not now',

  /**
   * INTENT: the in-flight label. Must make clear that a real external check is happening and that
   * closing the screen is not a good idea, without implying it is stuck.
   */
  running: 'PENDING COPY: checking each order with the payment provider…',

  /**
   * INTENT: the heading over the result list.
   */
  resultsHeading: 'PENDING COPY: what happened to each order',

  /**
   * INTENT: the line shown when the request itself failed — the browser could not reach the server,
   * or the server refused. Must NOT be confusable with "nothing needed doing"; the same distinction
   * the panel's own error state already makes.
   */
  requestFailed:
    'PENDING COPY: the check could not be run, so nothing was changed and nothing here is settled.',

  /**
   * INTENT: THE MOST IMPORTANT STRING IN THIS FILE. Shown when every call to the payment provider
   * in the run failed. The staff member must not read the result as "none of these were paid" —
   * the run learned nothing at all. Without this line, a total outage and six genuinely unpaid
   * orders produce the same screen.
   */
  allGatewayCallsFailed:
    'PENDING COPY: the payment provider could not be reached for any of these orders. This does ' +
    'NOT mean they were unpaid — it means nothing could be checked. Nothing was changed. Try again ' +
    'later.',

  /**
   * INTENT: shown when the venue's positive control did not come back as expected. Distinct from
   * the line above because the provider DID answer — it answered wrongly about an order we already
   * know was paid, which means its answers about everything else cannot be trusted either.
   */
  controlFailed:
    'PENDING COPY: a test check against an order we know was paid did not come back as paid, so ' +
    'the answers for these orders cannot be trusted. Nothing was changed.',

  /**
   * INTENT: shown when no test check could be set up at all, because this venue has no completed
   * card payment to test against. Must convey that this is a property of the venue, not a fault.
   */
  controlUnavailable:
    'PENDING COPY: there is no completed card payment at this venue to test the check against, so ' +
    'these orders cannot be settled automatically. Nothing was changed.',

  /**
   * INTENT: shown when there were held orders but every one of them is at a venue with no card
   * payment set up. Must say plainly that nobody can answer the question, so the orders stay.
   */
  noCredentials:
    'PENDING COPY: card payments are not set up at this venue, so the payment provider cannot be ' +
    'asked about these orders by anyone. They stay on this list.',

  /** INTENT: shown when the run completed and every order was left exactly as it was. */
  nothingChanged: 'PENDING COPY: nothing was changed.',
} as const

/**
 * One line per outcome, keyed by the outcome name. EXHAUSTIVE BY TYPE — adding a member to
 * `CLEAR_HELD_OUTCOMES` without adding a line here does not compile.
 *
 * The intent comments are the specification. Every line must satisfy two rules the owner has already
 * ruled on elsewhere in this surface:
 *
 *   1. NEVER LET A SKIP READ AS AN ALL-CLEAR. `my-orders` labelled every status it did not recognise
 *      "🎉 New"; a line here that reads as "handled" for an order nothing happened to is the same
 *      defect on a money screen.
 *   2. THE TWO OPPOSITE SENTENCES MUST STAY OPPOSITE. `held-for-review.ts` pins 'Nothing was taken.'
 *      against 'A card may still have been charged on the machine.' — one tells staff they may act
 *      without checking the terminal roll, the other tells them they must go and check it first.
 *      Every line below inherits one side or the other and must not blur it.
 */
export const CLEAR_HELD_OUTCOME_COPY: Record<ClearHeldOutcome, string> = {
  /** INTENT: the provider confirmed no payment exists. Nothing was taken; the order is now cancelled. */
  cancelled: 'PENDING COPY: the payment provider confirmed nothing was taken. Cancelled.',

  /**
   * INTENT: the opposite result, and the one staff will not expect. A payment DID go through; the
   * order is now marked paid and a receipt exists. Must not read like an error.
   */
  gateway_confirmed_paid:
    'PENDING COPY: this one WAS paid after all. It has been marked paid and was not cancelled.',

  /**
   * INTENT: a payment exists but is for a different amount than the order, or the provider gave no
   * amount at all. Neither paid nor cancelled — a person has to reconcile it. Must convey that money
   * may well have been taken.
   */
  gateway_paid_amount_disagrees:
    'PENDING COPY: a payment exists but not for this amount, so it was neither marked paid nor ' +
    'cancelled. Someone needs to check the takings for this one.',

  /**
   * INTENT: card payments are not configured at this venue, so nobody can ask. Must carry the
   * 'may still have been charged on the machine' side of the pinned pair — an absent credential is
   * not evidence that no card was charged.
   */
  unverifiable_no_credentials:
    'PENDING COPY: card payments are not set up at this venue, so the provider cannot be asked ' +
    'about this order. A card may still have been charged on the machine. Left as it is.',

  /**
   * INTENT: this order never got as far as the payment provider, so there is no reference to ask
   * about. Left alone here on purpose — this list covers orders that may still be owed in cash.
   */
  unverifiable_no_gateway_reference:
    'PENDING COPY: no card payment was ever started for this order, so there is nothing to check ' +
    'with the provider. Left as it is — it may still be owed.',

  /** INTENT: the provider could not be reached for this one. Not an answer. Try again later. */
  skipped_gateway_unreachable:
    'PENDING COPY: the payment provider could not be reached for this order, so nothing was ' +
    'decided about it. Not the same as unpaid. Left as it is.',

  /**
   * INTENT: the provider has no record, yet this order carries a payment marker. Contradictory, so
   * a person must look. Must carry the 'may still have been charged' side.
   */
  skipped_gateway_no_record_but_marker_present:
    'PENDING COPY: the provider has no record of this one, but the order says a payment was ' +
    'started. Those disagree, so nothing was changed. Check the machine roll.',

  /** INTENT: the provider replied with something we do not understand. Never treated as unpaid. */
  skipped_gateway_status_unrecognised:
    'PENDING COPY: the payment provider gave an answer we do not recognise, so nothing was ' +
    'decided. Left as it is.',

  /**
   * INTENT: a payment has ALREADY been confirmed for this order and only the amount is disputed —
   * cancelling it would cancel a real charge. It stays for a person.
   */
  skipped_gateway_confirmed_payment_already_held:
    'PENDING COPY: a payment has already been confirmed for this order, so it was not touched. ' +
    'It is waiting on someone to check the amount.',

  /** INTENT: it was resolved by someone or something else while this was running. */
  skipped_already_resolved:
    'PENDING COPY: this one was already sorted out while the check was running, so it was left alone.',

  /** INTENT: the trustworthiness test failed, so this order's answer was never used. */
  skipped_control_failed:
    'PENDING COPY: the answers from the payment provider could not be trusted in this check, so ' +
    'this order was left as it is.',

  /** INTENT: no trustworthiness test could be set up at this venue. */
  skipped_control_unavailable:
    'PENDING COPY: there was no way to test that the payment provider was answering correctly, so ' +
    'this order was left as it is.',

  /** INTENT: too many at once; this one was not reached. Press again. */
  deferred_run_cap:
    'PENDING COPY: there were too many to do in one go, so this one was not reached. Run the ' +
    'check again to pick it up.',
}

/**
 * The banner derivation's semantic answer -> the sentence for it. Exhaustive by type, so a new
 * banner cannot reach a screen with nothing to say.
 */
export const CLEAR_HELD_BANNER_COPY: Record<Exclude<ClearHeldBanner, null>, string> = {
  all_gateway_calls_failed: CLEAR_HELD_CONTROL_COPY.allGatewayCallsFailed,
  control_failed: CLEAR_HELD_CONTROL_COPY.controlFailed,
  no_credentials: CLEAR_HELD_CONTROL_COPY.noCredentials,
  control_unavailable: CLEAR_HELD_CONTROL_COPY.controlUnavailable,
  nothing_changed: CLEAR_HELD_CONTROL_COPY.nothingChanged,
}

/** Every string on this control that still needs the owner's sign-off. Read by the copy test. */
export function unsignedClearHeldStrings(): string[] {
  const strings = [
    ...Object.values(CLEAR_HELD_CONTROL_COPY),
    ...CLEAR_HELD_OUTCOMES.map((outcome) => CLEAR_HELD_OUTCOME_COPY[outcome]),
  ]
  return strings.filter((s) => s.startsWith(CLEAR_HELD_PENDING_COPY_MARKER))
}
