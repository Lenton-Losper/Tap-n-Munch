/**
 * EVERY STRING ON THE WAITER'S "MARK UNAVAILABLE" CONTROL.
 *
 * SIGNED BY THE OWNER 2026-08-28. All ten strings; `body` was signed and written into this file
 * first (see its own docblock below), the other nine signed the same morning and carried here
 * verbatim from that sign-off.
 *
 * `already_in_that_state` reads as information, not an error, deliberately — during service it
 * usually is: somebody else already took the dish off before this tap landed.
 */

/**
 * WRITTEN AS LITERALS, NOT INTERPOLATED, AND THAT IS DELIBERATE.
 *
 * The first draft built these from `const PENDING = 'PENDING COPY:'` and template literals. The
 * strings said the right thing at runtime and `check-no-pending-copy.mjs` reported OK — because it
 * is a SOURCE scanner and cannot see through `${PENDING}`. The marker existed only after
 * evaluation, so this file would have shipped placeholder text to staff with the gate green: the
 * exact 2026-08-21 failure the gate exists to prevent.
 *
 * So every marker is spelled out on the line it appears on, where the scanner can read it.
 */

export const MENU_AVAILABILITY_COPY = {
  button: 'Mark unavailable',
  title: 'Mark this unavailable?',
  /**
   * SIGNED BY THE OWNER 2026-08-28, ahead of the other nine in this file.
   *
   * Revised after the checkout path was traced. The first draft said only that the dish vanishes
   * from every menu; it did not say what happens to a customer who is ALREADY holding it. That
   * customer is refused at checkout by name — "no longer on the menu ... please remove it" — and
   * has to edit their own order. A waiter deciding whether to press this needs to know they are
   * about to interrupt somebody mid-order, not just change a menu.
   *
   * Do not shorten. The second sentence is the half a waiter cannot infer from the first.
   */
  body:
    'This removes the dish from the menu for every customer in the restaurant, on their phones ' +
    'and on every terminal. Anyone with it in their order right now will be told it is ' +
    'unavailable and asked to take it off themselves.',
  confirm: 'Mark unavailable',
  restoreButton: 'Put back on the menu',
  successHidden: 'Off the menu. Nobody can order it now.',
  successRestored: 'Back on the menu.',
} as const

export const MENU_AVAILABILITY_REFUSAL_COPY = {
  item_not_found: 'This dish is no longer on the menu. Close this and open the menu again.',
  authorization_failed: 'That PIN did not work. Try again, or ask a manager to do it.',
  already_in_that_state: 'Somebody already took this off the menu.',
} as const

export type MenuAvailabilityRefusal = keyof typeof MENU_AVAILABILITY_REFUSAL_COPY

/**
 * The audit reason. NOT staff-facing, so it is written rather than pending — this is what someone
 * reconstructing the change reads months later, and it has to say plainly that a person did it
 * from a terminal rather than that a rule fired.
 */
export const MENU_AVAILABILITY_AUDIT_REASON = {
  hidden:
    'A waiter marked this item unavailable from a terminal. It is withdrawn from every customer ' +
    'menu at this venue, QR and terminal, until it is restored.',
  restored: 'A waiter restored this item to the menu from a terminal.',
} as const
