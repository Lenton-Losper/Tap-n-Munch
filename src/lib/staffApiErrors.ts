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

/** Whole seconds as a short human duration: 45 -> "45 seconds", 90 -> "2 minutes". */
function describeSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function staffMessageForSettleFailure(
  err: StaffApiErrorFields,
): string {
  switch (err.code) {
    case 'SETTLE_CLAIM_CONFLICT':
      return 'Some selected orders were already paid. Refresh the table and try again.';

    // The one case cash is refused: a card payment is live on the reader for one of the
    // selected orders. Tells staff what to do rather than leaving them at a dead end.
    case 'CARD_PAYMENT_IN_FLIGHT': {
      const wait =
        err.retryAfterSeconds != null && err.retryAfterSeconds > 0
          ? ` Wait ${describeSeconds(err.retryAfterSeconds)}, or cancel the card payment on the terminal.`
          : ' Wait for it to finish, or cancel the card payment on the terminal.';
      return `A card payment is already in progress for part of this selection.${wait}`;
    }

    case 'ALREADY_PAID':
      return 'Those orders have already been paid. Refresh the table.';

    case 'NOT_SETTLEABLE':
      return 'Some orders in this selection cannot be settled right now. Refresh the table and check their status.';

    case 'UNSUPPORTED_PAYMENT_METHOD':
      return 'That payment method is not accepted here. Use Card or Cash.';

    case 'AMOUNT_MISMATCH': {
      const base =
        'The amount does not match the orders selected. Refresh the table and try again.';
      return err.expected != null
        ? `${base} Expected ${formatNadAmount(err.expected)}.`
        : base;
    }

    case 'AUTHORIZATION_INVALID':
      return 'That staff authorization could not be verified. Enter the PIN again.';

    case 'ATTRIBUTION_INCOMPLETE':
      return 'Staff authorization was incomplete. Enter the PIN again.';

    default:
      return err.message;
  }
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
