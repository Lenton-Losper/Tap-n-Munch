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
 * Optional, not required -- a busy service must not be blocked on typing a name. Left blank, the
 * tab carries no customer_name and the floor grid and table screen fall back to showing the
 * waiter alone, same as they did before this field existed.
 */
export const OPEN_TABLE_CUSTOMER_NAME_LABEL = 'Customer name (optional)';
export const OPEN_TABLE_CUSTOMER_NAME_PLACEHOLDER = 'e.g. Smith party';

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

/**
 * SIGNED BY THE OWNER 2026-09-01. Three strings, added under a new sign-off.
 *
 * COLLECTED. Food that has been taken off the pass. Before this it borrowed the Ready chip,
 * because adding a word to this file needed an approval that had not been given; the ruling gives
 * it. "Collected" is the word the schema uses and the word the floor uses for the same act.
 *
 * PARTIAL PROGRESS. A line routed to BOTH stations where exactly one has finished. It used to
 * read "Being made", which is true and useless: on 2026-09-01 at Digi Cofee a 4x Coffee sat that
 * way while the bar had already poured it and the kitchen had never started, and nobody could see
 * which half was missing. The device was holding both station states and rendering neither.
 *
 * The station named is the one still WORKING, because that is the actionable half — the waiter
 * needs to know who to chase, not who to thank.
 */
export const TABLE_LINE_COLLECTED_CHIP = 'Collected';
export const TABLE_LINE_KITCHEN_READY_BAR_WAITING = 'Kitchen ready · Bar waiting';
export const TABLE_LINE_BAR_READY_KITCHEN_WAITING = 'Bar ready · Kitchen waiting';

/**
 * SIGNED BY THE OWNER 2026-09-03. Seven strings, in two groups, pinned as written.
 *
 * COOKED PROGRESS. The terminal has had no representation of `cooked` at all: a plated dish and
 * one nobody has started look identical on the table view. Waiters asked for it.
 *
 * Deliberately a COUNT and not a chip-only state. A COOKING chip is another word for not-ready,
 * and staff learn to ignore a label that never changes what they do; "Kitchen 2 of 5 plated" is
 * progress somebody can act on. Split by station because three of four food items plated while the
 * drinks have not been started is different information from three of four overall.
 *
 * PLATED and POURED rather than one shared "cooked": the kitchen plates and the bar pours, and the
 * station-specific verb is what staff already say. Both mean the same underlying state.
 *
 * NEARLY READY for the per-line chip, not "Cooked". A waiter does not act on cooked — the pass has
 * not passed it — so the chip says how close it is rather than naming an internal state. It ranks
 * below Ready, which is the point: it must not read as "come and collect this".
 *
 * HALF-VOIDED. An amend voids only the stations that have not finished, so a both-routed line can
 * come back with the kitchen cancelled and the bar ready. That rendered "Bar ready · Kitchen
 * waiting" — telling a waiter to expect food that had been cancelled, which is how somebody ends
 * up waiting and then arguing with the kitchen. CANCELLED is the customer-facing word for it;
 * "voided" is the schema's word and the existing chip already uses it for a wholly cancelled line,
 * so these say cancelled to make the partial case read as a different thing rather than a variant
 * of the same one.
 *
 * The station named FIRST is the one carrying the actionable fact, matching the existing partial
 * strings above: what is ready, or what is not coming.
 */
export const TABLE_LINE_COOKED_CHIP = 'Nearly ready';
export const TABLE_COOKED_PROGRESS_KITCHEN = 'Kitchen {cooked} of {total} plated';
export const TABLE_COOKED_PROGRESS_BAR = 'Bar {cooked} of {total} poured';
export const TABLE_LINE_KITCHEN_CANCELLED_BAR_READY = 'Bar ready · Kitchen cancelled';
export const TABLE_LINE_BAR_CANCELLED_KITCHEN_READY = 'Kitchen ready · Bar cancelled';
export const TABLE_LINE_KITCHEN_CANCELLED = 'Kitchen cancelled · Bar still coming';
export const TABLE_LINE_BAR_CANCELLED = 'Bar cancelled · Kitchen still coming';

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

// ─── Split payment (Ship 1) — RETIRED ─────────────────────────────────────────

/*
 * THE THIRTEEN SPLIT STRINGS ARE GONE, WITH THE TWO SCREENS THEY WERE WRITTEN FOR.
 *
 * Signed 2026-09-03/04 and retired 2026-09-04 in the same week, on the owner's ruling: Take
 * Payment already had the right interaction, and the split screens were a second way to do the
 * same thing reached from a different button. What replaced them is the item list on Take
 * Payment -- see lib/takePaymentLines and constants/takePaymentCopy.
 *
 * The SERVER side is untouched and still live: order_line_allocations, the allocate route and the
 * settle-allocations route. Take Payment settles through them for any part-order payment, so a
 * split already taken is unaffected and its money is where it was.
 *
 * Recorded here rather than deleted silently, because these strings were signed. If a split UI
 * ever returns, the wording and the reasoning behind every word of it are in git at 2.23
 * (versionCode 124).
 */

/**
 * SIGNED BY THE OWNER 2026-09-04. Two strings, on the round screen's basket row.
 *
 * THE PROBLEM THEY SOLVE. The basket already supports per-unit notes: addLine refuses to merge
 * into a line that carries one, so "tap, note, tap" produces two separately-noted lines, and
 * splitLine peels a unit off an existing one. It fails in exactly one order of operations --
 * tap, tap, note -- where the note lands on a quantity-2 line and silently applies to both.
 *
 * The Split control existed for this and sat between "+" and the bin, where it reads as a
 * quantity button. The owner hit the trap on a first attempt, which is the evidence that its
 * placement did not communicate what it was for. It now sits beside the note field, and the
 * warning appears at the moment a note is typed on a multi-unit line.
 *
 * ROUND_NOTE_APPLIES_TO_ALL states the CONSEQUENCE, not the rule: what the kitchen will receive,
 * which is the thing the waiter is about to get wrong. "{count}" is the line quantity.
 *
 * ROUND_SPLIT_ONE_OFF says what the button does to the basket rather than naming the operation.
 * "Split" alone was accurate and meant nothing at the moment it mattered.
 */
export const ROUND_NOTE_APPLIES_TO_ALL = 'This note goes to the kitchen for all {count}.';
export const ROUND_SPLIT_ONE_OFF = 'Split one off';
