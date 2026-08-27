/**
 * The twenty-six "clear all" staff strings, SIGNED 2026-08-27, pinned character for character.
 *
 * WHY EXACT STRINGS RATHER THAN "CONTAINS THE GIST". Copy is signed as a literal. A test that
 * accepted any sentence about an unreachable provider would let a well-meaning reword through
 * without a second sign-off, and the reword is exactly what needs approving. This is the same suite
 * shape as __tests__/payment-outcome-copy-signed-off.test.ts, which pins the six payment-path
 * strings, and it exists for the same reason: so that the next change to one of these sentences is a
 * DECISION someone takes, rather than an edit nobody notices.
 *
 * THE LITERALS BELOW ARE A SECOND, INDEPENDENT COPY OF THE SIGNED TEXT. That duplication is the
 * whole mechanism. A suite that read the strings out of the module and compared them to themselves
 * would pass on any wording at all — an instrument that agrees with itself is not an instrument.
 *
 * FOUR STRINGS ARE DELIBERATELY NOT PINNED HERE: the E04111 persistence refusals, added after the
 * sign-off and still carrying `PENDING COPY:`. They are asserted to be exactly those four and no
 * others, so this suite goes red both when a signed string loses its wording AND when an unsigned
 * one quietly loses its marker.
 */
import {
  CLEAR_HELD_CONTROL_COPY,
  CLEAR_HELD_OUTCOME_COPY,
  CLEAR_HELD_PENDING_COPY_MARKER,
  CLEAR_HELD_UNSIGNED_OUTCOMES,
  unsignedClearHeldStrings,
} from '@/lib/orders/clear-held-for-review-copy'
import { CLEAR_HELD_OUTCOMES } from '@/lib/orders/clear-held-for-review-outcomes'

const SIGNED_CONTROL: Record<string, string> = {
  button: 'check all of these with the payment provider and settle them',
  confirmHeading: 'check and settle all held orders',
  confirmBody:
    'each of these {count} orders ({amount}) will be checked with the payment provider first. ' +
    'Only the ones confirmed as never paid are cancelled. Anything that turns out to have been ' +
    'paid is kept and shown to you.',
  confirmAccept: 'yes, check them now',
  confirmCancel: 'not now',
  running: 'checking each order with the payment provider…',
  resultsHeading: 'what happened to each order',
  requestFailed: 'the check could not be run, so nothing was changed and nothing here is settled.',
  allGatewayCallsFailed:
    'the payment provider could not be reached for any of these orders. This does NOT mean they ' +
    'were unpaid — it means nothing could be checked. Nothing was changed. Try again later.',
  controlFailed:
    'a test check against an order we know was paid did not come back as paid, so the answers for ' +
    'these orders cannot be trusted. Nothing was changed.',
  controlUnavailable:
    'there is no completed card payment at this venue to test the check against, so these orders ' +
    'cannot be settled automatically. Nothing was changed.',
  noCredentials:
    'card payments are not set up at this venue, so the payment provider cannot be asked about ' +
    'these orders by anyone. They stay on this list.',
  nothingChanged: 'nothing was changed.',
}

const SIGNED_OUTCOME: Record<string, string> = {
  cancelled: 'the payment provider confirmed nothing was taken. Cancelled.',
  gateway_confirmed_paid:
    'this one WAS paid after all. It has been marked paid and was not cancelled.',
  gateway_paid_amount_disagrees:
    'a payment exists but not for this amount, so it was neither marked paid nor cancelled. ' +
    'Someone needs to check the takings for this one.',
  unverifiable_no_credentials:
    'card payments are not set up at this venue, so the provider cannot be asked about this order. ' +
    'A card may still have been charged on the machine. Left as it is.',
  unverifiable_no_gateway_reference:
    'no card payment was ever started for this order, so there is nothing to check with the ' +
    'provider. Left as it is — it may still be owed.',
  skipped_gateway_unreachable:
    'the payment provider could not be reached for this order, so nothing was decided about it. ' +
    'Not the same as unpaid. Left as it is.',
  skipped_gateway_no_record_but_marker_present:
    'the provider has no record of this one, but the order says a payment was started. Those ' +
    'disagree, so nothing was changed. Check the card machine roll for this order.',
  skipped_gateway_status_unrecognised:
    'the payment provider gave an answer we do not recognise, so nothing was decided. Left as it is.',
  skipped_gateway_confirmed_payment_already_held:
    'a payment has already been confirmed for this order, so it was not touched. It is waiting on ' +
    'someone to check the amount.',
  skipped_already_resolved:
    'this one was already sorted out while the check was running, so it was left alone.',
  skipped_control_failed:
    'the answers from the payment provider could not be trusted in this check, so this order was ' +
    'left as it is.',
  skipped_control_unavailable:
    'there was no way to test that the payment provider was answering correctly, so this order was ' +
    'left as it is.',
  deferred_run_cap:
    'there were too many to do in one go, so this one was not reached. Run the check again to pick ' +
    'it up.',

  /**
   * SIGNED 2026-08-27. The four verdicts the owner's 72h E04111 persistence ruling created — they
   * did not exist when the other twenty-six were drafted.
   *
   * Three say "run the check again" because waiting genuinely resolves them. The fourth does NOT,
   * and that asymmetry is asserted separately below: an order with no record of when a card was
   * presented can never be decided by this check, so telling staff to try later would send them
   * back forever.
   */
  skipped_e04111_too_recent:
    'it is too soon to decide about this one - a payment can still turn up for it. Nothing was ' +
    'changed. Run the check again in a day or two.',
  skipped_e04111_insufficient_observations:
    'this one has not been checked enough times yet to be sure, so nothing was changed. A card may ' +
    'still have been charged on the machine. Run the check again later.',
  skipped_e04111_observations_too_close_together:
    'the checks on this one were all made at about the same time, so they do not yet show a settled ' +
    'answer. Nothing was changed. Run the check again tomorrow.',
  skipped_e04111_no_attempt_timestamp:
    'this order has no record of when a card was presented, so this check cannot decide about it - ' +
    'now or later. A card may still have been charged on the machine. Someone needs to look at ' +
    'this one.',
}

/** Every signed string, in one list, for the checks that apply to all of them. */
const ALL_SIGNED = [...Object.values(SIGNED_CONTROL), ...Object.values(SIGNED_OUTCOME)]

describe('"clear all" control copy — signed 2026-08-27', () => {
  it('matches the signed wording exactly, for all thirteen control strings', () => {
    for (const [key, text] of Object.entries(SIGNED_CONTROL)) {
      expect(CLEAR_HELD_CONTROL_COPY[key as keyof typeof CLEAR_HELD_CONTROL_COPY]).toBe(text)
    }
  })

  it('pins the SET of control strings, so a new one cannot appear unpinned', () => {
    /**
     * The exact-match loop above only checks the strings it knows about. A fourteenth control
     * string added tomorrow would render on a staff screen with nothing in this file having an
     * opinion about it — which is precisely the state this suite was written to end.
     */
    expect(Object.keys(CLEAR_HELD_CONTROL_COPY).sort()).toEqual(Object.keys(SIGNED_CONTROL).sort())
  })

  it('PINS "This does NOT mean they were unpaid" in its own assertion', () => {
    // Owner instruction, 2026-08-27, verbatim: "That sentence is the whole point and it is the
    // kind of thing shortened out later."
    //
    // Without it the banner reads "we could not reach the provider, nothing was changed" — which a
    // staff member looking at six untouched orders resolves as "so none of them were paid". A run
    // in which every gateway call failed produces a list of untouched orders that is
    // BYTE-IDENTICAL to a run in which six orders were genuinely fine. This clause is the only
    // thing on the screen that tells those two apart.
    const s = CLEAR_HELD_CONTROL_COPY.allGatewayCallsFailed
    expect(s).toContain('This does NOT mean they were unpaid')
    // The half that makes it necessary must survive too.
    expect(s).toContain('nothing could be checked')
    // A shortened version that keeps the setup and drops the load-bearing clause must FAIL here:
    // the clause is asserted with its capitalised NOT, so a softening to "does not" is caught.
    expect(s).toContain('NOT')
    expect(s.indexOf('This does NOT mean they were unpaid')).toBeLessThan(
      s.indexOf('Nothing was changed'),
    )
  })

  it('never lets the outage banner read as an all-clear', () => {
    const s = CLEAR_HELD_CONTROL_COPY.allGatewayCallsFailed
    expect(s).not.toMatch(/\bnone (of them )?were paid\b|\ball unpaid\b|\bnothing was owed\b/i)
  })
})

describe('"clear all" per-outcome copy — signed 2026-08-27', () => {
  it('matches the signed wording exactly, for all thirteen signed outcome lines', () => {
    for (const [outcome, text] of Object.entries(SIGNED_OUTCOME)) {
      expect(CLEAR_HELD_OUTCOME_COPY[outcome as never]).toBe(text)
    }
  })

  it('PINS the last sentence of skipped_gateway_no_record_but_marker_present', () => {
    // Owner instruction, 2026-08-27, verbatim: "Staff need to know what to check, not just that
    // they should."
    //
    // The earlier draft ended "Check the machine roll." — which machine, and whose roll? The
    // staff member is standing in front of a card reader, a printer and a POS terminal. This is
    // the one line on this surface that sends somebody to a physical object, so it has to name it.
    const s = CLEAR_HELD_OUTCOME_COPY.skipped_gateway_no_record_but_marker_present
    expect(s.endsWith('Check the card machine roll for this order.')).toBe(true)
    // And the contradiction that makes the instruction necessary must still be stated.
    expect(s).toContain('the order says a payment was started')
    expect(s).toContain('nothing was changed')
  })

  it('keeps the two opposite sentences opposite', () => {
    /**
     * The pinned pair `held-for-review.ts` already enforces one surface over: 'Nothing was taken.'
     * tells staff they may act without checking the terminal roll; 'A card may still have been
     * charged on the machine.' tells them they must go and check it first. Every line inherits one
     * side and must not blur it.
     *
     * `cancelled` is the ONLY line permitted to say nothing was taken, because it is the only one
     * behind a positively-established gateway answer AND a passing positive control.
     */
    const claimsNothingTaken = Object.entries(SIGNED_OUTCOME).filter(([, text]) =>
      /nothing was taken/i.test(text),
    )
    expect(claimsNothingTaken.map(([k]) => k)).toEqual(['cancelled'])

    // And the lines that must carry the other side actually do.
    for (const outcome of ['unverifiable_no_credentials'] as const) {
      expect(CLEAR_HELD_OUTCOME_COPY[outcome]).toContain(
        'A card may still have been charged on the machine.',
      )
    }
  })
})

describe('the signed set as a whole', () => {
  it('carries no placeholder marker in either word order', () => {
    // `verify-payment-outcome.ts` spelled its placeholders `[COPY PENDING: ...]`, which the
    // production gate's `/PENDING COPY/` marker did not match, and three of them sat on production
    // unsigned for days. Both word orders, case-insensitive, on every signed string.
    for (const s of ALL_SIGNED) {
      expect(s).not.toMatch(/PENDING[\s_-]*COPY|COPY[\s_-]*PENDING/i)
    }
  })

  it('keeps its em dashes exactly where they were signed, and nowhere else', () => {
    /**
     * THE MIRROR IMAGE OF THE TERMINAL SUITE'S CHECK, and deliberately so. That one FORBIDS em
     * dashes because the terminal's font stack renders them differently. This surface is a browser
     * dashboard and two of these sentences were signed WITH one, so here the check pins the
     * inventory instead: an editor autocorrect, a "smart punctuation" pass, or a de-smartening pass
     * that swapped — for - would all be a silent reword of signed copy, and all three are caught by
     * asserting exactly which strings carry the character.
     */
    const EM_DASH = '—'
    const withEmDash = ALL_SIGNED.filter((s) => s.includes(EM_DASH))
    expect(withEmDash).toEqual([
      SIGNED_CONTROL.allGatewayCallsFailed,
      SIGNED_OUTCOME.unverifiable_no_gateway_reference,
    ])
    // Exactly one each: a second one appearing is a reword too.
    for (const s of withEmDash) {
      expect(s.split(EM_DASH)).toHaveLength(2)
    }
    // The en dash is never signed anywhere. It is the character an autocorrect substitutes.
    for (const s of ALL_SIGNED) {
      expect(s).not.toContain('–')
    }
    // The single typographic ellipsis is signed, on the in-flight label and only there.
    expect(ALL_SIGNED.filter((s) => s.includes('…'))).toEqual([SIGNED_CONTROL.running])
  })

  it('is THIRTY signed strings and nothing unsigned — the four E04111 refusals were signed 2026-08-27', () => {
    /**
     * BOTH DIRECTIONS IN ONE ASSERTION, because each alone has a way of passing while wrong.
     * Counting the signed strings alone would not notice a marker deleted to get
     * `check-no-pending-copy` green; counting the unsigned ones alone would not notice a signed
     * string quietly gaining a marker back.
     */
    // Was 26 signed / 4 unsigned. The owner signed the four E04111 refusals on 2026-08-27 and
    // this assertion was INVERTED rather than deleted: it was a tripwire for exactly that moment,
    // and it fired. What it protects now is the other direction — nothing may quietly become
    // unsigned, and no outcome may exist without a pinned string.
    expect(ALL_SIGNED).toHaveLength(30)

    const unsigned = unsignedClearHeldStrings()
    expect(unsigned).toHaveLength(0)
    expect(CLEAR_HELD_UNSIGNED_OUTCOMES).toHaveLength(0)
    // The marker constant itself must survive, or the mechanism goes with the placeholders.
    expect(CLEAR_HELD_PENDING_COPY_MARKER).toBe('PENDING COPY:')
    // Every outcome is either pinned above or named unsigned. No third category.
    for (const outcome of CLEAR_HELD_OUTCOMES) {
      const pinned = Object.prototype.hasOwnProperty.call(SIGNED_OUTCOME, outcome)
      const declaredUnsigned = CLEAR_HELD_UNSIGNED_OUTCOMES.includes(outcome)
      expect(pinned !== declaredUnsigned).toBe(true)
    }
  })

  it('tells staff to retry the three verdicts that clear by waiting, and NOT the fourth', () => {
    // The load-bearing asymmetry in the four signed 2026-08-27. `no_attempt_timestamp` is the only
    // one that never resolves on its own -- there is no timestamp to age -- so inviting a retry
    // would send staff back to it forever. The other three do resolve by waiting.
    for (const k of [
      'skipped_e04111_too_recent',
      'skipped_e04111_insufficient_observations',
      'skipped_e04111_observations_too_close_together',
    ]) {
      expect(SIGNED_OUTCOME[k]).toMatch(/Run the check again/)
    }
    expect(SIGNED_OUTCOME.skipped_e04111_no_attempt_timestamp).not.toMatch(/Run the check again/)
    expect(SIGNED_OUTCOME.skipped_e04111_no_attempt_timestamp).toContain('now or later')
    expect(SIGNED_OUTCOME.skipped_e04111_no_attempt_timestamp).toContain('Someone needs to look at this one')
  })

  it('warns that a card may still have been charged on the two verdicts where that is true', () => {
    // Not on `too_recent` -- there the payment may simply not have reached the gateway yet, and
    // saying "may have been charged" on every refusal trains staff to ignore the sentence.
    expect(SIGNED_OUTCOME.skipped_e04111_insufficient_observations).toContain('may still have been charged')
    expect(SIGNED_OUTCOME.skipped_e04111_no_attempt_timestamp).toContain('may still have been charged')
    expect(SIGNED_OUTCOME.skipped_e04111_too_recent).not.toContain('may still have been charged')
  })

  it('starts every signed line lower case, as they were signed', () => {
    // Not a style rule invented here: all twenty-six were signed that way because each renders
    // after a label or an order number rather than as a standalone paragraph. Pinned so a
    // sentence-case pass over the file is a decision rather than a diff nobody reads.
    for (const s of ALL_SIGNED) {
      expect(s[0]).toBe(s[0].toLowerCase())
    }
  })
})
