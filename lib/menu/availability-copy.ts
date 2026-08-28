/**
 * EVERY STRING ON THE WAITER'S "MARK UNAVAILABLE" CONTROL.
 *
 * ================================================================================================
 * NONE OF THESE ARE SIGNED. THEY ALL CARRY THE `PENDING COPY:` MARKER, DELIBERATELY.
 * ================================================================================================
 *
 * The owner's instruction, verbatim: *"bring me the list and I write them. Use PENDING COPY
 * placeholders in the meantime so nothing ships in your words."*
 *
 * So they render as markers rather than prose. That is the same mechanism `unsignedCopy()` uses
 * one module over, and it exists because on 2026-08-21 five plausible-sounding placeholder strings
 * reached production and the owner of a multi-location account read `PENDING COPY — Location` on
 * twenty staff screens. The lesson was not "be more careful", it was "make the marker visible to a
 * reviewer, a test AND a grep at once".
 *
 * ================================================================================================
 * CONSEQUENCE THE OWNER NEEDS TO KNOW: THIS CANNOT REACH PRODUCTION UNTIL THE STRINGS ARE WRITTEN
 * ================================================================================================
 *
 * `scripts/check-no-pending-copy.mjs` gates the production deploy on exactly this marker. That is
 * not an obstacle to work around — it is the gate doing its job, and it is why the marker was
 * chosen over provisional wording. Writing the seven strings below unblocks the deploy; nothing
 * else needs to change.
 *
 * THE LIST TO WRITE, and what each one has to carry:
 *
 *   button          the control on a menu item. Says what it does, not what it is.
 *   title           the confirm heading.
 *   body            the confirm body. MUST say the dish disappears for EVERY customer, on the QR
 *                   menu and the terminal, not just this table — that is the whole blast radius
 *                   and it is the thing a waiter will not expect.
 *   confirm         the accept label.
 *   restoreButton   putting it back.
 *   successHidden   confirmation after hiding.
 *   successRestored confirmation after restoring.
 *
 * And the refusals, which each need to say what to do next rather than only what went wrong:
 *
 *   item_not_found          wrong venue, or the item was deleted
 *   authorization_failed    the PIN did not authorise it
 *   already_in_that_state   somebody else got there first
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
  button: 'PENDING COPY: mark-unavailable button',
  title: 'PENDING COPY: mark-unavailable confirm title',
  /**
   * SIGNED BY THE OWNER 2026-08-28. The only string in this object that is not pending.
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
  confirm: 'PENDING COPY: mark-unavailable accept label',
  restoreButton: 'PENDING COPY: restore-to-menu button',
  successHidden: 'PENDING COPY: confirmation after a dish is hidden',
  successRestored: 'PENDING COPY: confirmation after a dish is restored',
} as const

export const MENU_AVAILABILITY_REFUSAL_COPY = {
  item_not_found: 'PENDING COPY: refusal — the item is not on this venue menu',
  authorization_failed: 'PENDING COPY: refusal — the PIN did not authorise this',
  already_in_that_state: 'PENDING COPY: refusal — the dish is already in that state',
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
