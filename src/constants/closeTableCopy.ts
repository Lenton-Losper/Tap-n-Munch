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

export const CLOSE_TABLE_BUTTON =
  'PENDING COPY: the button on the waiter table view that ends the session for this table';

export const CLOSE_TABLE_CHECKING =
  'PENDING COPY: shown on the button while the device re-reads the table to decide whether closing is allowed';

export const CLOSE_TABLE_IN_PROGRESS =
  'PENDING COPY: shown on the button while the close request is in flight';

// ─── The confirmation, shown only when nothing refuses ───────────────────────

export const CLOSE_CONFIRM_TITLE =
  'PENDING COPY: title of the sheet that asks the waiter to confirm ending the session for this table';

export const CLOSE_CONFIRM_BODY =
  'PENDING COPY: body of the confirm sheet — closing ends the session and frees the table, it is not the same as taking payment, and it cannot be undone from the floor';

export const CLOSE_CONFIRM_ACTION =
  'PENDING COPY: the button that confirms the close';

export const CLOSE_CONFIRM_CANCEL =
  'PENDING COPY: the button that backs out of the confirm sheet without closing';

// ─── The refusal sheet ───────────────────────────────────────────────────────

export const CLOSE_REFUSED_TITLE =
  'PENDING COPY: title of the sheet listing every reason this table cannot be closed yet';

export const CLOSE_REFUSED_BODY =
  'PENDING COPY: line above the reason list explaining that all of these have to be dealt with before the table can be closed';

export const CLOSE_REFUSED_DISMISS =
  'PENDING COPY: the button that dismisses the refusal sheet';

// ─── Failures the server, not the device, decides ────────────────────────────

export const CLOSE_FAILED_GENERIC =
  'PENDING COPY: shown when the close request failed and the server gave no reason this device understands';

export const CLOSE_FAILED_PENDING_REQUESTS =
  'PENDING COPY: shown when the server refused the close because rounds a customer placed are still waiting to be accepted or declined on this table';

// ─── One reason per refusal ──────────────────────────────────────────────────

/**
 * EXHAUSTIVE BY TYPE. Adding a CloseTableRefusalId without adding its reason here stops the build,
 * which is deliberate: a refusal with no reason shown is a table that refuses to close and never
 * says why.
 */
export const CLOSE_TABLE_REFUSAL_COPY: Record<CloseTableRefusalId, string> = {
  TABLE_UNKNOWN:
    'PENDING COPY: refusal reason — the device could not read this table, so it cannot tell whether anything is still owed',
  LINES_UNKNOWN:
    'PENDING COPY: refusal reason — the device could not read this table s food, so it cannot tell whether anything is still being made',
  TAB_STATUS_UNKNOWN:
    'PENDING COPY: refusal reason — the server did not say what state this tab is in',
  SERVER_REFUSES:
    'PENDING COPY: refusal reason — the server says this table is not closeable yet',
  UNPAID_BALANCE:
    'PENDING COPY: refusal reason — there is still money owed on this table',
  ORDER_OWES_MONEY:
    'PENDING COPY: refusal reason — at least one order on this table has not been paid for',
  CARD_PAYMENT_IN_FLIGHT:
    'PENDING COPY: refusal reason — a card payment for this table is on the reader right now',
  CARD_PAYMENT_STUCK:
    'PENDING COPY: refusal reason — a card payment for this table has been running longer than allowed and nobody knows yet whether it went through',
  OUTSTANDING_LINE:
    'PENDING COPY: refusal reason — something ordered on this table is still being prepared',
  UNROUTED_LINE:
    'PENDING COPY: refusal reason — something ordered on this table never reached a station, so nobody is making it',
  LINE_TRACKING_UNAVAILABLE:
    'PENDING COPY: refusal reason — this tab does not track what has been made, so the device cannot tell whether anything is outstanding',
  UNSENT_ROUND_ON_DEVICE:
    'PENDING COPY: refusal reason — this terminal is holding a round for this table that has not been sent yet',
};
