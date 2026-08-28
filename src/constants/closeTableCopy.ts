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

export const CLOSE_REFUSED_TITLE = 'This table cannot be closed yet';

export const CLOSE_REFUSED_BODY = 'Deal with each of these first, then close it.';

export const CLOSE_REFUSED_DISMISS = 'Close';

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
