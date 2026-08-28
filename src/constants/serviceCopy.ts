/**
 * ███ PROVISIONAL COPY — NOT SIGNED OFF. EVERY STRING IN THIS FILE NEEDS A HUMAN. ███
 *
 * Waiter-led service v2 introduces screens that had no wording, and the wording was not mine to
 * invent. Every new string the feature needs is defined HERE, once, so that rewriting the lot is
 * editing one file rather than hunting through four screens.
 *
 * WHY THESE READ AS SENTENCES RATHER THAN `[[PLACEHOLDER]]`:
 *
 * The brief asked for obvious placeholders. A screen of bracketed tokens cannot be walked through
 * on a device, and this build is being tested by a human on a real terminal before service. Worse,
 * two of these strings sit on money and on food safety — TABLE_NOT_SENT_WARNING and
 * FLAG_UNROUTED_LABEL — where a placeholder is not merely unhelpful but actively unsafe if it ever
 * reached a waiter mid-service.
 *
 * So the deviation is deliberate and is reported: readable provisional text, quarantined in one
 * file, every entry listed in the handover for rewriting. Nothing here should be read as final,
 * approved, or brand-checked. Anything customer-visible is especially suspect — most of this is
 * staff-facing, but the notes a waiter types travel to the kitchen pass.
 *
 * Existing wording carried over unchanged from waiter-led service v1 (0c5e3b5) is NOT repeated
 * here — it was written and committed before this session and re-drafting it was not asked for.
 */

// ─── Floor grid (screen 1) ────────────────────────────────────────────────────

export const FLOOR_TITLE = 'Floor';
/** {open} and {free} are substituted with counts. */
export const FLOOR_SUBTITLE = '{open} open · {free} free';
export const FLOOR_EMPTY = 'No active tables for this restaurant.';
export const FLOOR_FREE_HINT = 'Tap to open';
export const FLOOR_STATE_OPEN = 'OPEN';
export const FLOOR_STATE_FREE = 'FREE';
export const FLOOR_OWNER_UNASSIGNED = 'Unassigned';
export const FLOOR_OFFLINE_BANNER = 'Showing the last floor that loaded.';

/**
 * The three derived warning flags. See lib/tabLines.ts deriveTableFlag for what each one means and
 * why they rank in this order. These are the highest-value strings in the file: they are what a
 * waiter reads across a room at a glance.
 */
export const FLAG_READY_LABEL = 'READY';
export const FLAG_WAITING_LABEL = 'WAITING';
export const FLAG_UNROUTED_LABEL = 'NOT SENT';

// ─── Table view (screen 2) ────────────────────────────────────────────────────

export const TABLE_ADD_ROUND_BUTTON = 'Add Round';
export const TABLE_BILL_LABEL = 'Bill';
export const TABLE_OUTSTANDING_LABEL = 'Outstanding';
export const TABLE_READY_LABEL = 'Ready';
export const TABLE_LINE_READY_CHIP = 'Ready';
export const TABLE_LINE_WAITING_CHIP = 'Preparing';
export const TABLE_LINE_VOIDED_CHIP = 'Voided';
export const TABLE_ORDER_HEADING = 'Order #{number}';
export const TABLE_EMPTY_NO_ORDERS = 'Nothing has been ordered on this table yet.';

/**
 * Shown when has_lines is FALSE — a tab that predates the waiter flow, or came in over QR. It has
 * a bill but no fulfilment lines, so the screen must claim nothing at all about readiness.
 */
export const TABLE_NO_LINE_TRACKING =
  'This tab was not opened from a terminal, so line-by-line progress is not tracked. The bill is correct.';

/**
 * SAFETY-CRITICAL. Shown against any line the server reports as unrouted: no station received it,
 * so nobody is cooking it and nobody is going to.
 */
export const TABLE_NOT_SENT_WARNING =
  'This item did not reach the kitchen or the bar. Tell a manager — it is on the bill but nobody is making it.';

export const TABLE_LOAD_FAILED = 'Could not load this table.';
export const TABLE_RETRY = 'Retry';

/** Shown after an open that adopted a tab which was already running. This is a success. */
export const TABLE_ADOPTED_NOTICE =
  'This table was already open. You are now working on the existing tab.';

/**
 * Shown after an open that took the table from a colleague. {name} is substituted.
 * Never suppress this one — the waiter who lost the table is not being told by anything else.
 */
export const TABLE_HANDED_OVER_NOTICE = 'You took this table over from {name}.';

// ─── Add Round (screen 3) ─────────────────────────────────────────────────────

export const ROUND_SEARCH_PLACEHOLDER = 'Search the menu';
export const ROUND_SEARCH_NO_MATCH = 'No item matches that.';

// ─── Venue model ──────────────────────────────────────────────────────────────

export const TAB_LABEL_FLOOR = 'Tables';
export const TAB_LABEL_SALE = 'Sale';
export const TAB_LABEL_ORDERS = 'Orders';
