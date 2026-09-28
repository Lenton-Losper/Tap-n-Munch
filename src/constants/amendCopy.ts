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
 *
 * CHANGED Sprint 2026-09-28 brief (Riviera #160). The old string ended "Tell them yourself if it
 * has to come off." That invited a VERBAL cancel nothing records: the kitchen may stop, but the
 * item stays on the bill, and the next person to read the table believes whichever story they
 * heard. The line was also not pressable, so a waiter who tapped a cooked item got no answer at
 * all. The sheet now opens for it and says the two facts that matter: it cannot be cancelled from
 * here, and NOTHING has been removed.
 */
export const AMEND_WINDOW_CLOSED =
  'Already cooked — this cannot be cancelled from here. Nothing has been removed: it is still on the order and still on the bill. A manager decides what happens to it.';

/** A line the server already shows as cancelled. Tappable, so it answers rather than ignoring. */
export const AMEND_ALREADY_VOIDED =
  'This item has already been cancelled. There is nothing to change here.';

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
  // Sprint 2026-09-28: every refusal now says NOT removed and still on the bill, in those words.
  window_closed: 'Already cooked — NOT removed. It is being made and it is still on the bill.',
  not_found:
    'This item was not found on the tab, so nothing was removed by you. Somebody else may have cancelled it — check the table.',
  invalid_quantity:
    'That quantity was not accepted — NOT changed. It is still on the bill as it was.',
  order_paid: 'This order is already paid — NOT removed. It is still on the bill.',
  line_settled: 'This item has already been paid for — NOT removed. It is still on the bill.',
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

// ================================================================================================
// SERVER-CONFIRMED OUTCOMES. Sprint 2026-09-28 brief (Riviera #160).
// ================================================================================================
//
// Success used to be signalled by the sheet CLOSING — indistinguishable from "Leave it as it is",
// the back button, or leaving mid-PIN. Each outcome is now a sentence the waiter reads, and the
// confirmed ones exist only when the line's id came back in `applied`.
//
// AMEND_FAILED (502) is no longer shown as AMEND_FAILED_NOTHING_CHANGED. The terminal cannot tell
// a 502 the server sent after rolling back from one a proxy sent after the server committed, so
// every non-2xx that is not a named approval refusal now reads as NOT CONFIRMED.

/** Confirmed removal, with the money. `{name}` `{amount}`. */
export const AMEND_CONFIRMED_REMOVED = '{name} removed — {amount} off the bill.';
/** Confirmed removal, when the server sent no price for the line. */
export const AMEND_CONFIRMED_REMOVED_NO_AMOUNT = '{name} removed — it is off the bill.';
/** Confirmed reduction. `{name}` `{quantity}` `{amount}`. */
export const AMEND_CONFIRMED_REDUCED = '{name} reduced to {quantity} — {amount} off the bill.';
export const AMEND_CONFIRMED_REDUCED_NO_AMOUNT = '{name} reduced to {quantity}.';
/** Confirmed increase. Adds to the bill; not a warning. */
export const AMEND_CONFIRMED_INCREASED = '{name} is now {quantity}. The kitchen has the change.';

/** Above a refusal. Names the item so the waiter knows which one stayed. */
export const AMEND_REFUSED_TITLE = '{name} was NOT removed';

/**
 * EVERYTHING ELSE: a timeout, no network, a 5xx, a 200 that could not be read, or a 200 that did
 * not mention this line. The server may or may not have done it, so the waiter must not tell the
 * customer either way until the table shows it. The table is re-read the moment this appears.
 */
export const AMEND_NOT_CONFIRMED_TITLE = 'Cancellation NOT confirmed — check the table';
export const AMEND_NOT_CONFIRMED_BODY =
  'We did not get a clear answer from the server, so this may or may not have come off. Do not tell the customer it is off until the table shows it. The table is being refreshed now.';
/** The same, for an increase. */
export const AMEND_CHANGE_NOT_CONFIRMED_TITLE = 'Change NOT confirmed — check the table';

/** The manager PIN could not be checked (no network or timeout). The amend was never sent. */
export const AMEND_AUTHORIZE_UNREACHABLE =
  'Could not check the PIN, so nothing came off the bill. Try again.';
/** 403 from /authorize: not a member, no permission, or no PIN set. */
export const AMEND_AUTHORIZE_DENIED =
  'This person cannot approve taking items off a bill here, so nothing came off. Pick a manager or owner.';

/** On the busy button, so the waiter knows not to walk away mid-request. */
export const AMEND_WAIT = 'Waiting for the server…';

export const AMEND_NO_SESSION =
  'This terminal is not signed in any more. Re-activate it, then try again.';
