/**
 * TAKE PAYMENT BY ITEM -- the arithmetic and the route decision.
 *
 * Three properties this suite exists to hold:
 *
 *   1. AN UNPRICED LINE IS NEVER WORTH ZERO. It is refused, visibly, and cannot be ticked.
 *   2. A LINE IS NOT SOLD TWICE. Paid lines are inert whether the order was settled whole (no
 *      allocations at all) or item by item (a settled allocation).
 *   3. WHOLE ORDERS TAKE THE WHOLE-ORDER ROUTE. Routing them through allocations would move every
 *      card payment off the flow that has the gateway fallbacks.
 */
import {
  canTakePaymentByItem,
  formatCents,
  outstandingTotalCents,
  payableLines,
  planFor,
  selectionTotalCents,
} from '../takePaymentLines';
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
    total_cents: 10000,
    ...over,
  } as TabLine;
}

function order(over: Partial<TabOrder> & {id: string}): TabOrder {
  return {
    order_number: 1,
    total: 100,
    status: 'completed',
    payment_status: 'unpaid',
    items: [],
    placed_at: PLACED_AT,
    ...over,
  } as TabOrder;
}

function payload(
  groups: Array<{orderId: string; orderNumber?: number; lines: TabLine[]}>,
  hasLines = true,
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
    has_lines: hasLines,
    server_time: null,
  } as unknown as TabLinesPayload;
}

describe('what the list shows', () => {
  it('drops voided lines rather than listing them as free', () => {
    const rows = payableLines(
      payload([{orderId: 'o1', lines: [line({id: 'l1'}), line({id: 'l2', is_voided: true})]}]),
      [order({id: 'o1'})],
    );
    expect(rows.map(r => r.id)).toEqual(['l1']);
  });

  it('refuses an unpriced line instead of treating it as worth nothing', () => {
    const rows = payableLines(
      payload([{orderId: 'o1', lines: [line({id: 'l1', total_cents: null})]}]),
      [order({id: 'o1'})],
    );
    expect(rows[0].selectable).toBe(false);
    expect(rows[0].refusal).toBe('no_price');
    expect(rows[0].totalCents).toBeNull();
    // And it contributes nothing to a total someone might collect against.
    expect(outstandingTotalCents(rows)).toBe(0);
  });

  it('refuses a line whose price field the server never sent at all', () => {
    const bare = line({id: 'l1'});
    delete (bare as {total_cents?: unknown}).total_cents;
    const rows = payableLines(payload([{orderId: 'o1', lines: [bare]}]), [order({id: 'o1'})]);
    expect(rows[0].refusal).toBe('no_price');
  });

  it('treats a line on a paid order as paid even with no allocations on it', () => {
    const rows = payableLines(
      payload([{orderId: 'o1', lines: [line({id: 'l1'})]}]),
      [order({id: 'o1', payment_status: 'paid'})],
    );
    expect(rows[0].isPaid).toBe(true);
    expect(rows[0].selectable).toBe(false);
    expect(rows[0].outstandingCents).toBe(0);
  });

  it('treats a line whose allocations are all settled as paid', () => {
    const rows = payableLines(
      payload([
        {
          orderId: 'o1',
          lines: [
            line({
              id: 'l1',
              total_cents: 10000,
              allocations: [
                {id: 'a1', allocated_to: 'Ana', quantity_allocated: 0.5, amount_cents: 5000, settled_at: PLACED_AT},
                {id: 'a2', allocated_to: 'Ben', quantity_allocated: 0.5, amount_cents: 5000, settled_at: PLACED_AT},
              ],
            }),
          ],
        },
      ]),
      [order({id: 'o1'})],
    );
    expect(rows[0].isPaid).toBe(true);
    expect(rows[0].settledCents).toBe(10000);
    expect(rows[0].outstandingCents).toBe(0);
  });

  it('leaves a half-settled line outstanding for exactly its unpaid half', () => {
    const rows = payableLines(
      payload([
        {
          orderId: 'o1',
          lines: [
            line({
              id: 'l1',
              total_cents: 10000,
              allocations: [
                {id: 'a1', allocated_to: 'Ana', quantity_allocated: 0.5, amount_cents: 5000, settled_at: PLACED_AT},
                {id: 'a2', allocated_to: 'Ben', quantity_allocated: 0.5, amount_cents: 5000, settled_at: null},
              ],
            }),
          ],
        },
      ]),
      [order({id: 'o1'})],
    );
    expect(rows[0].isPaid).toBe(false);
    expect(rows[0].outstandingCents).toBe(5000);
    expect(rows[0].openAllocationIds).toEqual(['a2']);
  });

  it('refuses a line on a cancelled order', () => {
    const rows = payableLines(
      payload([{orderId: 'o1', lines: [line({id: 'l1'})]}]),
      [order({id: 'o1', payment_status: 'cancelled'})],
    );
    expect(rows[0].refusal).toBe('order_not_claimable');
    expect(rows[0].selectable).toBe(false);
  });
});

describe('the running total', () => {
  it('sums only ticked, selectable lines, in integer cents', () => {
    const rows = payableLines(
      payload([
        {
          orderId: 'o1',
          lines: [
            line({id: 'l1', total_cents: 3333}),
            line({id: 'l2', total_cents: 3333}),
            line({id: 'l3', total_cents: 3334}),
          ],
        },
      ]),
      [order({id: 'o1'})],
    );
    expect(selectionTotalCents(rows, new Set(['l1', 'l2', 'l3']))).toBe(10000);
    expect(selectionTotalCents(rows, new Set(['l1']))).toBe(3333);
    expect(formatCents(10000)).toBe('NAD 100.00');
  });

  it('ignores a ticked line that has since become unselectable', () => {
    const rows = payableLines(
      payload([{orderId: 'o1', lines: [line({id: 'l1'}), line({id: 'l2', total_cents: null})]}]),
      [order({id: 'o1'})],
    );
    expect(selectionTotalCents(rows, new Set(['l1', 'l2']))).toBe(10000);
  });
});

describe('which money path a selection takes', () => {
  const twoOrders = () =>
    payableLines(
      payload([
        {orderId: 'o1', orderNumber: 1, lines: [line({id: 'l1'}), line({id: 'l2'})]},
        {orderId: 'o2', orderNumber: 2, lines: [line({id: 'l3'})]},
      ]),
      [order({id: 'o1'}), order({id: 'o2', order_number: 2})],
    );

  it('sends a whole order down the proven whole-order route', () => {
    const plan = planFor(twoOrders(), new Set(['l1', 'l2']));
    expect(plan).toEqual({kind: 'orders', orderIds: ['o1'], totalCents: 20000});
  });

  it('sends several whole orders down it too', () => {
    const plan = planFor(twoOrders(), new Set(['l1', 'l2', 'l3']));
    expect(plan.kind).toBe('orders');
    expect(plan.kind === 'orders' && plan.orderIds.sort()).toEqual(['o1', 'o2']);
  });

  it('sends part of an order down the allocation route', () => {
    const plan = planFor(twoOrders(), new Set(['l1']));
    expect(plan).toEqual({
      kind: 'allocations',
      allocate: [{lineId: 'l1', orderId: 'o1'}],
      settle: [],
      totalCents: 10000,
    });
  });

  it('keeps a part-split order on the allocation route even when every remaining line is ticked', () => {
    // o1's first line was split and half-collected. The whole-order route would charge o1's full
    // total again, because the ledger is where the collected half lives.
    const rows = payableLines(
      payload([
        {
          orderId: 'o1',
          lines: [
            line({
              id: 'l1',
              total_cents: 10000,
              allocations: [
                {id: 'a1', allocated_to: 'Ana', quantity_allocated: 0.5, amount_cents: 5000, settled_at: PLACED_AT},
                {id: 'a2', allocated_to: 'Ben', quantity_allocated: 0.5, amount_cents: 5000, settled_at: null},
              ],
            }),
            line({id: 'l2', total_cents: 10000}),
          ],
        },
      ]),
      [order({id: 'o1'})],
    );
    const plan = planFor(rows, new Set(['l1', 'l2']));
    expect(plan.kind).toBe('allocations');
    expect(plan.kind === 'allocations' && plan.settle).toEqual(['a2']);
    expect(plan.kind === 'allocations' && plan.allocate).toEqual([{lineId: 'l2', orderId: 'o1'}]);
    expect(plan.kind === 'allocations' && plan.totalCents).toBe(15000);
  });

  it('does not count a paid line against whole-order coverage', () => {
    // l1 is already paid; ticking only l2 still covers everything collectable on the order.
    const rows = payableLines(
      payload([
        {
          orderId: 'o1',
          lines: [
            line({
              id: 'l1',
              allocations: [
                {id: 'a1', allocated_to: 'Ana', quantity_allocated: 1, amount_cents: 10000, settled_at: PLACED_AT},
              ],
            }),
            line({id: 'l2'}),
          ],
        },
      ]),
      [order({id: 'o1'})],
    );
    // ...but the order HAS been split, so it stays on the allocation route regardless.
    const plan = planFor(rows, new Set(['l2']));
    expect(plan.kind).toBe('allocations');
  });

  it('plans nothing for an empty selection', () => {
    expect(planFor(twoOrders(), new Set())).toEqual({kind: 'nothing'});
  });

  it('plans nothing when only unselectable lines are ticked', () => {
    const rows = payableLines(
      payload([{orderId: 'o1', lines: [line({id: 'l1', total_cents: null})]}]),
      [order({id: 'o1'})],
    );
    expect(planFor(rows, new Set(['l1']))).toEqual({kind: 'nothing'});
  });
});

describe('tabs that cannot be paid item by item', () => {
  it('refuses a tab the server cannot describe line by line', () => {
    expect(canTakePaymentByItem(payload([{orderId: 'o1', lines: [line({id: 'l1'})]}], false))).toBe(
      false,
    );
    expect(canTakePaymentByItem(null)).toBe(false);
    expect(canTakePaymentByItem(payload([]))).toBe(false);
  });

  it('accepts one it can', () => {
    expect(canTakePaymentByItem(payload([{orderId: 'o1', lines: [line({id: 'l1'})]}]))).toBe(true);
  });
});
