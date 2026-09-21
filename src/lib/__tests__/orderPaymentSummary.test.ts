/**
 * THE ORDER-LEVEL PAYMENT READING on Take Payment, at 0%, part-way, and 100%.
 *
 * The per-item rows already said Paid / "{amount} still owed" and are untouched. What a waiter
 * could not see was the ORDER: with several items on screen the heading said only "Order #12", so
 * "does this still owe anything" meant reading every row and adding up.
 *
 * DERIVED FROM REAL `payableLines` OUTPUT, never from hand-written PayableLine literals. A summary
 * built from invented shapes would keep passing after the derivation beneath it changed, which is
 * exactly the disagreement between a heading and the rows under it that this must not produce.
 *
 * Nothing here exercises payment behaviour: `orderPaymentSummary` counts rows and writes nothing.
 */
import {orderPaymentSummary, payableLines} from '../takePaymentLines';
import type {TabLine, TabLinesPayload} from '../tabLines';
import type {TabOrder} from '../../types';

const PLACED_AT = '2026-09-04T18:00:00.000Z';

function line(over: Partial<TabLine> & {id: string}): TabLine {
  return {
    name_snapshot: 'Steak',
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'ready',
    bar_state: null,
    is_ready: true,
    is_voided: false,
    unrouted: false,
    total_cents: 1000,
    ...over,
  } as TabLine;
}

function order(over: Partial<TabOrder> & {id: string}): TabOrder {
  return {
    order_number: 1,
    total: 40,
    status: 'completed',
    payment_status: 'unpaid',
    items: [],
    placed_at: PLACED_AT,
    ...over,
  } as TabOrder;
}

function payload(
  groups: Array<{orderId: string; orderNumber?: number; lines: TabLine[]}>,
): TabLinesPayload {
  return {
    tab: {
      id: 'tab-1',
      table_number: 5,
      status: 'open',
      total: 0,
      opened_at: PLACED_AT,
      opened_by_user_id: 'user-1',
    },
    orders: groups.map(g => ({
      order_id: g.orderId,
      order_number: g.orderNumber ?? 1,
      order_instructions: null,
      order_total: 0,
      placed_at: PLACED_AT,
      seconds_since_placed: 60,
      lines: g.lines,
    })),
    summary: {total_lines: 0, outstanding: 0, ready: 0, voided: 0},
    all_ready: true,
    has_lines: true,
    server_time: null,
  } as unknown as TabLinesPayload;
}

/** A settled allocation covering the whole of one N$10 line. */
const settled = (id: string) => ({
  id: `a-${id}`,
  order_line_id: id,
  allocated_to: 'Table',
  quantity_allocated: 1,
  amount_cents: 1000,
  settled_at: PLACED_AT,
});

/** An allocation that exists but nobody has paid yet. */
const open = (id: string, cents = 1000) => ({
  id: `a-${id}`,
  order_line_id: id,
  allocated_to: 'Table',
  quantity_allocated: 1,
  amount_cents: cents,
  settled_at: null,
});

const fourLines = (allocations: Record<string, unknown[]> = {}) =>
  payload([
    {
      orderId: 'o1',
      lines: ['l1', 'l2', 'l3', 'l4'].map(id =>
        line({id, allocations: (allocations[id] ?? []) as never}),
      ),
    },
  ]);

describe('orderPaymentSummary — 0% paid', () => {
  it('reports UNPAID with the whole order remaining', () => {
    const rows = payableLines(fourLines(), [order({id: 'o1'})]);
    const summary = orderPaymentSummary(rows, 'o1');
    expect(summary.state).toBe('unpaid');
    expect(summary.paidLines).toBe(0);
    expect(summary.totalLines).toBe(4);
    expect(summary.remainingCents).toBe(4000);
  });

  it('an allocation that is not settled collects nothing', () => {
    const rows = payableLines(fourLines({l1: [open('l1')]}), [order({id: 'o1'})]);
    const summary = orderPaymentSummary(rows, 'o1');
    expect(summary.state).toBe('unpaid');
    expect(summary.remainingCents).toBe(4000);
  });
});

describe('orderPaymentSummary — partially paid', () => {
  it('reports 3/4 with only the unpaid line remaining', () => {
    const rows = payableLines(
      fourLines({l1: [settled('l1')], l2: [settled('l2')], l3: [settled('l3')]}),
      [order({id: 'o1'})],
    );
    const summary = orderPaymentSummary(rows, 'o1');
    expect(summary.state).toBe('partial');
    expect(summary.paidLines).toBe(3);
    expect(summary.totalLines).toBe(4);
    expect(summary.remainingCents).toBe(1000);
  });

  it('a part-settled line still owes its balance and is not counted paid', () => {
    // Half of one N$10 line is settled: the line is not paid, and N$5 of it is still owed.
    const half = {...settled('l1'), amount_cents: 500};
    const rows = payableLines(fourLines({l1: [half]}), [order({id: 'o1'})]);
    const summary = orderPaymentSummary(rows, 'o1');
    expect(summary.paidLines).toBe(0);
    expect(summary.state).toBe('unpaid');
    expect(summary.remainingCents).toBe(3500);
  });

  it('counts only the named order when a tab carries several', () => {
    const two = payload([
      {orderId: 'o1', orderNumber: 1, lines: [line({id: 'a1', allocations: [settled('a1')] as never})]},
      {orderId: 'o2', orderNumber: 2, lines: [line({id: 'b1'})]},
    ]);
    const rows = payableLines(two, [
      order({id: 'o1', total: 10}),
      order({id: 'o2', total: 10}),
    ]);
    expect(orderPaymentSummary(rows, 'o1').state).toBe('paid');
    expect(orderPaymentSummary(rows, 'o2').state).toBe('unpaid');
    expect(orderPaymentSummary(rows, 'o2').remainingCents).toBe(1000);
  });

  /**
   * AN UNPRICED LINE MUST NOT LET THE ORDER READ PAID.
   *
   * `payableLines` gives an unpriced line `outstandingCents: 0` -- it cannot owe a number nobody
   * knows -- so a naive sum over the lines makes "one item paid, one item unpriced" total zero
   * still owed and announce PAID over a bill nobody has priced. The row itself says
   * "No price — settle this order whole"; the heading above it must not contradict that.
   */
  it('never reads PAID while a line is unpriced, and reports the unknown', () => {
    const mixed = payload([
      {
        orderId: 'o1',
        lines: [
          line({id: 'p1', allocations: [settled('p1')] as never}),
          line({id: 'p2', total_cents: null as never}),
        ],
      },
    ]);
    const rows = payableLines(mixed, [order({id: 'o1', total: 10})]);
    const summary = orderPaymentSummary(rows, 'o1');
    expect(summary.totalLines).toBe(2);
    expect(summary.paidLines).toBe(1);
    expect(summary.unpricedLines).toBe(1);
    expect(summary.state).toBe('partial');
    expect(summary.state).not.toBe('paid');
  });

  it('an order that is ONLY an unpriced line is unpaid, not paid', () => {
    const only = payload([
      {orderId: 'o1', lines: [line({id: 'p1', total_cents: null as never})]},
    ]);
    const rows = payableLines(only, [order({id: 'o1', total: 10})]);
    const summary = orderPaymentSummary(rows, 'o1');
    expect(summary.unpricedLines).toBe(1);
    expect(summary.state).toBe('unpaid');
  });
});

describe('orderPaymentSummary — 100% paid', () => {
  it('reports PAID with nothing remaining when every line is settled', () => {
    const rows = payableLines(
      fourLines({
        l1: [settled('l1')],
        l2: [settled('l2')],
        l3: [settled('l3')],
        l4: [settled('l4')],
      }),
      [order({id: 'o1'})],
    );
    const summary = orderPaymentSummary(rows, 'o1');
    expect(summary.state).toBe('paid');
    expect(summary.paidLines).toBe(4);
    expect(summary.remainingCents).toBe(0);
  });

  /**
   * THE REGRESSION THE NAIVE VERSION SHIPS. An order settled WHOLE carries no allocations at all,
   * so allocation arithmetic alone reads it as nothing paid. `payableLines` already resolves this
   * from the order's own status, and the summary must inherit that rather than re-decide it.
   */
  it('an order settled WHOLE reads PAID despite having no allocations', () => {
    const rows = payableLines(fourLines(), [order({id: 'o1', payment_status: 'paid'})]);
    const summary = orderPaymentSummary(rows, 'o1');
    expect(summary.state).toBe('paid');
    expect(summary.paidLines).toBe(4);
    expect(summary.remainingCents).toBe(0);
  });

  it('an order with no payable lines says nothing rather than owing something', () => {
    const rows = payableLines(fourLines(), [order({id: 'o1'})]);
    const summary = orderPaymentSummary(rows, 'missing-order');
    expect(summary.totalLines).toBe(0);
    expect(summary.remainingCents).toBe(0);
  });
});
