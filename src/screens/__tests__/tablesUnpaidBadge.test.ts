/**
 * #230 — the "N unpaid orders" badge on TablesScreen must not count CANCELLED orders.
 *
 * WHY THIS EXISTS SEPARATELY FROM paymentIntegrity.test.ts. That suite proves owesMoney's status
 * set is right. It says nothing about whether the badge uses it, and the badge is where #230
 * actually lived: TablesScreen filtered `payment_status !== 'paid'`, which is equally true of a
 * cancelled order, so a table could render "NAD 0.00", "1 unpaid order" and "Ready to Close" at
 * the same time. The rule was already correct and already covered; the call site was neither.
 *
 * THE GAP WAS MEASURED, NOT ASSUMED. Before this file existed, both halves of #230 were reverted
 * by hand against the full suite:
 *
 *   body back to `payment_status !== 'paid'`      -> 317/317 green; eslint flagged only the
 *                                                   now-unused owesMoney import, which guards the
 *                                                   import and not the behaviour
 *   `owesMoney(s) || s === 'cancelled'`           -> 317/317 green AND eslint clean, with the
 *                                                   original defect fully restored
 *
 * So the fix shipped with nothing watching it. countUnpaidOrders is exported for this reason.
 */
import {countUnpaidOrders} from '../TablesScreen';
import type {TabOrder, TableWithTab} from '../../types';

function order(id: string, payment_status: string): TabOrder {
  return {
    id,
    order_number: Number(id),
    total: 100,
    status: 'served',
    payment_status,
    items: [],
    placed_at: '2026-08-27T00:00:00.000Z',
  };
}

function tableWith(orders: TabOrder[]): TableWithTab {
  return {
    id: 'table-1',
    table_number: 1,
    status: 'occupied',
    can_close: false,
    tab: {
      id: 'tab-1',
      status: 'open',
      total: 100 * orders.length,
      unpaid_total: 0,
      orders,
    },
  };
}

describe('#230 — countUnpaidOrders', () => {
  it('does NOT count a cancelled order', () => {
    // The defect verbatim: pre-#230 this returned 1 and the card read "1 unpaid order"
    // beside a "NAD 0.00" total.
    expect(countUnpaidOrders(tableWith([order('1', 'cancelled')]))).toBe(0);
  });

  it('does not count a paid order either', () => {
    expect(countUnpaidOrders(tableWith([order('1', 'paid')]))).toBe(0);
  });

  it('counts every status where money is still owed', () => {
    // The other side. A badge that counted nothing would satisfy the two assertions above.
    const owed = [
      'unpaid',
      'pending',
      'cash_pending',
      'failed',
      'terminal_pending',
    ];
    expect(
      countUnpaidOrders(tableWith(owed.map((s, i) => order(String(i), s)))),
    ).toBe(owed.length);
  });

  it('counts only the owed ones in a mixed tab', () => {
    // The realistic table: some diners paid, one order was cancelled, two still owe.
    const table = tableWith([
      order('1', 'paid'),
      order('2', 'cancelled'),
      order('3', 'unpaid'),
      order('4', 'cash_pending'),
    ]);
    expect(countUnpaidOrders(table)).toBe(2);
  });

  it('is 0 for a table with no tab', () => {
    const table = tableWith([]);
    table.tab = null;
    expect(countUnpaidOrders(table)).toBe(0);
  });

  it('tolerates the casing and padding a server response might carry', () => {
    // owesMoney trims and lower-cases; the badge must inherit that rather than re-deriving.
    expect(countUnpaidOrders(tableWith([order('1', ' UNPAID ')]))).toBe(1);
    expect(countUnpaidOrders(tableWith([order('1', ' Cancelled ')]))).toBe(0);
  });
});
