/**
 * #265 — staff-facing copy for tab PIN recovery.
 *
 * EVERY STRING BELOW IS **PENDING COPY**. It is placeholder wording written to be replaced, not
 * signed text. The owner signs in the morning; each constant carries a comment saying what it must
 * CONVEY, which is the part that is ruled on. Do not treat the current words as approved, and do
 * not quietly promote them by deleting the PENDING COPY marker.
 *
 * THE ONE RULE THAT IS NOT EDITORIAL: staff never see a PIN. `reset-pin` mints a single-use token
 * and deliberately never touches `tab_pin`; the new PIN is minted at redemption and returned only
 * to the customer's own device. No string here may ever display, promise, or imply a PIN that staff
 * can read out — see #265 ruling Q1:A. That is a hard requirement, not wording.
 */

/**
 * PENDING COPY — the button on the tab view.
 *
 * MUST CONVEY: staff are giving this customer a way back onto their tab. It must NOT say "reset
 * PIN": staff never see a PIN, and "reset" suggests they are changing something the customer
 * already knows, which invites them to read the new one out. Frame it as helping someone rejoin.
 */
export const TAB_RECOVERY_ACTION_LABEL = 'Help a guest rejoin';

/**
 * PENDING COPY — the title of the sheet holding the QR.
 *
 * MUST CONVEY: this code is for the CUSTOMER, not for staff to act on.
 */
export const TAB_RECOVERY_TITLE = 'Scan to rejoin this tab';

/**
 * PENDING COPY — the instruction under the QR.
 *
 * MUST CONVEY three facts, all of them operationally load-bearing:
 *   1. the CUSTOMER scans it, on their own phone;
 *   2. it EXPIRES shortly — the token's TTL is 15 minutes;
 *   3. it works ONCE, so a second person cannot reuse the same code.
 */
export const TAB_RECOVERY_INSTRUCTION =
  'Ask the guest to scan this with their phone camera. It expires in about 15 minutes and can only be used once.';

/**
 * PENDING COPY — shown while the request is in flight.
 */
export const TAB_RECOVERY_IN_PROGRESS = 'Creating code...';

/**
 * PENDING COPY — the failure message.
 *
 * MUST CONVEY: the reset could not be STARTED, and whether retrying helps. Retrying does help here
 * — nothing was created, so there is no half-finished state to worry about and no risk in trying
 * again. It must not imply the customer's tab or PIN was altered, because it was not.
 */
export const TAB_RECOVERY_FAILED =
  'Could not create a rejoin code. Nothing was changed. Try again.';

/**
 * PENDING COPY — refusal when this terminal lacks the permission.
 *
 * MUST CONVEY: this device may not do it, and who can — a manager. Not a fault the operator can fix
 * by retrying, so it must not invite one.
 */
export const TAB_RECOVERY_NOT_PERMITTED =
  'This terminal cannot create rejoin codes. Ask a manager.';

/** PENDING COPY — dismisses the sheet. */
export const TAB_RECOVERY_DONE_LABEL = 'Done';
