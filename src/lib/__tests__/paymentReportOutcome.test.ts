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
  SETTLE_ORDER_ALREADY_PAID,
  UNCONFIRMED_CHECK_FAILED,
  UNCONFIRMED_EXPLANATION,
  UNCONFIRMED_INSTRUCTION,
  UNCONFIRMED_INTERRUPTED,
  UNCONFIRMED_NOT_REPORTED,
  UNCONFIRMED_SETTLE_INSTRUCTION,
  UNCONFIRMED_STILL_UNRESOLVED,
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
