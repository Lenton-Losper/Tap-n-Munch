/**
 * Staff-facing copy for payment-integrity API errors.
 * Kept free of React Native native modules so it can be unit-tested in Node.
 */

export type StaffApiErrorFields = {
  status: number;
  message: string;
  code?: string;
  expected?: number | null;
  remaining?: number | null;
  retryAfterSeconds?: number | null;
};

export function formatNadAmount(amount: number): string {
  return `N$${amount.toFixed(2)}`;
}

export function isPinLockedError(err: StaffApiErrorFields): boolean {
  return err.status === 429 || err.code === 'PIN_LOCKED';
}

export function staffMessageForPinLock(err: StaffApiErrorFields): string {
  const seconds = err.retryAfterSeconds;
  if (seconds != null && seconds > 0) {
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `PIN locked -- try again in ${minutes} minute${
      minutes === 1 ? '' : 's'
    }.`;
  }
  return 'PIN locked after too many attempts. Try again later.';
}

export function staffMessageForMarkPaidFailure(
  err: StaffApiErrorFields,
): string {
  switch (err.code) {
    case 'ALREADY_PAID':
      return 'This order was already paid.';
    case 'PAYMENT_CLAIM_CONFLICT':
      return 'This payment could not be completed -- the order may already be paid. Refresh and check the order.';
    case 'AMOUNT_MISMATCH': {
      const base =
        'Payment amount does not match this order. Refresh the order and try again.';
      if (err.expected != null) {
        return `${base} Expected ${formatNadAmount(err.expected)}.`;
      }
      return base;
    }
    default:
      return 'Payment update failed';
  }
}

export function staffMessageForSettleFailure(
  err: StaffApiErrorFields,
): string {
  if (err.code === 'SETTLE_CLAIM_CONFLICT') {
    return 'Some selected orders were already paid. Refresh the table and try again.';
  }
  return err.message;
}

export function isRefundAmountExceedsRemaining(
  err: StaffApiErrorFields,
): boolean {
  return (
    err.code === 'AMOUNT_EXCEEDS_REMAINING' ||
    /exceeds remaining/i.test(err.message)
  );
}

export function staffMessageForRefundRecordFailure(
  err: StaffApiErrorFields,
): string {
  if (isRefundAmountExceedsRemaining(err)) {
    const lines = [
      "Refund amount is more than what's left on this sale.",
    ];
    if (err.remaining != null) {
      lines.push(
        `Only ${formatNadAmount(err.remaining)} can still be refunded.`,
      );
    }
    return lines.join(' ');
  }
  return err.message;
}
