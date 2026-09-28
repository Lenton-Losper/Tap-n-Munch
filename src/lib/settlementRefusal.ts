/**
 * THE SERVER REFUSED TO START A CARD PAYMENT, AND SAID WHY.
 *
 * Sprint 2026-09-29 (F-TERMPAY, task 3). POST /api/terminal/orders/{id}/prepare-payment runs BEFORE
 * the reader opens and refuses, with nothing charged, when the set of orders the device is about to
 * charge is no longer what the device thinks it is:
 *
 *   409 SETTLEMENT_SET_NOT_CLAIMABLE  some order in the set is paid, cancelled or held for review;
 *                                     `not_claimable: [{order_id, order_number, reason}]` names them
 *   409 ORDER_NOTHING_OWED            the lead order owes nothing (its items were voided or collected)
 *   409 NOTHING_LEFT_TO_CHARGE        the whole set owes nothing
 *   400 ALREADY_PAID / ORDER_CANCELLED the lead order itself is paid / cancelled
 *
 * Every one of them means THE SCREEN IS STALE. The answer is always the same: say what happened in
 * words, refresh from the server, and let the waiter choose again. NEVER retry the same set -- it is
 * the set the server just refused -- and never open the reader because of one of these.
 *
 * Pure: no React, no network, no import of api.ts (api.ts imports this).
 */
import {
  PREPARE_REFUSAL_CANCELLED,
  PREPARE_REFUSAL_CHANGED,
  PREPARE_REFUSAL_HELD,
  PREPARE_REFUSAL_NOTHING_OWED,
  PREPARE_REFUSAL_ORDERS_PREFIX,
  PREPARE_REFUSAL_PAID,
  PREPARE_REFUSAL_REASON_WORD,
  PREPARE_REFUSAL_TITLE,
} from '../constants/settlementRefusalCopy';

export type NotClaimableReason = 'paid' | 'cancelled' | 'held' | 'other';

export type NotClaimableOrder = {
  orderId: string;
  orderNumber: number | null;
  reason: NotClaimableReason;
};

export const PREPARE_REFUSAL_CODES = [
  'SETTLEMENT_SET_NOT_CLAIMABLE',
  'ORDER_NOTHING_OWED',
  'NOTHING_LEFT_TO_CHARGE',
  'ALREADY_PAID',
  'ORDER_CANCELLED',
] as const;
export type PrepareRefusalCode = (typeof PREPARE_REFUSAL_CODES)[number];

export type PrepareRefusal = {
  code: PrepareRefusalCode;
  /** The orders the server named, with why. Empty for the codes that name none. */
  notClaimable: NotClaimableOrder[];
  /** ORDER_NOTHING_OWED's `order_ids_owing_nothing`. */
  orderIdsOwingNothing: string[];
};

function asReason(value: unknown): NotClaimableReason {
  const r = String(value ?? '').trim().toLowerCase();
  return r === 'paid' || r === 'cancelled' || r === 'held' ? r : 'other';
}

/**
 * `not_claimable` from the 409 body. A worker that predates it sends only `orders` (raw statuses);
 * those orders are still named, with reason 'other' -- the classification is the server's, and this
 * build does not keep a second copy of it.
 */
export function parseNotClaimable(body: unknown): NotClaimableOrder[] {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const b = body as {not_claimable?: unknown; orders?: unknown};
  const typed = Array.isArray(b.not_claimable);
  const rows = typed ? (b.not_claimable as unknown[]) : Array.isArray(b.orders) ? (b.orders as unknown[]) : [];
  const out: NotClaimableOrder[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as {order_id?: unknown; order_number?: unknown; reason?: unknown};
    const orderId = String(r.order_id ?? '').trim();
    if (!orderId) continue;
    const n = r.order_number == null || r.order_number === '' ? NaN : Number(r.order_number);
    out.push({
      orderId,
      orderNumber: Number.isFinite(n) ? n : null,
      reason: typed ? asReason(r.reason) : 'other',
    });
  }
  return out;
}

export function parseOrderIdsOwingNothing(body: unknown): string[] {
  const ids = (body as {order_ids_owing_nothing?: unknown} | null)?.order_ids_owing_nothing;
  return Array.isArray(ids) ? ids.map(id => String(id).trim()).filter(Boolean) : [];
}

export function isPrepareRefusalCode(code: unknown): code is PrepareRefusalCode {
  return (PREPARE_REFUSAL_CODES as readonly string[]).includes(String(code ?? ''));
}

/**
 * The typed refusal carried by an error thrown from prepareTerminalPayment, or null when the error
 * is anything else (network, 5xx, a code this build does not treat as "the screen is stale").
 */
export function prepareRefusalFromError(err: unknown): PrepareRefusal | null {
  if (!err || typeof err !== 'object') {
    return null;
  }
  const e = err as {code?: unknown; notClaimable?: unknown; orderIdsOwingNothing?: unknown};
  if (!isPrepareRefusalCode(e.code)) {
    return null;
  }
  return {
    code: e.code,
    notClaimable: Array.isArray(e.notClaimable) ? (e.notClaimable as NotClaimableOrder[]) : [],
    orderIdsOwingNothing: Array.isArray(e.orderIdsOwingNothing)
      ? (e.orderIdsOwingNothing as string[])
      : [],
  };
}

/**
 * The one sentence for this refusal, plus the orders it names when the server named any.
 */
export function prepareRefusalMessage(refusal: PrepareRefusal): {title: string; body: string} {
  let reason: NotClaimableReason | 'nothing_owed';
  switch (refusal.code) {
    case 'ALREADY_PAID':
      reason = 'paid';
      break;
    case 'ORDER_CANCELLED':
      reason = 'cancelled';
      break;
    case 'ORDER_NOTHING_OWED':
    case 'NOTHING_LEFT_TO_CHARGE':
      reason = 'nothing_owed';
      break;
    default: {
      const reasons = [...new Set(refusal.notClaimable.map(o => o.reason))];
      reason = reasons.length === 1 ? reasons[0] : 'other';
    }
  }
  const sentence =
    reason === 'paid'
      ? PREPARE_REFUSAL_PAID
      : reason === 'cancelled'
        ? PREPARE_REFUSAL_CANCELLED
        : reason === 'held'
          ? PREPARE_REFUSAL_HELD
          : reason === 'nothing_owed'
            ? PREPARE_REFUSAL_NOTHING_OWED
            : PREPARE_REFUSAL_CHANGED;

  const named = refusal.notClaimable.filter(o => o.orderNumber != null);
  const list =
    named.length > 0
      ? `\n\n${PREPARE_REFUSAL_ORDERS_PREFIX} ${named
          .map(o => `#${o.orderNumber} ${PREPARE_REFUSAL_REASON_WORD[o.reason]}`)
          .join(', ')}`
      : '';
  return {title: PREPARE_REFUSAL_TITLE, body: `${sentence}${list}`};
}

/**
 * The ids the refusal proves the device must stop offering: every order the server named, and any
 * order it said owes nothing. The caller drops these from its selection BEFORE the refresh lands, so
 * a second tap cannot resend the refused set while the new state is on its way.
 */
export function refusedOrderIds(refusal: PrepareRefusal): string[] {
  return [
    ...new Set([...refusal.notClaimable.map(o => o.orderId), ...refusal.orderIdsOwingNothing]),
  ];
}
