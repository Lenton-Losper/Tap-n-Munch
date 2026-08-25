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
 * NOTE ON THE `ALREADY_PAID` CASE. Its expected string is pinned as it stands today. #342 proposes
 * removing that branch, because since #326 every path that could display it intercepts the code
 * first and shows the signed ALREADY_SETTLED_MESSAGE instead. When #342 lands this test SHOULD go
 * red — that is the test working, not breaking, and whoever lands it updates the expectation.
 */
import {
  staffMessageForMarkPaidFailure,
  staffMessageForPinLock,
  staffMessageForRefundRecordFailure,
  staffMessageForSettleFailure,
} from '../staffApiErrors';

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
  it('ALREADY_PAID', () => {
    expect(
      staffMessageForMarkPaidFailure({
        status: 409,
        message: 'x',
        code: 'ALREADY_PAID',
      }),
    ).toBe('This order was already paid.');
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
