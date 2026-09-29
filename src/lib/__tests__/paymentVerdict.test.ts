/**
 * #354 — E04111 is a FOURTH state, and the rules for reaching it safely.
 *
 * The asymmetry that governs every assertion here: calling an unresolved payment "never started"
 * tells staff nothing was charged when we do not know that, and they will re-ring the sale. Calling
 * a never-started payment "unresolved" only leaves them mildly worried. So every case where the
 * discriminator is missing or ambiguous must fall to the EXISTING copy, never to the reassuring one.
 */
import {
  isNeverStartedVerdict,
  isUnclassifiedNotPaid,
  unconfirmedMessageForVerdict,
} from '../paymentVerdict';
import {
  UNCONFIRMED_CHECK_FAILED,
  UNCONFIRMED_NEVER_STARTED,
  UNCONFIRMED_NO_CONFIRMATION_YET,
  UNCONFIRMED_STILL_UNRESOLVED,
} from '../../constants/paymentCopy';

/** The attempt's reader result was the operator cancel (K026) -- the only one that qualifies. */
const K026 = 'user_cancelled';

describe('#354 — isNeverStartedVerdict', () => {
  it('is true for an unpaid verdict the server marked E04111 after an operator cancel (K026)', () => {
    expect(isNeverStartedVerdict({paid: false, isE04111: true}, K026)).toBe(true);
  });

  it('is FALSE when the server did not say, which is every server today', () => {
    // The field does not exist on any deployed build. Absent must mean "cannot tell", and
    // "cannot tell" must keep the unresolved copy.
    expect(isNeverStartedVerdict({paid: false}, K026)).toBe(false);
    expect(isNeverStartedVerdict({paid: false, isE04111: undefined}, K026)).toBe(
      false,
    );
  });

  it('is false when the server explicitly said it was not E04111', () => {
    // The other not-paid cause the contract documents: an order with no merchant order number.
    // That is not "never started" and must keep the existing wording.
    expect(isNeverStartedVerdict({paid: false, isE04111: false}, K026)).toBe(false);
  });

  it('never claims "never started" for a payment that was PAID', () => {
    // Belt and braces against a server bug setting both. A paid order took money; telling staff
    // nothing was charged would be the worst single sentence this screen could produce.
    expect(isNeverStartedVerdict({paid: true, isE04111: true}, K026)).toBe(false);
    expect(isNeverStartedVerdict({paid: true}, K026)).toBe(false);
  });

  it('does not read the flag out of a truthy non-boolean', () => {
    // Exact `=== true`, like the can_settle_cash rule. A server sending a string must not be
    // coerced into the one reassuring branch.
    const loose = {paid: false, isE04111: 'yes' as unknown as boolean};
    expect(isNeverStartedVerdict(loose, K026)).toBe(false);
  });
});

describe('#354 — isUnclassifiedNotPaid (the instrument)', () => {
  it('fires for a not-paid verdict carrying no discriminator', () => {
    // The live case on every current server, and the reason the branch above ships inert.
    expect(isUnclassifiedNotPaid({paid: false})).toBe(true);
  });

  it('does not fire once the server answers either way', () => {
    expect(isUnclassifiedNotPaid({paid: false, isE04111: true})).toBe(false);
    expect(isUnclassifiedNotPaid({paid: false, isE04111: false})).toBe(false);
  });

  it('does not fire for a paid verdict', () => {
    // Nothing to classify; the payment resolved.
    expect(isUnclassifiedNotPaid({paid: true})).toBe(false);
  });
});

/**
 * THE MAPPING — which message the card actually shows. This is the assertion the ruling asked for:
 * "making the E04111 branch fall back to UNCONFIRMED_CHECK_FAILED must turn a test red."
 */
describe('#354 — unconfirmedMessageForVerdict', () => {
  it('shows the never-started copy for an E04111 verdict after an operator cancel (K026)', () => {
    expect(unconfirmedMessageForVerdict({paid: false, isE04111: true}, K026)).toBe(
      UNCONFIRMED_NEVER_STARTED,
    );
  });

  it('NEVER falls back to "could not reach the payment provider"', () => {
    // The #354 defect in one assertion: the provider WAS reached and it answered. That string
    // belongs to the catch block, where the check genuinely got no answer.
    for (const verdict of [
      {paid: false, isE04111: true},
      {paid: false, isE04111: false},
      {paid: false},
    ]) {
      expect(unconfirmedMessageForVerdict(verdict, K026)).not.toBe(
        UNCONFIRMED_CHECK_FAILED,
      );
    }
  });

  it('keeps the existing copy when the server did not identify E04111', () => {
    // The other side. A mapping that returned the reassuring string for every not-paid answer
    // would satisfy the first assertion and be far more dangerous than the defect.
    expect(unconfirmedMessageForVerdict({paid: false}, K026)).toBe(
      UNCONFIRMED_STILL_UNRESOLVED,
    );
    expect(unconfirmedMessageForVerdict({paid: false, isE04111: false}, K026)).toBe(
      UNCONFIRMED_STILL_UNRESOLVED,
    );
  });

  it('never shows the reassuring copy for a paid verdict', () => {
    expect(unconfirmedMessageForVerdict({paid: true, isE04111: true}, K026)).toBe(
      UNCONFIRMED_STILL_UNRESOLVED,
    );
  });
});

/**
 * The signed string itself. These pin the rulings that were made ABOUT the words, so an edit that
 * softens them fails rather than shipping.
 */
// Owner ruling 2026-09-29 (D2): this signed string is unchanged, but it is now reachable ONLY after a
// confirmed operator cancel (K026). Any other reader result + E04111 shows
// UNCONFIRMED_NO_CONFIRMATION_YET instead -- see the D2 blocks below.
describe('#354 — the signed copy', () => {
  it('is the owner-approved text, verbatim', () => {
    expect(UNCONFIRMED_NEVER_STARTED).toBe(
      "This payment was never started. The card machine was stopped before it reached the payment provider, so nothing was charged and there is nothing to check. Take payment again when you're ready.",
    );
  });

  it('states flatly that nothing was charged', () => {
    // The one CERTAIN fact in the whole set, and the reason this state is reassuring at all.
    expect(UNCONFIRMED_NEVER_STARTED).toContain('nothing was charged');
  });

  it('kills the retry loop in words', () => {
    // Checking again returns the same E04111 forever. Mingle #698's operator pressed it twice.
    expect(UNCONFIRMED_NEVER_STARTED).toContain('nothing to check');
  });

  it('says "never started", not "not found"', () => {
    // Ruled on: "not found" invites the fear that something was lost.
    expect(UNCONFIRMED_NEVER_STARTED).toContain('never started');
    expect(UNCONFIRMED_NEVER_STARTED.toLowerCase()).not.toContain('not found');
  });

  it('carries NO caution, unlike the other three states', () => {
    // There is no double-charge risk in re-charging something that was never created, so the
    // "may already have been charged" half that is load-bearing elsewhere would be FALSE here.
    expect(UNCONFIRMED_NEVER_STARTED.toLowerCase()).not.toContain(
      'may already have been charged',
    );
    expect(UNCONFIRMED_NEVER_STARTED.toLowerCase()).not.toContain(
      'may have been charged',
    );
    expect(UNCONFIRMED_NEVER_STARTED.toLowerCase()).not.toContain(
      'do not ring',
    );
  });

  it('does not tell the operator to check again', () => {
    // UNCONFIRMED_CHECK_FAILED legitimately does; this one must not, and that is the whole
    // behavioural difference between them.
    expect(UNCONFIRMED_CHECK_FAILED).toContain('Try the check again');
    expect(UNCONFIRMED_NEVER_STARTED).not.toContain('Try the check again');
    expect(UNCONFIRMED_NEVER_STARTED).not.toContain('check again');
  });

  it('is a different string from the two it must not be confused with', () => {
    // It replaced neither — it is a fourth state beside them.
    expect(UNCONFIRMED_NEVER_STARTED).not.toBe(UNCONFIRMED_CHECK_FAILED);
    expect(UNCONFIRMED_NEVER_STARTED).not.toBe(UNCONFIRMED_STILL_UNRESOLVED);
  });

  it('does not blame the provider for being unreachable', () => {
    // The provider WAS reached and answered. That is the defect being fixed.
    expect(UNCONFIRMED_NEVER_STARTED.toLowerCase()).not.toContain(
      'could not reach',
    );
  });
});

/**
 * OWNER RULING 2026-09-29 (D2). "Nothing was charged" is ONLY allowed after a CONFIRMED operator
 * cancellation (K026). A single E04111 after any other reader result means "not registered YET"
 * (order #149 flipped to paid 22 seconds later), so it keeps the unresolved card and its Check.
 */
describe("D2 — 'never started' requires the attempt's own operator cancel", () => {
  const e04111 = {paid: false, isE04111: true};

  it('is FALSE for E04111 after an ambiguous reader result (9027 -> ambiguous)', () => {
    expect(isNeverStartedVerdict(e04111, 'ambiguous')).toBe(false);
  });

  it('is FALSE for E04111 after every non-cancel reader result, and after no attempt at all', () => {
    for (const outcome of [
      'ambiguous',
      'orphaned_ambiguous',
      'confirmed_failure',
      'not_started',
      'success',
      null,
      undefined,
      'USER_CANCELLED',
      'K026',
    ]) {
      expect(isNeverStartedVerdict(e04111, outcome)).toBe(false);
    }
  });

  it('is FALSE for an operator cancel with no E04111 from the server', () => {
    expect(isNeverStartedVerdict({paid: false}, K026)).toBe(false);
    expect(isNeverStartedVerdict({paid: false, isE04111: false}, K026)).toBe(false);
  });

  it('after a non-cancel attempt, E04111 shows "no confirmation yet", never "nothing was charged"', () => {
    const message = unconfirmedMessageForVerdict(e04111, 'ambiguous');
    expect(message).toBe(UNCONFIRMED_NO_CONFIRMATION_YET);
    expect(message).not.toBe(UNCONFIRMED_NEVER_STARTED);
    expect(message.toLowerCase()).not.toContain('nothing was charged');
  });

  it('after a non-cancel attempt, a not-paid answer without E04111 keeps the existing unresolved copy', () => {
    expect(unconfirmedMessageForVerdict({paid: false}, 'ambiguous')).toBe(
      UNCONFIRMED_STILL_UNRESOLVED,
    );
  });
});

describe('D2 — the signed "no confirmation yet" copy', () => {
  it('is the SIGNED text, verbatim (owner sign-off 2026-09-30; shipped in APK 2.41 / 571404a8)', () => {
    expect(UNCONFIRMED_NO_CONFIRMATION_YET).toBe(
      'This payment is still being verified. No confirmation yet, and this can still change, so check again shortly. Do not take a second payment.',
    );
  });

  it("carries the server's sense: can still change, check again, no second payment", () => {
    const lower = UNCONFIRMED_NO_CONFIRMATION_YET.toLowerCase();
    expect(lower).toContain('still being verified');
    expect(lower).toContain('no confirmation yet');
    expect(lower).toContain('can still change');
    expect(lower).toContain('check again');
    expect(lower).toContain('do not take a second payment');
    expect(lower).not.toContain('nothing was charged');
    expect(lower).not.toContain('never started');
  });
});
