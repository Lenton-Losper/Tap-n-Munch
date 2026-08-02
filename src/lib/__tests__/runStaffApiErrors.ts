import {
  staffMessageForPinLock,
  staffMessageForMarkPaidFailure,
  staffMessageForSettleFailure,
  staffMessageForRefundRecordFailure,
} from '../staffApiErrors';

const checks: Array<[string, string, string]> = [
  [
    'pin-60s',
    staffMessageForPinLock({
      status: 429,
      message: 'x',
      code: 'PIN_LOCKED',
      retryAfterSeconds: 60,
    }),
    'PIN locked -- try again in 1 minute.',
  ],
  [
    'pin-61s',
    staffMessageForPinLock({
      status: 429,
      message: 'x',
      code: 'PIN_LOCKED',
      retryAfterSeconds: 61,
    }),
    'PIN locked -- try again in 2 minutes.',
  ],
  [
    'pin-none',
    staffMessageForPinLock({
      status: 429,
      message: 'x',
      code: 'PIN_LOCKED',
    }),
    'PIN locked after too many attempts. Try again later.',
  ],
  [
    'paid',
    staffMessageForMarkPaidFailure({
      status: 409,
      message: 'x',
      code: 'ALREADY_PAID',
    }),
    'This order was already paid.',
  ],
  [
    'claim',
    staffMessageForMarkPaidFailure({
      status: 409,
      message: 'x',
      code: 'PAYMENT_CLAIM_CONFLICT',
    }),
    'This payment could not be completed -- the order may already be paid. Refresh and check the order.',
  ],
  [
    'mismatch',
    staffMessageForMarkPaidFailure({
      status: 400,
      message: 'x',
      code: 'AMOUNT_MISMATCH',
      expected: 25,
    }),
    'Payment amount does not match this order. Refresh the order and try again. Expected N$25.00.',
  ],
  [
    'fallback',
    staffMessageForMarkPaidFailure({
      status: 500,
      message: 'boom',
    }),
    'Payment update failed',
  ],
  [
    'settle',
    staffMessageForSettleFailure({
      status: 409,
      message: 'x',
      code: 'SETTLE_CLAIM_CONFLICT',
    }),
    'Some selected orders were already paid. Refresh the table and try again.',
  ],
  [
    'refund',
    staffMessageForRefundRecordFailure({
      status: 400,
      message: 'amount exceeds remaining refundable balance',
      code: 'AMOUNT_EXCEEDS_REMAINING',
      remaining: 12.34,
    }),
    "Refund amount is more than what's left on this sale. Only N$12.34 can still be refunded.",
  ],
];

let failed = 0;
for (const [id, got, want] of checks) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${JSON.stringify(got)}`);
  if (!ok) {
    console.log(`  want ${JSON.stringify(want)}`);
    failed += 1;
  }
}

if (failed) {
  throw new Error(`${failed} staff copy check(s) failed`);
}
console.log('ALL UNIT COPY CHECKS PASSED');
