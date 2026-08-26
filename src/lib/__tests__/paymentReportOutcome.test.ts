/**
 * #327 / #326 — the classifier that decides whether food may be released.
 *
 * THE TEST THAT MATTERS is 'left_pending_finatic_uncertain' => 'unknown'. Order #868 was reported
 * DECLINED by the reader, the server answered that outcome, and N$33 of food went out because
 * nothing on the device could tell that answer apart from the other two. Every other case here
 * exists to stop that one being satisfied trivially — a classifier that returned 'unknown' for
 * everything would also pass it, and would be useless.
 */
import {
  classifyFailureReport,
  classifySuccessReportError,
} from '../paymentReportOutcome';
import {
  ALREADY_SETTLED_MESSAGE,
  PAYMENT_CHECK_STATUS_LABEL,
  PAYMENT_OVER_CEILING_BODY,
  PAYMENT_OVER_CEILING_TITLE,
  PAYMENT_TIMED_OUT_MESSAGE,
  paymentProcessingElapsed,
  SETTLE_ORDER_ALREADY_PAID,
  UNCONFIRMED_CHECK_ACTION,
  UNCONFIRMED_CHECK_FAILED,
  UNCONFIRMED_CHECK_IN_PROGRESS,
  UNCONFIRMED_EXPLANATION,
  UNCONFIRMED_INSTRUCTION,
  UNCONFIRMED_INTERRUPTED,
  UNCONFIRMED_NOT_REPORTED,
  UNCONFIRMED_RETRY_ACTION,
  UNCONFIRMED_SETTLE_INSTRUCTION,
  UNCONFIRMED_STILL_UNRESOLVED,
  UNCONFIRMED_TITLE,
} from '../../constants/paymentCopy';

describe('classifyFailureReport — the three outcomes are three different answers', () => {
  it('left_pending_finatic_uncertain is UNKNOWN, so the food is not released', () => {
    expect(
      classifyFailureReport({
        outcome: 'left_pending_finatic_uncertain',
        success: false,
      }),
    ).toBe('unknown');
  });

  it('classifies the uncertain outcome the same way against the PRE-#329 server', () => {
    // Before 2026-08-24 the route spelled this exact outcome `success: true`. Branching on
    // `outcome` rather than on `success` is what makes the device independent of the server build
    // it happens to be talking to — an APK in the field outlives any given deploy.
    expect(
      classifyFailureReport({
        outcome: 'left_pending_finatic_uncertain',
        success: true,
      }),
    ).toBe('unknown');
  });

  it('corrected_to_paid is SETTLED — the server found the money the device missed', () => {
    expect(
      classifyFailureReport({outcome: 'corrected_to_paid', success: true}),
    ).toBe('settled');
  });

  it('cancelled is NOT_PAID — definitively not taken, and resolved', () => {
    expect(classifyFailureReport({outcome: 'cancelled', success: true})).toBe(
      'not_paid',
    );
  });

  it('gives three DIFFERENT answers, so it is not vacuously safe', () => {
    const answers = new Set([
      classifyFailureReport({outcome: 'corrected_to_paid'}),
      classifyFailureReport({outcome: 'cancelled'}),
      classifyFailureReport({outcome: 'left_pending_finatic_uncertain'}),
    ]);
    expect(answers.size).toBe(3);
  });
});

describe('classifyFailureReport — absent information is never read as resolution', () => {
  it('null (the report never reached the server) is UNKNOWN, not NOT_PAID', () => {
    // The device's own view was "failed", but a device-reported failure can still have taken the
    // money — that is why the Finatic recovery path exists at all. With no server confirmation
    // there is nothing that says otherwise.
    expect(classifyFailureReport(null)).toBe('unknown');
  });

  it('an unrecognised outcome is UNKNOWN', () => {
    expect(
      classifyFailureReport({outcome: 'something_added_later', success: true}),
    ).toBe('unknown');
  });

  it('no outcome field at all is UNKNOWN even when success is true', () => {
    expect(classifyFailureReport({success: true})).toBe('unknown');
  });

  it('an empty body is UNKNOWN', () => {
    expect(classifyFailureReport({})).toBe('unknown');
  });
});

describe('classifySuccessReportError — #326: ALREADY_PAID is not a failure', () => {
  it('ALREADY_PAID is SETTLED', () => {
    // Order #851's card cleared (trans_status 2, N$51.00) and the terminal still rendered FAILED
    // with "Contact support before retrying." on it.
    expect(classifySuccessReportError('ALREADY_PAID')).toBe('settled');
  });

  it('PAYMENT_CLAIM_CONFLICT is UNKNOWN, not settled — its own message says "may"', () => {
    expect(classifySuccessReportError('PAYMENT_CLAIM_CONFLICT')).toBe('unknown');
  });

  it('returns null for errors it has no opinion on, so callers keep their recovery path', () => {
    expect(classifySuccessReportError('AMOUNT_MISMATCH')).toBeNull();
    expect(classifySuccessReportError(undefined)).toBeNull();
    expect(classifySuccessReportError('')).toBeNull();
  });
});

/**
 * #326's FIRST defect was not a wording problem, it was a structural one: two independent messages
 * were concatenated — `${baseError} — could not notify the system.` — producing
 *
 *     "This order was already paid. — could not notify the system. Contact support before retrying."
 *
 * on a screen a customer was standing in front of. These assertions pin the property that made it
 * impossible to write that: every message is ONE complete, self-contained string. They deliberately
 * do not assert the wording, which is the owner's to sign.
 */
/**
 * THE SIGNED COPY, PINNED VERBATIM. Approved by the owner 2026-08-25.
 *
 * These are not style assertions — they are the record. The strings are the owner's, and three of
 * them encode decisions that a well-meaning edit would quietly undo:
 *
 *   - UNCONFIRMED_EXPLANATION has NO "yet". "yet" implied the situation resolves itself; nothing
 *     resolves these, because an order carrying a merchant reference is answered E04111 by the
 *     stale-order cron and skipped forever.
 *   - UNCONFIRMED_CHECK_FAILED blames reaching the PROVIDER, not "checking", so it cannot be read
 *     as the payment having failed.
 *   - UNCONFIRMED_NOT_REPORTED and UNCONFIRMED_INTERRUPTED both say the card MAY HAVE BEEN CHARGED.
 *     That sentence is the point of #327. Its own assertion below exists so that shortening either
 *     string goes red rather than silently dropping the warning.
 *
 * If one of these fails, the right fix is almost never to update the expectation. Signed copy
 * changes with the owner.
 */
describe('payment copy — the signed strings, verbatim', () => {
  it.each([
    ['UNCONFIRMED_TITLE', UNCONFIRMED_TITLE, 'Not confirmed'],
    [
      'UNCONFIRMED_INSTRUCTION',
      UNCONFIRMED_INSTRUCTION,
      'Do not release this order. The payment has not been confirmed.',
    ],
    [
      'UNCONFIRMED_EXPLANATION',
      UNCONFIRMED_EXPLANATION,
      'The card reader and the payment provider do not agree. Check the payment status before doing anything else.',
    ],
    ['UNCONFIRMED_CHECK_ACTION', UNCONFIRMED_CHECK_ACTION, 'Check payment status'],
    ['UNCONFIRMED_CHECK_IN_PROGRESS', UNCONFIRMED_CHECK_IN_PROGRESS, 'Checking...'],
    [
      'UNCONFIRMED_STILL_UNRESOLVED',
      UNCONFIRMED_STILL_UNRESOLVED,
      'Still not confirmed. The payment provider has no answer for this order yet.',
    ],
    [
      'UNCONFIRMED_CHECK_FAILED',
      UNCONFIRMED_CHECK_FAILED,
      'Could not reach the payment provider. Try the check again.',
    ],
    ['UNCONFIRMED_RETRY_ACTION', UNCONFIRMED_RETRY_ACTION, 'Take payment again'],
    [
      'UNCONFIRMED_NOT_REPORTED',
      UNCONFIRMED_NOT_REPORTED,
      'This payment attempt was not recorded. The card may have been charged. Check the payment status before taking payment again.',
    ],
    [
      'UNCONFIRMED_INTERRUPTED',
      UNCONFIRMED_INTERRUPTED,
      'This payment was interrupted before the result was known. The card may have been charged. Check the payment status before taking payment again.',
    ],
    [
      'UNCONFIRMED_SETTLE_INSTRUCTION',
      UNCONFIRMED_SETTLE_INSTRUCTION,
      'The payment could not be confirmed. Do not release these orders. Check the payment status on the order before taking payment again.',
    ],
    [
      'SETTLE_ORDER_ALREADY_PAID',
      SETTLE_ORDER_ALREADY_PAID,
      'This payment did go through. Refresh the table to see what is still owed before taking any more payment.',
    ],
    [
      'ALREADY_SETTLED_MESSAGE',
      ALREADY_SETTLED_MESSAGE,
      'This order is already paid. No further payment is needed.',
    ],
  ])('%s is exactly the signed text', (_name, actual, signed) => {
    expect(actual).toBe(signed);
  });

  it('the two "may have been charged" warnings are present, in those words', () => {
    // Owner decision 3. Asserted separately from the verbatim block so that the REASON for this
    // sentence is visible at the point of failure, not just a long string diff.
    expect(UNCONFIRMED_NOT_REPORTED).toContain('The card may have been charged.');
    expect(UNCONFIRMED_INTERRUPTED).toContain('The card may have been charged.');
  });

  it('the explanation does not promise the problem resolves itself', () => {
    // Owner decision 1. The stale-order cron does not clear these; nothing does.
    expect(UNCONFIRMED_EXPLANATION).not.toMatch(/\byet\b/);
  });

  it('"Checking..." is three ASCII full stops, not U+2026', () => {
    // Signed that way deliberately. A formatter "tidying" this is editing signed copy.
    expect(UNCONFIRMED_CHECK_IN_PROGRESS).toBe('Checking...');
    expect(UNCONFIRMED_CHECK_IN_PROGRESS).not.toContain('…');
    expect([...UNCONFIRMED_CHECK_IN_PROGRESS].map(c => c.codePointAt(0))).toEqual([
      67, 104, 101, 99, 107, 105, 110, 103, 46, 46, 46,
    ]);
  });
});

describe('payment copy — every message stands alone', () => {
  const messages = {
    UNCONFIRMED_INSTRUCTION,
    UNCONFIRMED_EXPLANATION,
    UNCONFIRMED_STILL_UNRESOLVED,
    UNCONFIRMED_CHECK_FAILED,
    UNCONFIRMED_NOT_REPORTED,
    UNCONFIRMED_INTERRUPTED,
    UNCONFIRMED_SETTLE_INSTRUCTION,
    SETTLE_ORDER_ALREADY_PAID,
    ALREADY_SETTLED_MESSAGE,
    // Signed 2026-08-26. They join this set on the day they were signed, deliberately: the
    // stand-alone property is what "one complete message" MEANS, and copy that is signed but not
    // pinned is copy a formatter can quietly rewrite.
    PAYMENT_OVER_CEILING_BODY,
    PAYMENT_TIMED_OUT_MESSAGE,
  };

  it.each(Object.entries(messages))(
    '%s starts as a sentence and ends as one',
    (_name, text) => {
      expect(text.trim()).toBe(text);
      // A message that begins lower-case is a fragment written to be appended to something else.
      expect(text[0]).toBe(text[0].toUpperCase());
      expect(text.endsWith('.')).toBe(true);
    },
  );

  it.each(Object.entries(messages))(
    '%s carries no dangling join',
    (_name, text) => {
      // The em dash in the original was load-bearing punctuation for a join that should not have
      // existed. No message may open with one, or hold one immediately after a full stop.
      expect(text.startsWith('—')).toBe(false);
      expect(text).not.toMatch(/\.\s*—/);
    },
  );
});

/**
 * #346 — THE SIGNED SET, AND THE TWO HALVES THE OWNER PINNED.
 *
 * These are not style assertions. On 2026-08-26 the owner signed the five strings and said of two
 * clauses: *anyone editing them out is reintroducing the defect.* A comment saying so is advice; a
 * test saying so is a gate. Both clauses exist because staff who are told nothing re-ring the sale —
 * 61% of Mingle's non-settling card sales within five minutes, median gap 42s — and a re-ring is a
 * second charge on a card that may already have been debited.
 *
 * Kept as exact substrings rather than whole-string equality on purpose: the sentences AROUND them
 * may be reworded with the owner, and a test that forbids all rewording would be ignored the first
 * time it was in the way. What may not happen is these two disappearing.
 */
describe('#346 signed copy — the load-bearing halves survive', () => {
  const carriesBothHalves = {
    PAYMENT_OVER_CEILING_BODY,
    PAYMENT_TIMED_OUT_MESSAGE,
  };

  it.each(Object.entries(carriesBothHalves))(
    '%s still warns the card may have been charged',
    (_name, text) => {
      // "may already have been charged" / "may still have been charged" — the shared stem is what
      // is pinned, so either adverb passes and dropping the clause does not.
      expect(text).toMatch(/may (already |still )?have been charged/);
    },
  );

  it.each(Object.entries(carriesBothHalves))(
    '%s still says not to ring the sale up again',
    (_name, text) => {
      expect(text).toContain('Do not ring this sale up again.');
    },
  );

  it('the over-ceiling heading does not claim the payment failed', () => {
    // 1.8% of payments that succeed arrive after the 45s ceiling. A heading that says "failed"
    // would be wrong about one sale in fifty-five, and wrong in the direction that produces a
    // second charge.
    expect(PAYMENT_OVER_CEILING_TITLE).toBe(
      'This payment is taking longer than usual',
    );
    expect(PAYMENT_OVER_CEILING_TITLE.toLowerCase()).not.toContain('fail');
    expect(PAYMENT_OVER_CEILING_TITLE.toLowerCase()).not.toContain('declin');
  });

  it('the timed-out message does not read as a failure either', () => {
    expect(PAYMENT_TIMED_OUT_MESSAGE.toLowerCase()).not.toContain('fail');
    expect(PAYMENT_TIMED_OUT_MESSAGE.toLowerCase()).not.toContain('declin');
  });

  it('no signed #346 string offers to cancel', () => {
    // We cannot cancel a card at the reader from here. Offering an action we cannot perform is
    // worse than offering none, and this is the one screen where an operator would believe it.
    for (const text of [
      PAYMENT_OVER_CEILING_TITLE,
      PAYMENT_OVER_CEILING_BODY,
      PAYMENT_CHECK_STATUS_LABEL,
      PAYMENT_TIMED_OUT_MESSAGE,
      paymentProcessingElapsed(12, 45),
    ]) {
      expect(text.toLowerCase()).not.toContain('cancel');
    }
  });
});

/**
 * OWNER DECISION 2026-08-26 — NO EM DASH ON A PAYMENT SCREEN, in the owner's words *exactly the
 * concatenation shape #326 was.*
 *
 * The existing 'carries no dangling join' property forbids a dash immediately after a full stop.
 * This one is stricter and applies to the #346 set: no U+2014 or U+2013 ANYWHERE. The draft
 * PAYMENT_TIMED_OUT_MESSAGE held one mid-sentence, which the earlier property would have passed,
 * and the elapsed pill held one that no test covered at all.
 */
describe('#346 signed copy — no em dash anywhere', () => {
  const signed = {
    PAYMENT_OVER_CEILING_TITLE,
    PAYMENT_OVER_CEILING_BODY,
    PAYMENT_CHECK_STATUS_LABEL,
    PAYMENT_TIMED_OUT_MESSAGE,
    paymentProcessingElapsed: paymentProcessingElapsed(12, 45),
  };

  it.each(Object.entries(signed))('%s holds no em or en dash', (_name, text) => {
    expect(text).not.toContain('—');
    expect(text).not.toContain('–');
  });

  it('the elapsed pill separates label from value with an ASCII hyphen', () => {
    // Signed as typed by the owner: "Processing payment - 12s. Usually done within 45s."
    expect(paymentProcessingElapsed(12, 45)).toBe(
      'Processing payment - 12s. Usually done within 45s.',
    );
  });

  it('the elapsed pill states BOTH the elapsed time and the ceiling', () => {
    // A bounded wait is a different experience from an open one, and the ceiling is the half that
    // bounds it. An elapsed counter alone would still be a screen that never says when to worry.
    const text = paymentProcessingElapsed(7, 45);
    expect(text).toContain('7s');
    expect(text).toContain('45s');
  });
});
