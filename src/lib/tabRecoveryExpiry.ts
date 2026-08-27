/**
 * #265 requirement 4 — when the recovery QR stops being worth showing.
 *
 * "A dead QR left on screen is worse than no QR": the customer scans it, gets a refusal, and asks
 * staff again — so the terminal has told them something false and cost them a second interaction.
 *
 * THE DEVICE CLOCK IS NOT TRUSTED, AND THAT IS THE ONLY SUBTLE PART HERE. `expiresAt` is an
 * absolute instant produced by the SERVER. Comparing it against a POS terminal's own clock means
 * any skew lands directly on the customer: a terminal running ten minutes fast shows a live code as
 * already dead, and one running ten minutes slow keeps showing a code long after the token stopped
 * working — the exact failure this requirement exists to prevent, reintroduced by arithmetic.
 *
 * So the absolute instant is converted to a DURATION once, at the moment the response arrives, and
 * everything after that is measured with elapsed time on a single clock. Skew cancels: whatever the
 * device thinks "now" is, it is the same "now" on both sides of the subtraction.
 *
 * AND THE DURATION IS SANITY-CHECKED against the known TTL rather than used blindly. A negative or
 * absurd remaining time means the two clocks disagree badly enough that the server's answer tells
 * us nothing useful, and the documented 15-minute TTL is the better estimate. Both directions are
 * clamped, because both produce a wrong screen.
 *
 * Kept free of React Native native modules so it is unit-testable in plain Node.
 */

/**
 * The route's documented TTL. Used when the server sends no `expiresAt`, and as the ceiling when
 * the value it did send implies something the route cannot actually have issued.
 */
export const TAB_RECOVERY_TTL_MS = 15 * 60 * 1000;

/**
 * How long the code is good for, as a duration from NOW, given the server's absolute instant.
 *
 * `receivedAtMs` is the device's clock at the moment the response landed — the same clock that will
 * later be used to measure elapsed time, which is what makes the skew cancel.
 *
 * Returns 0 when the code is already dead by the server's reckoning AND the device clock agrees
 * closely enough to believe it.
 */
export function recoveryLifetimeMs(
  expiresAt: string | null,
  receivedAtMs: number,
): number {
  if (!expiresAt) {
    // No value sent. The route's TTL is the best estimate available.
    return TAB_RECOVERY_TTL_MS;
  }

  const parsed = Date.parse(expiresAt);
  if (!Number.isFinite(parsed)) {
    // Unparseable. Same position as absent — do not let a malformed string kill a live code.
    return TAB_RECOVERY_TTL_MS;
  }

  const remaining = parsed - receivedAtMs;

  if (remaining > TAB_RECOVERY_TTL_MS) {
    /**
     * Longer than the route can issue, so the device clock is behind the server's. Trusting it
     * would show a dead QR for the difference. Clamp to the TTL.
     */
    return TAB_RECOVERY_TTL_MS;
  }

  if (remaining <= 0) {
    /**
     * Already expired by this clock. That is either true, or the device is running fast. We cannot
     * tell them apart, and the safe direction is unambiguous: showing an expired notice for a code
     * that was actually live costs one more tap, while showing a live QR for a dead code sends the
     * customer away with something that will refuse them.
     */
    return 0;
  }

  return remaining;
}

/** Has the code issued at `issuedAtMs` with `lifetimeMs` passed its expiry by `nowMs`? */
export function isRecoveryExpired(
  issuedAtMs: number,
  lifetimeMs: number,
  nowMs: number,
): boolean {
  return nowMs - issuedAtMs >= lifetimeMs;
}

/**
 * Whole seconds left, floored at 0. For the countdown the operator reads while the customer is
 * getting their phone out.
 */
export function recoverySecondsRemaining(
  issuedAtMs: number,
  lifetimeMs: number,
  nowMs: number,
): number {
  const left = lifetimeMs - (nowMs - issuedAtMs);
  return left <= 0 ? 0 : Math.ceil(left / 1000);
}
