/**
 * Settlement state of ONE TAB, as the waiter's table view needs to show it.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. The waiter table view is built on
 * `GET /api/terminal/tabs/{tabId}/lines`, and that payload carries NO payment information at
 * all — it is the fulfilment feed (see app/api/terminal/tabs/[tabId]/lines/route.ts, whose
 * order select is `id, order_number, placed_at, order_instructions, total`). So the screen that
 * shows the bill has, until now, had no way to know whether any of that bill has been paid.
 * The money answer comes from `GET /api/terminal/tables`, which is where `payment_status`,
 * `can_settle_card`, `can_settle_cash` and `unpaid_total` actually live.
 *
 * Everything here is pure and free of React, so the rule that decides what a waiter believes
 * about a table's money is pinned by tests rather than by reading a screen.
 *
 * THREE THINGS THIS MODULE WILL NOT DO:
 *
 *   1. It never sums money. `amountOwed` returns the SERVER's `unpaid_total` and nothing else.
 *      A client-side sum of order totals disagrees with the bill the customer is shown the
 *      moment a void, a discount or a service charge exists — and this figure is what a waiter
 *      is about to charge a card for.
 *
 *   2. It never re-derives settleability. `can_settle_card` / `can_settle_cash` are the
 *      SERVER's per-order affordances; the status sets that produce them live server-side and a
 *      second copy here is exactly how the two drift apart.
 *
 *   3. It never treats PAID as CLOSED. They are different states with different causes, and
 *      keeping them apart is the whole point of `TabSettlementState`. A tab whose every order is
 *      paid is `fully_paid` and STILL OPEN — the party can keep ordering, and only
 *      `POST /api/terminal/tables/{tableId}/close` ends the session.
 */
import {owesMoney} from './paymentIntegrity';
import type {TabOrder, TableWithTab} from '../types';

/**
 * Tab statuses in which the session is still LIVE and money may still be taken.
 *
 * `close_table_session` writes status='settled' with settled_at/settled_type set (see
 * lib/tabs/settle-tab-state.ts in the web repo, which documents exactly that). Settling money
 * does the opposite: it calls clearReadyToPayAndReopenTab(reason: 'money_taken'), which REOPENS
 * the tab and is guarded on `settled_at IS NULL`. So 'settled' is the closed marker, and paying
 * never produces it.
 */
export const OPEN_TAB_STATUSES = ['open', 'ready_to_pay'] as const;

export type TabSettlementState =
  /** No tab on this table at all — nothing to settle. */
  | 'no_tab'
  /** The session was deliberately ended by Close Table. NOT a consequence of paying. */
  | 'closed'
  /** Live tab, money owed, nothing collected yet. */
  | 'unpaid'
  /** Live tab, some orders paid, money still owed. The split-bill state. */
  | 'partially_paid'
  /** Live tab, nothing owed — AND STILL OPEN. Paid is not closed. */
  | 'fully_paid'
  /**
   * Live tab, nothing owed AND nothing ever billed — every order on it was cancelled.
   *
   * NOT a shade of 'fully_paid'. Zero owed because everything was cancelled is a different fact
   * from zero owed because everything was paid, and conflating them told a waiter at Digi Cofee
   * that a NAD 19 tab was settled when no money had ever changed hands.
   */
  | 'nothing_billed'
  /**
   * The money payload could not be read. Deliberately its own state rather than being folded
   * into 'unpaid': "we do not know" is not a shade of "nobody has paid", and rendering it as one
   * invites a waiter to charge a card for a bill that may already be settled.
   */
  | 'unknown';

function isOpenTabStatus(status: unknown): boolean {
  const normalised = String(status ?? '')
    .trim()
    .toLowerCase();
  return (OPEN_TAB_STATUSES as readonly string[]).includes(normalised);
}

function isPaidOrder(order: TabOrder): boolean {
  return (
    String(order.payment_status ?? '')
      .trim()
      .toLowerCase() === 'paid'
  );
}

/**
 * Which of the five states this table is in.
 *
 * `null` means the money payload is missing or could not be loaded, and answers 'unknown'.
 *
 * FAILS CLOSED ON AN UNRECOGNISED TAB STATUS. A status this build does not know is not assumed
 * to be live; it is reported as 'closed', which withdraws the settle control rather than
 * offering to charge against a tab whose state this device cannot account for. A server that
 * later adds a new live status makes the button go missing — visible, and recoverable by an
 * APK. The opposite failure takes money.
 */
export function deriveTabSettlementState(
  table: TableWithTab | null | undefined,
): TabSettlementState {
  if (!table) {
    return 'unknown';
  }
  if (!table.tab) {
    return 'no_tab';
  }
  if (!isOpenTabStatus(table.tab.status)) {
    return 'closed';
  }

  const orders = table.tab.orders ?? [];

  /**
   * ==========================================================================================
   * ZERO OWED IS NOT THE SAME FACT AS FULLY PAID.
   * ==========================================================================================
   *
   * `owing.length === 0` used to return `fully_paid` on its own. A tab whose orders were all
   * CANCELLED has nothing owing and nothing paid, so it rendered as PAID IN FULL over a table
   * where no money had ever changed hands.
   *
   * That happened on production: Digi Cofee Table 1, 2026-08-28. The stale-payment sweep
   * cancelled orders #30, #31 and #32 (NAD 3 + 5 + 11) two to three minutes after each was
   * placed. `paid_at` was null on all three, the kitchen had already cooked the food, and the
   * screen told the waiter the bill was settled. A waiter reading "paid in full" closes the
   * table, and the venue loses the money.
   *
   * PREFER THE SERVER'S COUNTS. `paid_order_count` / `unpaid_order_count` /
   * `billable_order_count` are computed where the payment vocabulary actually lives, so the
   * device is not maintaining a second opinion about what "paid" means. The local scan below is
   * the fallback for a server that does not send them yet — an APK reaches a venue before the
   * worker does, and the reverse, so both halves have to stand alone.
   */
  const serverPaid = table.tab.paid_order_count;
  const serverUnpaid = table.tab.unpaid_order_count;
  const serverBillable = table.tab.billable_order_count;

  const hasServerCounts =
    typeof serverPaid === 'number' &&
    typeof serverUnpaid === 'number' &&
    typeof serverBillable === 'number';

  const owingCount = hasServerCounts
    ? (serverUnpaid as number)
    : orders.filter(order => owesMoney(order.payment_status)).length;
  const paidCount = hasServerCounts
    ? (serverPaid as number)
    : orders.filter(isPaidOrder).length;
  const billableCount = hasServerCounts
    ? (serverBillable as number)
    : owingCount + paidCount;

  if (owingCount === 0) {
    /**
     * Nothing owed AND nothing ever billed. Not paid — there was never anything to pay. Kept as
     * its own state rather than folded into `unpaid` so the screen can never be tempted to call
     * it settled, and so a reader of this function meets the distinction rather than a bare
     * `paidCount > 0` test they might simplify away.
     */
    if (paidCount === 0 || billableCount === 0) {
      return 'nothing_billed';
    }
    return 'fully_paid';
  }
  return paidCount > 0 ? 'partially_paid' : 'unpaid';
}

/**
 * Whether a settle control should be offered at all.
 *
 * Only the two states where money is genuinely outstanding on a live tab. 'fully_paid' is
 * excluded because there is nothing left to charge — not because the tab is over.
 */
export function canOfferSettle(state: TabSettlementState): boolean {
  return state === 'unpaid' || state === 'partially_paid';
}

/**
 * THE AMOUNT OWED, taken from the server's `unpaid_total` and from nowhere else.
 *
 * Returns null rather than 0 when the figure is absent or unreadable. Zero is a claim that
 * nothing is owed; the absence of a figure is not, and rendering one as the other is how a
 * waiter comes to believe a table has paid.
 */
export function amountOwed(table: TableWithTab | null | undefined): number | null {
  const value = Number(table?.tab?.unpaid_total);
  return Number.isFinite(value) ? value : null;
}

/**
 * Orders the SERVER says may still be settled, card or cash.
 *
 * Read straight off the per-order affordances the tables route computes. Orders from a server
 * that predates those fields (both undefined) are excluded: an absent affordance is not
 * permission, and this list only ever decides what to OFFER — the settle itself is gated again
 * by the server, which owns the decision.
 */
export function settleableOrderIds(
  table: TableWithTab | null | undefined,
): string[] {
  return (table?.tab?.orders ?? [])
    .filter(order => order.can_settle_card === true || order.can_settle_cash === true)
    .map(order => String(order.id));
}
