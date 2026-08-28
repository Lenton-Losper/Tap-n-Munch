/**
 * ███ SIGNED BY THE OWNER 2026-08-28. ALL 31 STRINGS. DO NOT EDIT WITHOUT A NEW SIGN-OFF. ███
 *
 * Eighteen were kept as drafted and thirteen were rewritten; the owner reviewed every one against
 * its render site. Reasoning for the load-bearing changes is recorded beside them rather than
 * here, so a tidier meets it at the line they are about to change.
 *
 * ============================================================================================
 * HOW THIS FILE NEARLY SHIPPED UNSIGNED, WHICH IS THE MORE IMPORTANT NOTE
 * ============================================================================================
 *
 * Until today every string here was PROVISIONAL and none carried a `PENDING COPY:` marker. That
 * was a deliberate, defensible choice by its author: a screen of `[[PLACEHOLDER]]` tokens cannot
 * be walked through on a device before service, and two of these strings sit on money and food
 * safety — TABLE_NOT_SENT_WARNING and FLAG_UNROUTED_LABEL — where a placeholder is not merely
 * unhelpful but actively unsafe if it reaches a waiter mid-service.
 *
 * The cost of that choice: the production copy gate is a SOURCE SCANNER for `PENDING COPY:`, so
 * it could not see a single one of these. The mechanism that correctly blocked the availability
 * screen would have passed all 31 straight through, and they were live in front of staff on 2.06
 * through 2.08. Provisional copy that reads as finished is more dangerous than a visible
 * placeholder, because nobody ever discovers it.
 *
 * See issue #370. The fix is a marker the gate can see but a reader cannot, so readable
 * provisional text stops being invisible. Until that lands, adding an unsigned string to this
 * file puts it in front of staff with nothing to catch it.
 */

// ─── Floor grid (screen 1) ────────────────────────────────────────────────────

export const FLOOR_TITLE = 'Floor';
/** {open} and {free} are substituted with counts. */
export const FLOOR_SUBTITLE = '{open} open · {free} free';
export const FLOOR_EMPTY = 'No tables set up yet. Ask a manager to add them.';
export const FLOOR_FREE_HINT = 'Tap to open';
export const FLOOR_STATE_OPEN = 'OPEN';
export const FLOOR_STATE_FREE = 'FREE';
export const FLOOR_OWNER_UNASSIGNED = 'No waiter';
export const FLOOR_OFFLINE_BANNER = 'Not connected. This is the last floor that loaded.';

/**
 * The three derived warning flags. See lib/tabLines.ts deriveTableFlag for what each one means and
 * why they rank in this order. These are the highest-value strings in the file: they are what a
 * waiter reads across a room at a glance.
 */
/**
 * Owner's reasoning at sign-off, recorded so a tidier does not shorten these back:
 *   READY was ambiguous on a floor grid -- ready to order, to pay, or to clear. FOOD UP is what
 *   a kitchen actually shouts. WAITING read as normal; WAITING LONG says something is wrong.
 *   NOT SENT could mean not sent to the customer, so it now says where.
 */
export const FLAG_READY_LABEL = 'FOOD UP';
export const FLAG_WAITING_LABEL = 'WAITING LONG';
export const FLAG_UNROUTED_LABEL = 'NOT SENT TO KITCHEN';

// ─── Table view (screen 2) ────────────────────────────────────────────────────

export const TABLE_ADD_ROUND_BUTTON = 'Add Round';
export const TABLE_BILL_LABEL = 'Bill';
export const TABLE_OUTSTANDING_LABEL = 'Outstanding';
export const TABLE_READY_LABEL = 'Ready';
export const TABLE_LINE_READY_CHIP = 'Ready';
export const TABLE_LINE_WAITING_CHIP = 'Being made';
export const TABLE_LINE_VOIDED_CHIP = 'Voided';
export const TABLE_ORDER_HEADING = 'Order #{number}';
export const TABLE_EMPTY_NO_ORDERS = 'No rounds sent yet. Tap Add Round to start.';

/**
 * Shown when has_lines is FALSE — a tab that predates the waiter flow, or came in over QR. It has
 * a bill but no fulfilment lines, so the screen must claim nothing at all about readiness.
 */
export const TABLE_NO_LINE_TRACKING =
  'This tab was opened by a customer scanning the QR code, so item progress is not tracked. The bill is correct.';

/**
 * SAFETY-CRITICAL. Shown against any line the server reports as unrouted: no station received it,
 * so nobody is cooking it and nobody is going to.
 */
export const TABLE_NOT_SENT_WARNING =
  'This item never reached the kitchen or bar. It is on the bill and nobody is making it. Tell a manager now.';

export const TABLE_LOAD_FAILED = 'Could not load this table.';
export const TABLE_RETRY = 'Retry';

/** Shown after an open that adopted a tab which was already running. This is a success. */
export const TABLE_ADOPTED_NOTICE =
  'This table was already open. You are now serving it.';

/**
 * Shown after an open that took the table from a colleague. {name} is substituted.
 * Never suppress this one — the waiter who lost the table is not being told by anything else.
 */
export const TABLE_HANDED_OVER_NOTICE = 'You have taken this table over from {name}.';

// ─── Add Round (screen 3) ─────────────────────────────────────────────────────

export const ROUND_SEARCH_PLACEHOLDER = 'Search the menu';
export const ROUND_SEARCH_NO_MATCH = 'Nothing on the menu matches that.';

// ─── Venue model ──────────────────────────────────────────────────────────────

export const TAB_LABEL_FLOOR = 'Tables';
export const TAB_LABEL_SALE = 'Sale';
export const TAB_LABEL_ORDERS = 'Orders';
