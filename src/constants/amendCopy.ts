/**
 * EVERY STRING ON THE AMEND SHEET.
 *
 * Drafted by me under the owner's standing instruction to draft rather than ask. Nothing here is
 * a PENDING COPY placeholder. If a string reads wrong, say so and it changes.
 *
 * House style, from the 37 the owner signed on 2026-08-28:
 *   say what happens, not what the thing is; plain words a waiter uses; on money or food safety
 *   say the consequence AND what to do; never imply something is settled when it is not; a success
 *   must not read like a warning; say where, not just what; short on buttons, full sentences where
 *   it matters.
 */

/** The sheet's own instruction. Says what the edit does, not what the sheet is. */
export const AMEND_BODY = 'Change how many, or take it off the order.';

/**
 * The window is closed BEFORE the waiter even tries. Says why, and does not offer a control that
 * cannot work — the kitchen already has this one.
 */
export const AMEND_WINDOW_CLOSED =
  'The kitchen has already started this one, so it cannot be changed. Tell them yourself if it has to come off.';

export const AMEND_EFFECT_CHANGE = 'The kitchen sees the old line disappear and a new one arrive.';

/** Zero is a removal. It must not read as "a quantity of none". */
export const AMEND_EFFECT_REMOVE =
  'This takes the item off the order completely. It comes off the bill too.';

export const AMEND_CONFIRM = 'Save the change';
export const AMEND_IN_PROGRESS = 'Saving…';
export const AMEND_CANCEL = 'Leave it as it is';
export const AMEND_DISMISS = 'Close';

/**
 * THE RACE, RENDERED. The waiter pressed while the kitchen was tapping Cooked, and the kitchen
 * won. This must never read as success: the line is unchanged and the customer will be charged
 * for it exactly as it stands.
 */
export const AMEND_REFUSED_HEADING = 'This was not changed:';

/**
 * One reason per refusal string the SQL function can return (migration 20260829150000). Keyed by
 * the server's own literals so a reason cannot drift out of sync with a rename on that side.
 */
export const AMEND_REFUSAL_REASON: Record<string, string> = {
  window_closed:
    'The kitchen started it while you were editing. It is being made and it stays on the bill.',
  not_found:
    'This item is no longer on the tab. Somebody else may have removed it. Refresh the table.',
  invalid_quantity: 'That quantity was not accepted. Try again.',
};

/** A reason this build has never heard of. Says plainly that we do not know, and what to do. */
export const AMEND_REFUSAL_UNKNOWN =
  'This was not changed and we do not know why. Refresh the table and check before telling the kitchen.';

/**
 * AMEND_FAILED (502) means the whole transaction rolled back. The reassurance is the load-bearing
 * half: nothing was voided, so there is no half-applied order and no food going unmade.
 */
export const AMEND_FAILED_NOTHING_CHANGED =
  'The change did not save and nothing on the order was altered. Try again, and tell a manager if it keeps failing.';

export const AMEND_NO_SESSION =
  'This terminal is not signed in any more. Re-activate it, then try again.';
