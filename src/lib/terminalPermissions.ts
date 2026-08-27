/**
 * #265 — reading the permission list the terminal token carries.
 *
 * `/api/terminal/me` returns `permissions` typed as `unknown` and, until now, nothing on the device
 * parsed it. This is the parser, and it is deliberately narrow: it answers one question, "may this
 * terminal do X", and returns a boolean rather than handing the raw value inward.
 *
 * THE CLIENT GATE IS UX, NOT SECURITY. `POST /api/tabs/[tabId]/reset-pin` calls requireTerminalAuth
 * and answers 403 without `orders:update`, so a terminal that ignored this entirely could not
 * actually reset anything. What this decides is whether staff are shown a control that would fail.
 *
 * SO AN ABSENT OR UNREADABLE LIST MEANS SHOW IT, and that is a considered choice rather than
 * laziness. The two failure directions are not symmetrical:
 *
 *   hidden when it should be shown  -> the feature is invisible, silently, on every terminal whose
 *                                     server does not send the field. That is the "shipped inert"
 *                                     defect this repo produces more than any other, and nobody
 *                                     finds out for a month.
 *   shown when it should be hidden  -> staff tap it, the server refuses, they see the failure copy.
 *                                     Recoverable, visible, and self-reporting.
 *
 * It is also the convention already established in this file: resolvePaymentMethodsAvailability
 * treats missing flags as enabled for the same reason.
 *
 * AN EXPLICIT LIST IS STILL OBEYED. If the server sends an array and `orders:update` is not in it,
 * the answer is no — that is a real statement about this terminal, not a missing one.
 *
 * Kept free of React Native native modules so it is unit-testable in plain Node.
 */

/** The permission the PIN-recovery control requires. */
export const ORDERS_UPDATE_PERMISSION = 'orders:update';

/**
 * Can this terminal perform an action requiring `permission`?
 *
 * Returns true when the list is absent or not an array of strings (see the module comment), and
 * otherwise exactly whether the permission is present. Matching is exact — a permission system
 * where 'orders:updates' or 'ORDERS:UPDATE' silently grants 'orders:update' is a permission system
 * that will eventually grant something nobody intended.
 */
export function hasTerminalPermission(
  permissions: unknown,
  permission: string,
): boolean {
  if (!Array.isArray(permissions)) {
    // Absent, null, or a shape we do not understand. Defer to the server.
    return true;
  }
  const known = permissions.filter(
    (entry): entry is string => typeof entry === 'string',
  );
  if (known.length === 0) {
    /**
     * An array that contains no strings at all is not a statement about this terminal — it is a
     * shape we cannot read, the same as the case above. An EMPTY array, by contrast, IS a
     * statement: it says this terminal has no permissions, and it is obeyed.
     */
    return permissions.length === 0 ? false : true;
  }
  return known.includes(permission);
}

/** Convenience for the one call site that matters today. */
export function canResetTabPin(permissions: unknown): boolean {
  return hasTerminalPermission(permissions, ORDERS_UPDATE_PERMISSION);
}
