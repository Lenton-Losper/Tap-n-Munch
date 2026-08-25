/**
 * #340 — staff-facing copy for payment-integrity API errors.
 *
 * THESE NINE ASSERTIONS ARE NOT NEW. They were written as `runStaffApiErrors.ts`: a hand-rolled
 * runner in this directory that built an array of [id, actual, expected] triples, compared them in
 * a for-loop, and threw at the end. Every expectation below is that file's, unchanged.
 *
 * WHY IT WAS CONVERTED. Sitting in `__tests__/` it was DISCOVERED by jest but contained no `it()`,
 * so every single run reported "Your test suite must contain at least one test" — a permanent red
 * that was explained away in every brief as a known baseline failure. Meanwhile the checks it
 * contained had never executed under `npm test` at all: they only ran if somebody remembered to
 * invoke the file by hand. So the repo carried the cost of a failing suite and got none of the
 * coverage.
 *
 * Converted rather than moved out of `__tests__/`, because the assertions are worth having — this
 * is the copy staff read when a payment cannot be claimed, and it is easy to reword by accident.
 *
 * THE `ALREADY_PAID` CASE — RESOLVED BY #342, 2026-08-25. An earlier version of this note told the
 * next person to expect a red here and update the expectation. That has happened, and the note is
 * replaced rather than deleted so the history of the decision is readable.
 *
 * It is no longer pinned to a literal. It asserts the SIGNED constant, and — on the owner's ruling
 * — it also asserts that the old unsigned sentence 'This order was already paid.' is ABSENT.
 *
 * WHY AN ABSENCE ASSERTION AND NOT SIMPLY A CHANGED ONE. A deleted expectation protects nothing.
 * An inverted one protects the change: it fails if anyone reintroduces the sentence, which is the
 * actual risk this issue exists for. #342 is worth fixing precisely because dead display text gets
 * resurrected by a later refactor, quietly reinstating "a paid order rendered as an error"; a suite
 * that merely stopped mentioning the string would not notice that happening.
 *
 * There are now THREE assertions on this one code, and each guards a different way of getting it
 * wrong: it must BE the signed constant, it must NOT be the old unsigned sentence, and it must NOT
 * fall through to the generic 'Payment update failed' — which is what deleting the branch outright
 * would have produced, for an order that is paid.
 */
import {
  staffMessageForMarkPaidFailure,
  staffMessageForPinLock,
  staffMessageForRefundRecordFailure,
  staffMessageForSettleFailure,
} from '../staffApiErrors';
import {ALREADY_SETTLED_MESSAGE} from '../../constants/paymentCopy';

describe('staffMessageForPinLock', () => {
  it('rounds a 60 second lockout to one minute, singular', () => {
    expect(
      staffMessageForPinLock({
        status: 429,
        message: 'x',
        code: 'PIN_LOCKED',
        retryAfterSeconds: 60,
      }),
    ).toBe('PIN locked -- try again in 1 minute.');
  });

  it('rounds 61 seconds UP to two minutes, plural', () => {
    // Deliberately rounds up: telling staff to wait slightly longer than necessary is safe, and
    // "1 minute" for 61 seconds sends them back to a still-locked PIN.
    expect(
      staffMessageForPinLock({
        status: 429,
        message: 'x',
        code: 'PIN_LOCKED',
        retryAfterSeconds: 61,
      }),
    ).toBe('PIN locked -- try again in 2 minutes.');
  });

  it('falls back to an untimed message when the server sends no retry-after', () => {
    expect(
      staffMessageForPinLock({status: 429, message: 'x', code: 'PIN_LOCKED'}),
    ).toBe('PIN locked after too many attempts. Try again later.');
  });
});

describe('staffMessageForMarkPaidFailure', () => {
  it('ALREADY_PAID returns the SIGNED settled message, not a second copy of it (#342)', () => {
    // Asserted against the imported constant rather than a literal, deliberately. A literal here
    // would be a third place the same sentence is written, and this test would then pass while the
    // signed copy drifted away from it. paymentReportOutcome.test.ts pins the wording itself.
    expect(
      staffMessageForMarkPaidFailure({
        status: 409,
        message: 'x',
        code: 'ALREADY_PAID',
      }),
    ).toBe(ALREADY_SETTLED_MESSAGE);
  });

  it('ALREADY_PAID no longer returns the old UNSIGNED sentence (#342)', () => {
    // The inverted assertion, on the owner's ruling. It exists to fail if someone reintroduces
    // 'This order was already paid.' — the pre-#326 text that contradicted the signed copy and,
    // on any build without PaymentScreen's interception, rendered a PAID order as an error. That
    // is what #851 displayed. A test that simply stopped mentioning the string would let it back.
    expect(
      staffMessageForMarkPaidFailure({
        status: 409,
        message: 'x',
        code: 'ALREADY_PAID',
      }),
    ).not.toBe('This order was already paid.');
  });

  it('ALREADY_PAID does NOT fall through to the generic failure text (#342)', () => {
    // The reason the case was kept rather than deleted. Falling through would answer
    // 'Payment update failed' for an order that IS paid — #326's defect, reintroduced behind the
    // shadow and waiting for a refactor to make it visible again.
    expect(
      staffMessageForMarkPaidFailure({
        status: 409,
        message: 'x',
        code: 'ALREADY_PAID',
      }),
    ).not.toBe('Payment update failed');
  });

  it('PAYMENT_CLAIM_CONFLICT says the order MAY already be paid', () => {
    // "may" is load-bearing — this code means the claim was refused for an unknown reason, which
    // is why paymentReportOutcome classifies it `unknown` rather than `settled`.
    expect(
      staffMessageForMarkPaidFailure({
        status: 409,
        message: 'x',
        code: 'PAYMENT_CLAIM_CONFLICT',
      }),
    ).toBe(
      'This payment could not be completed -- the order may already be paid. Refresh and check the order.',
    );
  });

  it('AMOUNT_MISMATCH names the expected amount when the server sends one', () => {
    expect(
      staffMessageForMarkPaidFailure({
        status: 400,
        message: 'x',
        code: 'AMOUNT_MISMATCH',
        expected: 25,
      }),
    ).toBe(
      'Payment amount does not match this order. Refresh the order and try again. Expected N$25.00.',
    );
  });

  it('falls back to a generic message for an unrecognised code', () => {
    expect(staffMessageForMarkPaidFailure({status: 500, message: 'boom'})).toBe(
      'Payment update failed',
    );
  });
});

describe('staffMessageForSettleFailure', () => {
  it('SETTLE_CLAIM_CONFLICT', () => {
    expect(
      staffMessageForSettleFailure({
        status: 409,
        message: 'x',
        code: 'SETTLE_CLAIM_CONFLICT',
      }),
    ).toBe('Some selected orders were already paid. Refresh the table and try again.');
  });
});

describe('staffMessageForRefundRecordFailure', () => {
  it('AMOUNT_EXCEEDS_REMAINING names what is still refundable', () => {
    expect(
      staffMessageForRefundRecordFailure({
        status: 400,
        message: 'amount exceeds remaining refundable balance',
        code: 'AMOUNT_EXCEEDS_REMAINING',
        remaining: 12.34,
      }),
    ).toBe(
      "Refund amount is more than what's left on this sale. Only N$12.34 can still be refunded.",
    );
  });
});
