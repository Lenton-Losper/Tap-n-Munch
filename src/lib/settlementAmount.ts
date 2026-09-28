/**
 * WHAT A WHOLE-ORDER SETTLE IS WORTH, ON THE DEVICE.
 *
 * ==================================================================================================
 * WHY THE DEVICE HAD TO LEARN THIS
 * ==================================================================================================
 *
 * The server moved its whole-order charge basis to the OUTSTANDING amount: order total minus what
 * has already been collected through the item ledger. The device did not follow. It summed
 * `order.total`, which was the only basis in existence when it was written.
 *
 * On a part-paid order the two then disagree, and the order of operations makes that dangerous
 * rather than merely wrong:
 *
 *   1. prepare-payment charges the reader the correct outstanding amount.  MONEY MOVES.
 *   2. the device reports success and calls /settle with the old whole-total figure.
 *   3. the server's cross-check refuses it.
 *
 * A real charge with no settlement recorded against it. On the cash path it is less severe and
 * still wrong: a legitimate collection blocked at the till.
 *
 * ==================================================================================================
 * SPRINT 2026-09-28: VOIDS, AND THE SERVER'S OWN FIGURE
 * ==================================================================================================
 *
 * `amend_order_lines` never rewrites the ORIGINAL order. A void marks the line voided and, for a
 * reduction, adds a REPLACEMENT order carrying the surviving quantity. `orders.total` therefore
 * keeps counting every voided line. The old rule here -- min(total, Σ payable-line outstanding),
 * falling back to the full total when an order had no payable lines -- charged a FULLY voided order
 * its whole original total, because voided lines are not payable and so it "had no lines".
 *
 * The figure is now resolved in this order, and nowhere else on the device:
 *
 *   1. SERVER (contract C2). `financials.orders[id].outstanding_cents` from the tab lines payload.
 *      Authoritative whenever the payload carries `financials`; the device re-derives nothing. An
 *      order the server's block does not mention is UNKNOWN, never N$0 and never its total.
 *   2. LINES (a server that predates C2). The same subtraction the server's projection makes:
 *        live        = original - Σ voided lines' own money   (0 for a cancelled order)
 *        outstanding = max(0, live - Σ settled allocations)
 *      A voided line whose price the server could not state makes the order UNKNOWN: its live
 *      value cannot be proved, and guessing either way is a wrong charge.
 *   3. NO LINES ON THE ORDER, in a payload that was actually read: an order with no order_lines
 *      rows can have had nothing voided and nothing allocated, so its total IS what it owes. This is
 *      the server's `lineCoverage: 'none'` rule, and it keeps every QR and pre-lines order working.
 *
 *   And when there is NO PAYLOAD AT ALL (the lines read failed, or has not happened), the answer is
 *   UNKNOWN. This used to fall back to the order total. Sprint 2026-09-28 brief: "prefer showing
 *   'amount unavailable -- refresh' over a guessed number on the payment path". A total guessed
 *   past a void is an overcharge the device can no longer see.
 *
 * UNKNOWN IS `null`, AND EVERY CALLER MUST REFUSE TO COLLECT ON IT. Never 0 (stops collecting),
 * never the order total (charges voided food).
 *
 * THE GRATUITY IS NOT HERE. It rides alongside the bill and is added exactly once, by the server,
 * in prepare-payment. A tip must never reach this figure -- /settle records what the ITEMS were
 * worth, and payment_tips records the rest.
 */
import type {MoneyCents, TabLinesPayload} from './tabLines';

/** Just enough of an order to price it. */
export interface SettleableOrderLike {
  id: string;
  total: number;
  /** orders.status. A cancelled order is worth nothing, whatever its stored total says. */
  status?: string | null;
}

/**
 * What the device knows about the tab's money: the tab lines payload it already holds, or
 * null/undefined when it has none (not read yet, or the read failed).
 */
export type MoneyBasis = TabLinesPayload | null | undefined;

/** One order's money, integer cents, and where the figures came from. */
export type OrderMoney = {
  originalCents: number;
  voidedCents: number;
  liveCents: number;
  paidCents: number;
  outstandingCents: number;
  overpaidCents: number;
  /** 'server' = C2 financials; 'lines' = derived from the payload's own lines (older server). */
  source: 'server' | 'lines';
};

function fromServer(money: MoneyCents): OrderMoney {
  return {
    originalCents: money.original_cents,
    voidedCents: money.voided_cents,
    liveCents: money.live_cents,
    paidCents: money.paid_cents,
    outstandingCents: money.outstanding_cents,
    overpaidCents: money.overpaid_cents,
    source: 'server',
  };
}

/**
 * The resolved money for ONE order, or null when it cannot be known. See the header for the order
 * in which the sources are consulted.
 */
export function orderMoney(order: SettleableOrderLike, basis: MoneyBasis): OrderMoney | null {
  if (!order || !basis) {
    return null;
  }

  if (basis.financials) {
    const money = basis.financials.orders?.[order.id];
    return money ? fromServer(money) : null;
  }

  const rawTotal = Number(order.total);
  if (!Number.isFinite(rawTotal) || rawTotal < 0) {
    return null;
  }
  const originalCents = Math.round(rawTotal * 100);
  const lines = (basis.orders ?? []).find(o => o?.order_id === order.id)?.lines ?? [];

  let voidedCents = 0;
  let paidCents = 0;
  for (const line of lines) {
    if (line?.is_voided) {
      const cents = line.total_cents;
      if (typeof cents !== 'number' || !Number.isFinite(cents) || cents < 0) {
        // A void we cannot price. The live figure is unprovable; say so rather than guess.
        return null;
      }
      voidedCents += Math.round(cents);
    }
    for (const allocation of line?.allocations ?? []) {
      if (allocation?.settled_at != null && Number.isFinite(allocation.amount_cents)) {
        paidCents += Math.max(0, Math.round(allocation.amount_cents));
      }
    }
  }

  const cancelled = String(order.status ?? '').trim().toLowerCase() === 'cancelled';
  const liveCents = cancelled ? 0 : Math.max(0, originalCents - voidedCents);
  return {
    originalCents,
    voidedCents,
    liveCents,
    paidCents,
    /**
     * Clamped at zero PER ORDER, mirroring the server: clamping only on a sum would let one
     * over-settled order silently absorb another's genuine debt.
     */
    outstandingCents: Math.max(0, liveCents - paidCents),
    overpaidCents: Math.max(0, paidCents - liveCents),
    source: 'lines',
  };
}

/** What this ONE order still owes, in integer cents, or null when that cannot be known. */
export function outstandingCentsForOrder(
  order: SettleableOrderLike,
  basis: MoneyBasis,
): number | null {
  const money = orderMoney(order, basis);
  return money ? money.outstandingCents : null;
}

/**
 * What this SET of orders still owes, in major units, for the /settle amount field -- or null when
 * ANY of them is unknown. One unknown order makes the sum unknown: settling the rest for a figure
 * that silently leaves it out would record a tab as paid for less than the orders it closed.
 */
export function settlementAmountFor(
  orders: readonly SettleableOrderLike[],
  basis: MoneyBasis,
): number | null {
  /**
   * SUMMED IN CENTS AND DIVIDED ONCE. Adding major-unit figures accumulates float error -- the
   * shape that lands a settle on 78.35000000000001 and fails an exact-match gate.
   */
  let cents = 0;
  for (const order of orders ?? []) {
    const owed = outstandingCentsForOrder(order, basis);
    if (owed == null) {
      return null;
    }
    cents += owed;
  }
  return cents / 100;
}

/**
 * The money for an order that is on NO tab -- a walk-up sale, a kiosk order.
 *
 * Voids are tab-scoped (`POST /api/terminal/tabs/{tabId}/amend`) and so are allocations, so an order
 * with no tab can have had nothing voided and nothing split: its total IS what it owes. This is
 * NOT a fallback for a tab order whose lines could not be read -- that is unknown, and must go
 * through orderMoney with the payload it failed to get.
 */
export function orderMoneyWithoutTab(order: SettleableOrderLike): OrderMoney | null {
  const rawTotal = Number(order?.total);
  if (!Number.isFinite(rawTotal) || rawTotal < 0) {
    return null;
  }
  const originalCents = Math.round(rawTotal * 100);
  const cancelled = String(order.status ?? '').trim().toLowerCase() === 'cancelled';
  const liveCents = cancelled ? 0 : originalCents;
  return {
    originalCents,
    voidedCents: 0,
    liveCents,
    paidCents: 0,
    outstandingCents: liveCents,
    overpaidCents: 0,
    source: 'lines',
  };
}
