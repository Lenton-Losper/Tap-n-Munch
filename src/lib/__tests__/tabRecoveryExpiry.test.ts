/**
 * #265 requirement 4 — when the recovery QR stops being shown.
 *
 * "A dead QR left on screen is worse than no QR": the customer scans it, is refused, and asks staff
 * again — so the terminal told them something false and cost them a second interaction.
 *
 * THE ASYMMETRY THAT DECIDES EVERY CLAMP BELOW. Showing an expired notice for a code that was
 * actually still live costs one tap to make another. Showing a live QR for a code that is already
 * dead sends the customer away with something that will refuse them. When the two clocks disagree
 * and we cannot tell which is right, the first mistake is the one to make.
 */
import {
  TAB_RECOVERY_TTL_MS,
  isRecoveryExpired,
  recoveryLifetimeMs,
  recoverySecondsRemaining,
} from '../tabRecoveryExpiry';

/** An arbitrary fixed "now" on the device clock. */
const NOW = Date.parse('2026-08-27T05:00:00.000Z');
const MINUTE = 60 * 1000;

describe('#265 — recoveryLifetimeMs', () => {
  it('uses the server instant when the two clocks broadly agree', () => {
    const expiresAt = new Date(NOW + 15 * MINUTE).toISOString();
    expect(recoveryLifetimeMs(expiresAt, NOW)).toBe(15 * MINUTE);
  });

  it('falls back to the route TTL when the server sends nothing', () => {
    // Absent must not mean "show it forever", which is the defect this requirement names.
    expect(recoveryLifetimeMs(null, NOW)).toBe(TAB_RECOVERY_TTL_MS);
  });

  it('falls back to the route TTL on an unparseable value', () => {
    // A malformed string must not kill a live code either.
    for (const bad of ['', 'soon', 'not-a-date', '15 minutes']) {
      expect(recoveryLifetimeMs(bad, NOW)).toBe(TAB_RECOVERY_TTL_MS);
    }
  });

  it('clamps a value longer than the route can possibly issue', () => {
    // The device clock is behind the server's. Trusting it would leave a dead QR up for the
    // difference — here, an extra 45 minutes of a code that stopped working long before.
    const expiresAt = new Date(NOW + 60 * MINUTE).toISOString();
    expect(recoveryLifetimeMs(expiresAt, NOW)).toBe(TAB_RECOVERY_TTL_MS);
  });

  it('treats an already-past instant as dead on arrival', () => {
    // Either genuinely expired, or this terminal runs fast. Indistinguishable, and the safe
    // direction is to refuse to show it.
    const expiresAt = new Date(NOW - MINUTE).toISOString();
    expect(recoveryLifetimeMs(expiresAt, NOW)).toBe(0);
  });

  it('keeps a short but real remaining window', () => {
    // Not clamped up to the TTL: a code with 90 seconds left has 90 seconds left.
    const expiresAt = new Date(NOW + 90 * 1000).toISOString();
    expect(recoveryLifetimeMs(expiresAt, NOW)).toBe(90 * 1000);
  });

  it('is exactly the TTL at the boundary, not clamped past it', () => {
    const expiresAt = new Date(NOW + TAB_RECOVERY_TTL_MS).toISOString();
    expect(recoveryLifetimeMs(expiresAt, NOW)).toBe(TAB_RECOVERY_TTL_MS);
  });

  it('agrees with the route TTL the issue documents', () => {
    expect(TAB_RECOVERY_TTL_MS).toBe(15 * MINUTE);
  });
});

describe('#265 — isRecoveryExpired', () => {
  it('is false while time remains', () => {
    expect(isRecoveryExpired(NOW, 15 * MINUTE, NOW)).toBe(false);
    expect(isRecoveryExpired(NOW, 15 * MINUTE, NOW + 14 * MINUTE)).toBe(false);
  });

  it('is true at the boundary, not one tick after it', () => {
    // The QR must be gone AT expiry. A code that dies at 15:00 and is shown at 15:00 is a code
    // being shown after it stopped working.
    expect(isRecoveryExpired(NOW, 15 * MINUTE, NOW + 15 * MINUTE)).toBe(true);
  });

  it('is true afterwards', () => {
    expect(isRecoveryExpired(NOW, 15 * MINUTE, NOW + 16 * MINUTE)).toBe(true);
  });

  it('is immediately true for a zero lifetime', () => {
    // What a dead-on-arrival server instant produces. It must never render a QR at all.
    expect(isRecoveryExpired(NOW, 0, NOW)).toBe(true);
  });

  it('measures elapsed time, so clock skew cancels', () => {
    // The point of holding a duration rather than the server's absolute instant: shift BOTH the
    // issue time and now by the same amount — a terminal ten minutes off — and nothing changes.
    const skew = 10 * MINUTE;
    expect(
      isRecoveryExpired(NOW + skew, 15 * MINUTE, NOW + skew + 14 * MINUTE),
    ).toBe(false);
    expect(
      isRecoveryExpired(NOW - skew, 15 * MINUTE, NOW - skew + 16 * MINUTE),
    ).toBe(true);
  });
});

describe('#265 — recoverySecondsRemaining', () => {
  it('counts down in whole seconds', () => {
    expect(recoverySecondsRemaining(NOW, 15 * MINUTE, NOW)).toBe(900);
    expect(recoverySecondsRemaining(NOW, 15 * MINUTE, NOW + 60 * 1000)).toBe(
      840,
    );
  });

  it('never goes negative', () => {
    // The countdown is read by staff; "-42" would look like a fault rather than an expiry.
    expect(recoverySecondsRemaining(NOW, 15 * MINUTE, NOW + 20 * MINUTE)).toBe(
      0,
    );
  });

  it('is 0 exactly at expiry', () => {
    expect(recoverySecondsRemaining(NOW, 15 * MINUTE, NOW + 15 * MINUTE)).toBe(
      0,
    );
  });

  it('rounds a part-second up, so it never shows 0 while the code still works', () => {
    // At 500ms left the code is live. Showing "0:00" beside a working QR invites staff to
    // regenerate one they did not need to.
    expect(recoverySecondsRemaining(NOW, 15 * MINUTE, NOW + 15 * MINUTE - 500)).toBe(
      1,
    );
  });
});
