/**
 * TAKE PAYMENT, BY ITEM (Ship 1b) -- the pure half.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * Take Payment already had the right interaction: a list, checkboxes, a running total, and one
 * button. The only thing wrong with it was WHAT IT LISTED -- guests, when a customer at a table
 * pays for THINGS. "Ana's order" means nothing to the three people splitting a bill; "the two
 * steaks and a bottle of red" is what they are actually paying for.
 *
 * So the interaction is untouched and the LIST changes. Everything in this file is the arithmetic
 * and the rules behind that list, free of React and of fetch, so what a waiter is charging is
 * pinned by tests rather than by reading a screen.
 *
 * ============================================================================================
 * THE ONE RULE THAT MATTERS: WHICH MONEY PATH A SELECTION TAKES
 * ============================================================================================
 *
 * There are two settlement routes on the server and they are NOT interchangeable:
 *
 *   WHOLE-ORDER   POST /api/terminal/tabs/{tabId}/settle -- the proven money path. It drives the
 *                 card reader's push/poll flow, has four documented fallbacks when the gateway
 *                 answer is ambiguous, consumes a cash-authorization token, issues receipts and
 *                 writes payment_events.
 *
 *   ALLOCATIONS   POST /api/terminal/tabs/{tabId}/settle-allocations -- item-level. Its own
 *                 header states its scope plainly: it does not use the whole-order route's
 *                 push/poll card flow. It exists so a bill can be split BELOW order granularity,
 *                 which the whole-order route cannot express.
 *
 * A selection that happens to cover whole orders therefore goes down the WHOLE-ORDER path. Routing
 * everything through allocations because the new list is item-shaped would quietly move every card
 * payment at every venue off the flow with the fallbacks, to buy nothing: the customer is paying
 * for entire orders either way, and the two routes settle them identically.
 *
 * `planFor` is where that decision is made, once, and it is the only place allowed to make it.
 *
 * ============================================================================================
 * A LINE WITHOUT A PRICE IS NOT FREE
 * ============================================================================================
 *
 * `total_cents` is optional -- absent from a server that predates item-level splitting, and null
 * for a line whose order the route could not price. Such a line is UNSELECTABLE and says so. It is
 * never treated as zero: a line silently worth nothing is how a table walks out having paid for
 * three of its four dishes.
 */
import type {TabLine, TabLinesPayload} from './tabLines';
import type {TabOrder} from '../types';

/** Payment statuses the whole-order path may still collect on. Mirrors the server's set. */
const CLAIMABLE_PAYMENT_STATUSES = new Set(['unpaid', 'pending']);

export type PayableLine = {
  id: string;
  orderId: string;
  orderNumber: number;
  name: string;
  quantity: number;
  note: string | null;
  /** The line's own money, in integer cents, or null when the server did not price it. */
  totalCents: number | null;
  /** Cents already settled against this line through allocations. */
  settledCents: number;
  /** Cents still to collect on this line. Zero when it is paid for. */
  outstandingCents: number;
  /**
   * Allocation ids on this line that are NOT yet settled. Empty when nobody has split it.
   * These, and never the line id, are what the allocation path settles.
   */
  openAllocationIds: string[];
  /** Already collected in full -- shown, greyed, never selectable. */
  isPaid: boolean;
  /** May be ticked. False for paid, voided, unpriced, and non-claimable lines. */
  selectable: boolean;
  /** Why it cannot be ticked, for the row to render. Null when it can. */
  refusal: PayableLineRefusal | null;
};

export type PayableLineRefusal = 'paid' | 'no_price' | 'order_not_claimable';

/**
 * Every line on the tab that a waiter could be looking at while taking payment, in the order the
 * server sent them. VOIDED LINES ARE DROPPED ENTIRELY -- a voided item is not an item the customer
 * declines to pay for, it is an item that does not exist, and listing it as "N$0.00, paid" would
 * invite someone to reconcile against it.
 */
export function payableLines(
  payload: TabLinesPayload | null,
  orders: readonly TabOrder[],
): PayableLine[] {
  if (!payload) {
    return [];
  }
  const claimableOrderIds = new Set(
    orders
      .filter(order => CLAIMABLE_PAYMENT_STATUSES.has(String(order.payment_status)))
      .map(order => order.id),
  );
  const paidOrderIds = new Set(
    orders.filter(order => order.payment_status === 'paid').map(order => order.id),
  );

  const out: PayableLine[] = [];
  for (const order of payload.orders ?? []) {
    for (const line of order.lines ?? []) {
      if (line.is_voided) {
        continue;
      }
      out.push(describeLine(line, order.order_id, order.order_number, claimableOrderIds, paidOrderIds));
    }
  }
  return out;
}

function describeLine(
  line: TabLine,
  orderId: string,
  orderNumber: number,
  claimableOrderIds: Set<string>,
  paidOrderIds: Set<string>,
): PayableLine {
  const rawTotal = line.total_cents;
  const totalCents =
    typeof rawTotal === 'number' && Number.isFinite(rawTotal) && rawTotal >= 0
      ? Math.round(rawTotal)
      : null;

  const allocations = line.allocations ?? [];
  const settledCents = allocations
    .filter(a => a.settled_at != null)
    .reduce((sum, a) => sum + (Number.isFinite(a.amount_cents) ? a.amount_cents : 0), 0);
  const openAllocationIds = allocations.filter(a => a.settled_at == null).map(a => a.id);

  // The order's own status is the authority on "paid", not the allocation arithmetic: an order
  // settled whole (the ordinary case, and every order that predates splitting) carries no
  // allocations at all, and reading only the ledger would offer it for sale a second time.
  const orderPaid = paidOrderIds.has(orderId);
  const linePaid =
    orderPaid || (totalCents != null && totalCents > 0 && settledCents >= totalCents);

  const outstandingCents =
    totalCents == null ? 0 : linePaid ? 0 : Math.max(0, totalCents - settledCents);

  let refusal: PayableLineRefusal | null = null;
  if (linePaid) {
    refusal = 'paid';
  } else if (totalCents == null) {
    refusal = 'no_price';
  } else if (!claimableOrderIds.has(orderId)) {
    // Cancelled, refunded, or any status the server does not let the terminal collect on.
    refusal = 'order_not_claimable';
  }

  return {
    id: line.id,
    orderId,
    orderNumber,
    name: line.name_snapshot,
    quantity: line.quantity,
    note: line.line_note,
    totalCents,
    settledCents,
    outstandingCents,
    openAllocationIds,
    isPaid: linePaid,
    selectable: refusal == null,
    refusal,
  };
}

/** What the ticked lines add up to, in integer cents. Never a float sum of rands. */
export function selectionTotalCents(
  lines: readonly PayableLine[],
  selectedIds: ReadonlySet<string>,
): number {
  return lines
    .filter(line => selectedIds.has(line.id) && line.selectable)
    .reduce((sum, line) => sum + line.outstandingCents, 0);
}

/** Everything still owed on the tab, by the same arithmetic the rows are drawn from. */
export function outstandingTotalCents(lines: readonly PayableLine[]): number {
  return lines
    .filter(line => line.selectable)
    .reduce((sum, line) => sum + line.outstandingCents, 0);
}

export type SettlementPlan =
  | {
      /**
       * The selection covers whole orders. Settle them down the PROVEN whole-order path -- card
       * push/poll, its fallbacks, receipts, payment_events.
       */
      kind: 'orders';
      orderIds: string[];
      totalCents: number;
    }
  | {
      /**
       * The selection is part of an order. Only the allocation route can express this.
       * `allocate` are lines with no existing allocation, which must be allocated first;
       * `settle` are allocation ids that already exist and are unsettled.
       */
      kind: 'allocations';
      allocate: Array<{lineId: string; orderId: string}>;
      settle: string[];
      totalCents: number;
    }
  | {kind: 'nothing'};

/**
 * WHICH ROUTE THIS SELECTION MUST TAKE. The single decision point -- see the header.
 *
 * A selection is "whole orders" when, for every order it touches, EVERY still-collectable line on
 * that order is ticked and no part of it has already been split. A part-split order goes down the
 * allocation path even when every remaining line is ticked, because its settled cents live in the
 * ledger and the whole-order route would charge the order's full total again.
 */
export function planFor(
  lines: readonly PayableLine[],
  selectedIds: ReadonlySet<string>,
): SettlementPlan {
  const selected = lines.filter(line => selectedIds.has(line.id) && line.selectable);
  if (selected.length === 0) {
    return {kind: 'nothing'};
  }
  const totalCents = selected.reduce((sum, line) => sum + line.outstandingCents, 0);
  const touchedOrderIds = Array.from(new Set(selected.map(line => line.orderId)));

  const wholeOrders = touchedOrderIds.every(orderId => {
    const onOrder = lines.filter(line => line.orderId === orderId);
    const collectable = onOrder.filter(line => line.selectable);
    const everyCollectableTicked = collectable.every(line => selectedIds.has(line.id));
    const untouchedByASplit = onOrder.every(
      line => line.settledCents === 0 && line.openAllocationIds.length === 0,
    );
    return everyCollectableTicked && untouchedByASplit;
  });

  if (wholeOrders) {
    return {kind: 'orders', orderIds: touchedOrderIds, totalCents};
  }

  const allocate: Array<{lineId: string; orderId: string}> = [];
  const settle: string[] = [];
  for (const line of selected) {
    if (line.openAllocationIds.length > 0) {
      settle.push(...line.openAllocationIds);
    } else {
      allocate.push({lineId: line.id, orderId: line.orderId});
    }
  }
  return {kind: 'allocations', allocate, settle, totalCents};
}

/**
 * Whether this tab can be paid item by item at all.
 *
 * `has_lines: false` is a tab the server cannot describe line by line -- a QR tab placed before
 * waiter-led service was switched on, for instance. There is nothing to list, and the screen must
 * fall back to the order-level list it has always shown rather than presenting an empty bill.
 */
export function canTakePaymentByItem(payload: TabLinesPayload | null): boolean {
  return payload != null && payload.has_lines === true && (payload.orders?.length ?? 0) > 0;
}

/**
 * WHO A PART-ORDER PAYMENT IS RECORDED AGAINST.
 *
 * The allocation ledger requires a non-empty `allocated_to` -- it was built for splitting a bill
 * between NAMED people. Take Payment names nobody: a customer at the table pays for some items,
 * and the waiter is not going to ask their name to take their money.
 *
 * So this is what goes in the ledger, and it is deliberately not a person. It says where the money
 * was taken, which is the only true thing available. Putting the ORDER's member_name here would be
 * worse than saying nothing: it would record that the person who placed the round paid for it,
 * which is exactly the claim nobody made.
 *
 * SIGNED BY THE OWNER 2026-09-04 along with the rest of the Ship 1b wording, explicitly on this
 * reasoning: member_name would record that whoever placed the round paid for it. It reaches
 * reports, not just the screen, which is why it was signed rather than chosen here.
 */
export const ALLOCATION_PAYER_AT_TABLE = 'Table';

/** Integer cents to the string a waiter reads. */
export function formatCents(cents: number): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  return `NAD ${(safe / 100).toFixed(2)}`;
}

/**
 * ==================================================================================================
 * HOW MUCH OF ONE ORDER IS PAID FOR -- THE ORDER-LEVEL READING, DISPLAY ONLY
 * ==================================================================================================
 *
 * The per-item rows already say Paid / "{amount} still owed" and are UNCHANGED. What a waiter had
 * no way to see was the order as a whole: with eight items on screen they were counting ticks to
 * work out whether the table still owed anything, and the order heading said only "Order #12".
 *
 * DERIVED ENTIRELY FROM `PayableLine`, which comes from the allocations the server sent. This adds
 * no arithmetic of its own beyond counting, and settles, claims and writes nothing -- the figures
 * are `outstandingCents` and `isPaid`, which the rows and the settle button already use. A summary
 * that disagreed with the rows beneath it would be worse than no summary.
 *
 * THE SAME RULE AS THE WEB'S `orderPaymentProgress`, stated twice in two codebases that cannot
 * import from each other. If one changes, the other is wrong.
 *
 * WHY THE LABEL FOLLOWS THE MONEY AND NOT THE COUNT: a line can read paid while cents remain (a
 * part-settled allocation set is exactly that shape), so a 4/4 count must not be allowed to say
 * PAID while the order still owes something. `remainingCents` decides the state; the count only
 * describes it.
 *
 * UNPRICED LINES COUNT IN THE DENOMINATOR AND NEVER THE NUMERATOR. "3/4 paid" where the fourth
 * cannot be priced is honest; 4/4 would tell a waiter the order is settled when nobody knows what
 * the last item costs.
 */
export type OrderPaymentState = 'unpaid' | 'partial' | 'paid';

export type OrderPaymentSummary = {
  state: OrderPaymentState;
  /** Lines fully paid for. Never counts an unpriced line. */
  paidLines: number;
  /** Every payable line on the order, including unpriced ones. */
  totalLines: number;
  /** Still to collect on this order, in integer cents. */
  remainingCents: number;
  /**
   * Unpaid lines the server could not price. While this is above zero the REMAINDER IS NOT KNOWN,
   * and `remainingCents` is a floor rather than the answer -- see the note in the function.
   */
  unpricedLines: number;
};

/** Reduce one order's payable lines to the heading summary. */
export function orderPaymentSummary(
  lines: readonly PayableLine[],
  orderId: string,
): OrderPaymentSummary {
  const own = lines.filter(line => line.orderId === orderId);
  const totalLines = own.length;

  if (totalLines === 0) {
    return {
      state: 'paid',
      paidLines: 0,
      totalLines: 0,
      remainingCents: 0,
      unpricedLines: 0,
    };
  }

  let paidLines = 0;
  let unpricedLines = 0;
  let remainingCents = 0;
  for (const line of own) {
    if (line.isPaid) {
      paidLines += 1;
      continue;
    }
    if (line.totalCents == null) {
      // `payableLines` gives an unpriced line outstandingCents 0 -- it cannot owe a number nobody
      // knows. Counting it here would make the order's remainder look complete.
      unpricedLines += 1;
      continue;
    }
    const owed = Number.isFinite(line.outstandingCents)
      ? Math.max(0, Math.round(line.outstandingCents))
      : 0;
    remainingCents += owed;
  }

  /**
   * AN UNPRICED LINE MUST NOT LET AN ORDER READ PAID.
   *
   * An unpriced line contributes 0 to the remainder, so an order of "one item paid, one item the
   * server could not price" totals 0 still owed and would announce PAID over a bill nobody has
   * priced. The row itself already says "No price -- settle this order whole"; the heading above
   * it must not contradict that.
   *
   * So while any unpriced line is unpaid, the order is never `paid`: it is `partial` if anything
   * has been collected and `unpaid` if not, and the caller drops the figure, because a remainder
   * containing an unknown is not a remainder.
   */
  const settledEverything = remainingCents === 0 && unpricedLines === 0;
  const state: OrderPaymentState = settledEverything
    ? 'paid'
    : paidLines > 0
      ? 'partial'
      : 'unpaid';

  return {state, paidLines, totalLines, remainingCents, unpricedLines};
}
