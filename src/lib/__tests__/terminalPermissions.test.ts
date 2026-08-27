/**
 * #265 — who is shown the PIN-recovery control.
 *
 * THE CLIENT GATE IS UX, NOT SECURITY. `POST /api/tabs/[tabId]/reset-pin` answers 403 without
 * `orders:update`, so these rules decide whether staff see a control that would fail — not whether
 * a tab can actually be reset. That is why an unreadable list resolves to SHOW rather than HIDE:
 * hidden-when-it-should-show is invisible and silent, and is how a shipped feature turns out to
 * have been inert for a month. Shown-when-it-should-hide costs one tap and a refusal message.
 */
import {
  ORDERS_UPDATE_PERMISSION,
  canResetTabPin,
  hasTerminalPermission,
} from '../terminalPermissions';

describe('#265 — hasTerminalPermission', () => {
  it('grants when the permission is listed', () => {
    expect(
      hasTerminalPermission(['orders:read', 'orders:update'], 'orders:update'),
    ).toBe(true);
  });

  it('refuses when an explicit list omits it', () => {
    // A real statement about this terminal, and it is obeyed.
    expect(hasTerminalPermission(['orders:read'], 'orders:update')).toBe(false);
  });

  it('refuses on an explicitly empty list', () => {
    // `permissions: []` says this terminal has none. That is a statement, not a gap.
    expect(hasTerminalPermission([], 'orders:update')).toBe(false);
  });

  it('grants when the server said nothing at all', () => {
    // Every server that has not shipped the field. Deferring to the server is the safe direction.
    for (const absent of [undefined, null]) {
      expect(hasTerminalPermission(absent, 'orders:update')).toBe(true);
    }
  });

  it('grants when the shape is not one we understand', () => {
    // Not an array: a string, an object, a number. We cannot read it, so we do not pretend to.
    for (const odd of ['orders:update', {orders: true}, 42, true]) {
      expect(hasTerminalPermission(odd, 'orders:update')).toBe(true);
    }
  });

  it('grants when an array contains no strings', () => {
    // Unreadable content in a readable container — still "cannot tell", not "no".
    expect(hasTerminalPermission([1, 2, 3], 'orders:update')).toBe(true);
    expect(hasTerminalPermission([{}, null], 'orders:update')).toBe(true);
  });

  it('matches exactly — no prefixes, no case folding', () => {
    // A permission system where 'ORDERS:UPDATE' or 'orders:updates' silently grants
    // 'orders:update' will eventually grant something nobody intended.
    expect(hasTerminalPermission(['ORDERS:UPDATE'], 'orders:update')).toBe(
      false,
    );
    expect(hasTerminalPermission(['orders:updates'], 'orders:update')).toBe(
      false,
    );
    expect(hasTerminalPermission(['orders:up'], 'orders:update')).toBe(false);
    expect(hasTerminalPermission([' orders:update '], 'orders:update')).toBe(
      false,
    );
  });

  it('ignores unreadable entries beside readable ones', () => {
    // A mixed array is still a real list; the strings in it are the statement.
    expect(
      hasTerminalPermission([null, 'orders:update', 7], 'orders:update'),
    ).toBe(true);
    expect(hasTerminalPermission([null, 'orders:read', 7], 'orders:update')).toBe(
      false,
    );
  });
});

describe('#265 — canResetTabPin', () => {
  it('asks for orders:update, the permission the route enforces', () => {
    expect(ORDERS_UPDATE_PERMISSION).toBe('orders:update');
    expect(canResetTabPin(['orders:update'])).toBe(true);
    expect(canResetTabPin(['orders:read'])).toBe(false);
  });

  it('shows the control while the permission list is still loading', () => {
    // The screen starts with `undefined` and fills it in from /terminal/me. The control must not
    // flicker out of existence in the meantime, nor stay hidden if that fetch fails.
    expect(canResetTabPin(undefined)).toBe(true);
  });
});
