/**
 * WHAT ONE ORDER IS WORTH NOW, for the single-order screens (Order detail, Charge).
 *
 * Those screens hold an `Order` from /api/terminal/orders, whose `total` is the stored original and
 * keeps counting voided lines (sprint 2026-09-28). The live figure lives on the tab lines payload --
 * the server's C2 `financials`, or the voided lines an older server sends -- so an order on a tab is
 * resolved through that payload, by the same orderMoney the table screen uses.
 *
 *   no tab_id             -> its total: voids and splits are tab-scoped (orderMoneyWithoutTab).
 *   tab_id, lines read    -> orderMoney(order, payload).
 *   tab_id, read failed   -> UNAVAILABLE. Never the stored total, never 0.
 */
import {getTabLines} from './api';
import {
  orderMoney,
  orderMoneyWithoutTab,
  type OrderMoney,
  type SettleableOrderLike,
} from './settlementAmount';
import type {TabLinesPayload} from './tabLines';

export type OrderMoneyState =
  | {kind: 'loading'}
  | {kind: 'known'; money: OrderMoney}
  | {kind: 'unavailable'};

export interface OrderOnATabLike extends SettleableOrderLike {
  tab_id?: string | null;
}

export async function resolveOrderMoney(
  order: OrderOnATabLike,
  token: string,
  fetchLines: (tabId: string, token: string) => Promise<TabLinesPayload> = getTabLines,
): Promise<OrderMoneyState> {
  const tabId = String(order?.tab_id ?? '').trim();
  if (!tabId) {
    const money = orderMoneyWithoutTab(order);
    return money ? {kind: 'known', money} : {kind: 'unavailable'};
  }
  let payload: TabLinesPayload;
  try {
    payload = await fetchLines(tabId, token);
  } catch {
    return {kind: 'unavailable'};
  }
  const money = orderMoney(order, payload);
  return money ? {kind: 'known', money} : {kind: 'unavailable'};
}
