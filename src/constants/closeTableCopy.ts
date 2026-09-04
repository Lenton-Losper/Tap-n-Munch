/**
 * ███ EVERY STRING IN THIS FILE IS PENDING COPY. NONE OF IT IS WORDING. ███
 *
 * Close Table introduces user-visible text and none of it was mine to write. Each constant below
 * is a `PENDING COPY: <purpose>` string LITERAL describing what the real string has to say, so the
 * screens can be walked on a device while the copy is still owed, and so the scanner that finds
 * unwritten copy can see every one of them.
 *
 * THE LITERALS ARE NOT COMPOSED. No template literal, no concatenation, no interpolation of a
 * constant into another string anywhere in this file or at any call site. A scanner cannot see
 * through `${...}`, and a placeholder it cannot see is a placeholder that ships.
 *
 * Nothing here is approved, brand-checked, or safe to show a customer. Every entry is listed in
 * the handover for rewriting.
 */

import {CloseTableRefusalId} from '../lib/closeTableRefusals';

// ─── The control ─────────────────────────────────────────────────────────────

export const CLOSE_TABLE_BUTTON = 'Close table';

export const CLOSE_TABLE_CHECKING = 'Checking…';

export const CLOSE_TABLE_IN_PROGRESS = 'Closing…';

// ─── The confirmation, shown only when nothing refuses ───────────────────────

export const CLOSE_CONFIRM_TITLE = 'Close this table?';

export const CLOSE_CONFIRM_BODY = 'This ends the session and frees the table. It does not take payment, and you cannot undo it from the floor.';

/**
 * SHOWN INSTEAD OF CLOSE_CONFIRM_BODY when the tab has no line tracking — a QR-opened or
 * pre-migration tab whose bill is settled.
 *
 * Owner's ruling 2026-08-28: such a table may now be closed when nothing is owed, because money is
 * knowable on a QR tab even when fulfilment is not. But rules 9 and 10 cannot fire on it, so
 * NOBODY has checked whether food is still coming. The waiter is taking on a responsibility the
 * system cannot take for them, and this sentence is the only place they are told so.
 *
 * It has to carry both halves: the bill is settled, AND line progress could not be checked.
 * Dropping the second as duplicative of the ordinary body removes the entire safeguard.
 */
export const CLOSE_CONFIRM_BODY_NO_LINE_TRACKING = 'The bill is settled, so this table can be closed. This tab does not track items, so nobody has checked whether food is still coming — make sure the table is done before you close it.';

export const CLOSE_CONFIRM_ACTION = 'Yes, close it';

export const CLOSE_CONFIRM_CANCEL = 'Keep it open';

// ─── The refusal sheet ───────────────────────────────────────────────────────

export const CLOSE_REFUSED_TITLE = 'Not ready to close';

export const CLOSE_REFUSED_BODY = 'Sort these first:';

export const CLOSE_REFUSED_DISMISS = 'Not yet';

// ─── Failures the server, not the device, decides ────────────────────────────

export const CLOSE_FAILED_GENERIC = 'The table was not closed and nothing has changed. Try again, and tell a manager if it keeps failing.';

export const CLOSE_FAILED_PENDING_REQUESTS = 'Rounds a customer sent are still waiting to be accepted or declined. Deal with those first, then close the table.';

// ─── One reason per refusal ──────────────────────────────────────────────────

/**
 * EXHAUSTIVE BY TYPE. Adding a CloseTableRefusalId without adding its reason here stops the build,
 * which is deliberate: a refusal with no reason shown is a table that refuses to close and never
 * says why.
 */
export const CLOSE_TABLE_REFUSAL_COPY: Record<CloseTableRefusalId, string> = {
  TABLE_UNKNOWN:
    'This table could not be read, so nobody can tell what is owed. Refresh and try again.',
  LINES_UNKNOWN:
    'The food for this table could not be read, so nobody can tell what is still coming. Refresh and try again.',
  TAB_STATUS_UNKNOWN:
    'The server did not say what state this tab is in. Refresh, and tell a manager if it stays this way.',
  SERVER_REFUSES:
    'The server will not close this table and did not say why. Refresh, and tell a manager if it stays this way.',
  UNPAID_BALANCE:
    'There is still money owed on this table. Take payment first.',
  ORDER_OWES_MONEY:
    'An order on this table has not been paid for. Take payment first.',
  CARD_PAYMENT_IN_FLIGHT:
    'A card payment is on the reader right now. Wait for it to finish.',
  CARD_PAYMENT_STUCK:
    'A card payment has been running too long and nobody knows yet whether it went through. The card may have been charged. Check the card machine before closing.',
  OUTSTANDING_LINE:
    'Something on this table is still being made. Wait for it, or void it.',
  UNROUTED_LINE:
    'Something on this table never reached the kitchen or bar. It is on the bill and nobody is making it. Tell a manager now.',
  LINE_TRACKING_UNAVAILABLE:
    'There is still money owed on this table, and this tab does not track items. Take payment first.',
  UNSENT_ROUND_ON_DEVICE:
    'This terminal is holding a round you have not sent. Send it or clear it before closing, or it will be lost.',
};

// ─── The refusal sheet, reworked (Ship 2b) ───────────────────────────────────

/**
 * SIGNED BY THE OWNER 2026-09-04. Twelve strings.
 *
 * ============================================================================================
 * WHAT WAS WRONG WITH THE SHEET, AND WHY THE FIX IS PRESENTATION AND NOT WORDING
 * ============================================================================================
 *
 * The twelve refusal strings in CLOSE_TABLE_REFUSAL_COPY above are DELIBERATELY UNCHANGED. They
 * are already plain and already say what to do; rewriting signed copy that was not the problem
 * would be churn. What was wrong was how they were shown:
 *
 *   - every row rendered in Colors.red on Colors.redLight, whatever it said. A table that could
 *     not be read and a card that may have been charged looked identical, which is how staff learn
 *     to ignore red.
 *   - the list sat in a fixed-height ScrollView, so the third reason was below the fold on a P5.
 *   - the dismiss button said "Close" -- on the dialog for closing a table. It dismissed.
 *
 * This is the screen a waiter reads when a customer has walked out and the room is watching. It
 * has to read calm.
 *
 * ============================================================================================
 * THE OVERRIDE IS OFFERED FOR MONEY OWED AND NOTHING ELSE
 * ============================================================================================
 *
 * Owner's ruling: the blockers differ in kind. "Still being made" is something a waiter fixes by
 * waiting or voiding, and offering a manager PIN there teaches staff to reach for the override
 * reflexively -- which is exactly how an override stops being a control.
 *
 * Only UNPAID_BALANCE, ORDER_OWES_MONEY and LINE_TRACKING_UNAVAILABLE are money, and the offer
 * appears only when the money blockers are the ONLY ones left.
 *
 * WALKOUT_OFFER_BODY NAMES THE AMOUNT BEFORE THE PIN. A manager authorising a write-off should see
 * the number while deciding, not after.
 */
export const CLOSE_REFUSED_MORE = 'and {count} more';

export const WALKOUT_OFFER_TITLE = 'Customer left without paying?';
export const WALKOUT_OFFER_BODY =
  'A manager can close this table. {amount} will be recorded as unpaid.';
export const WALKOUT_PICK_MANAGER = 'Who is authorising this?';
export const WALKOUT_PIN_PROMPT = "{name}'s PIN";
export const WALKOUT_REASON_PROMPT = 'Why is this being closed unpaid?';
export const WALKOUT_CONFIRM = 'Close and record';
export const WALKOUT_REFUSED_PIN =
  'That PIN cannot authorise this. A manager or owner must do it.';
/**
 * REACHABLE, THOUGH NOT TODAY -- checked against production 2026-09-04.
 *
 * All 11 venues have at least one manager or owner (Riviera 7, FNB ChowNow 4, Mingle 4, Digi
 * Cofee 2, the rest 1 each), all 22 manager/owner role rows carry tabs:close_unpaid, and no senior
 * has an unaccepted invite. So the state does not exist right now.
 *
 * It stays reachable three ways: someone unticks the permission on the staff page
 * (restaurant_roles is editable); a `staff_permissions` DENY row strips it per-user (the table
 * exists and authorize() applies deny-removes, though all 3 live rows today are 'allow'); or a
 * venue's only senior is soft-deleted. It tells the reader how to fix it rather than only that it
 * is broken, because the person reading it will be the one who has to.
 */
export const WALKOUT_NO_MANAGERS =
  'Nobody at this venue can authorise a walkout. Ask the owner to grant it on the staff page.';
