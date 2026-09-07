/**
 * WHO IS THE AUTHORITY ON "PAID": THE ORDER, OR THE ITEM LEDGER?
 *
 * ==================================================================================================
 * THE PRODUCTION SHAPES THIS PINS
 * ==================================================================================================
 *
 * Two orders at Digi Cofee on 2026-09-07 sit on opposite sides of this question, and both are
 * legitimate. Neither may be represented as the other.
 *
 *   #47   N$122.00, paid whole by card via /settle (a real payments row for the full amount).
 *         FOUR allocations exist -- someone had started splitting it -- and NONE were settled,
 *         because the money never went through the item ledger. Every line IS paid.
 *
 *   #45   N$37.00, part-paid by a split card charge. TWO of three allocations settled, N$17.00.
 *         Five lines still owe N$20.00. Only the two settled lines are paid.
 *
 * The distinction matters because it decides whether a waiter is offered a plate of food for sale
 * a second time. Read the ledger alone and #47 is offered again in full -- N$122.00 already
 * collected. Read the order alone and #45's five unpaid items vanish.
 *
 * ==================================================================================================
 * WHY THIS IS A PRESENTATION RULE AND NOT A LEDGER REPAIR
 * ==================================================================================================
 *
 * #47's allocations are not wrong. They record that a split was STARTED, not that money was owed
 * through it; the charge went down the whole-order route and is recorded in `payments`. Writing
 * settlement rows against them to make a screen agree would invent ledger entries for a payment
 * that never passed through that ledger -- and those rows would then be indistinguishable from a
 * real split settlement in every report that reads them.
 *
 * So the ORDER's own payment_status is the authority, and the ledger refines it downward only for
 * orders the order-level status has not already answered. That rule already exists in
 * payableLines; this file is the coverage it was missing for the exact shape #47 has -- a PAID
 * order that DOES carry allocations, none of them settled. The existing case covers a paid order
 * with no allocations at all, which is the easy half.
 */
import {outstandingTotalCents, payableLines, planFor} from '../takePaymentLines';
import type {TabLine, TabLinesPayload} from '../tabLines';
import type {TabOrder} from '../../types';

const PLACED_AT = '2026-09-07T03:21:03.881Z';

function line(over: Partial<TabLine> & {id: string}): TabLine {
  return {
    name_snapshot: 'Item',
    quantity: 1,
    line_note: null,
    route_to: 'kitchen',
    kitchen_state: 'outstanding',
    bar_state: null,
    is_ready: false,
    is_voided: false,
    unrouted: false,
    total_cents: 1000,
    allocations: [],
    ...over,
  } as TabLine;
}

function order(over: Partial<TabOrder> & {id: string}): TabOrder {
  return {
    order_number: 1,
    total: 100,
    status: 'pending',
    payment_status: 'pending',
    items: [],
    placed_at: PLACED_AT,
    ...over,
  } as TabOrder;
}

function payload(orderId: string, lines: TabLine[]): TabLinesPayload {
  return {
    tab: {
      id: 'tab-1',
      table_number: 1,
      status: 'open',
      total: 0,
      opened_at: PLACED_AT,
      opened_by_user_id: 'user-1',
    },
    orders: [
      {
        order_id: orderId,
        order_number: 47,
        order_instructions: null,
        order_total: 0,
        placed_at: PLACED_AT,
        seconds_since_placed: 60,
        lines,
      },
    ],
    summary: {total_lines: lines.length, outstanding: 0, ready: 0, voided: 0},
    all_ready: false,
    has_lines: true,
    server_time: null,
  } as unknown as TabLinesPayload;
}

const alloc = (id: string, cents: number, settledAt: string | null) => ({
  id,
  allocated_to: 'Table',
  quantity_allocated: 1,
  amount_cents: cents,
  settled_at: settledAt,
});

// ==================================================================================================
// A — a whole-order payment
// ==================================================================================================

describe('A. order #47: N$122.00 paid whole, four allocations, none settled', () => {
  const LINES = [
    line({id: 'l-capp', name_snapshot: 'Cappucino', total_cents: 600, allocations: [alloc('a1', 600, null)]}),
    line({id: 'l-coffee', name_snapshot: 'Coffee', total_cents: 1000, allocations: [alloc('a2', 1000, null)]}),
    line({id: 'l-cheese', name_snapshot: 'cheese', total_cents: 10000, allocations: [alloc('a3', 10000, null)]}),
    line({id: 'l-toast', name_snapshot: 'cheese toast', total_cents: 600, allocations: [alloc('a4', 600, null)]}),
  ];
  const ORDERS = [order({id: 'o47', order_number: 47, total: 122, status: 'completed', payment_status: 'paid'})];

  it('shows every line as paid, though not one allocation is settled', () => {
    const lines = payableLines(payload('o47', LINES), ORDERS);
    expect(lines).toHaveLength(4);
    for (const l of lines) {
      expect(l.isPaid).toBe(true);
      expect(l.settledCents).toBe(0); // the ledger genuinely holds nothing
      expect(l.outstandingCents).toBe(0); // and it is still fully paid
    }
  });

  it('offers none of it for sale a second time', () => {
    // THE POINT. Reading the ledger alone would offer N$122.00 of already-paid food again.
    const lines = payableLines(payload('o47', LINES), ORDERS);
    expect(lines.every(l => l.selectable)).toBe(false);
    expect(lines.some(l => l.selectable)).toBe(false);
    expect(outstandingTotalCents(lines)).toBe(0);
  });

  it('invents no allocation settlement to say so', () => {
    // The rule is a presentation rule. The ledger it reports is untouched: four open allocations.
    const lines = payableLines(payload('o47', LINES), ORDERS);
    expect(lines.flatMap(l => l.openAllocationIds).sort()).toEqual(['a1', 'a2', 'a3', 'a4']);
  });
});

// ==================================================================================================
// B — an allocation payment
// ==================================================================================================

describe('B. order #45: N$17.00 settled of N$37.00, by allocation', () => {
  /** The real shape: 7 lines, 3 allocated, 2 settled. */
  const LINES = [
    line({id: 'l1', name_snapshot: 'Cappucino', total_cents: 300}),
    line({id: 'l2', name_snapshot: 'Cappucino', total_cents: 300}),
    line({id: 'l3', name_snapshot: 'Cappucino', total_cents: 300}),
    line({id: 'l4', name_snapshot: 'Coffee', total_cents: 500}),
    line({id: 'l5', name_snapshot: 'Coffee', total_cents: 500, allocations: [alloc('a-coffee', 500, '2026-09-07T12:37:23.557Z')]}),
    line({id: 'l6', name_snapshot: 'cheese toast', total_cents: 600, allocations: [alloc('a-toast1', 600, null)]}),
    line({id: 'l7', name_snapshot: 'cheese toast', total_cents: 1200, allocations: [alloc('a-toast2', 1200, '2026-09-07T12:37:23.557Z')]}),
  ];
  const ORDERS = [order({id: 'o45', order_number: 45, total: 37, payment_status: 'pending'})];

  it('marks exactly the two settled lines paid, and no others', () => {
    const lines = payableLines(payload('o45', LINES), ORDERS);
    const paid = lines.filter(l => l.isPaid).map(l => l.id);
    expect(paid.sort()).toEqual(['l5', 'l7']);
  });

  it('leaves exactly N$20.00 outstanding', () => {
    /**
     * 300 + 300 + 300 + 500 (never allocated) + 600 (allocated, unsettled) = 2000c.
     * The gratuity is not in this number and must never be.
     */
    const lines = payableLines(payload('o45', LINES), ORDERS);
    expect(outstandingTotalCents(lines)).toBe(2000);
  });

  it('still offers the allocated-but-unsettled line — allocating is not paying', () => {
    const lines = payableLines(payload('o45', LINES), ORDERS);
    const toast = lines.find(l => l.id === 'l6')!;
    expect(toast.isPaid).toBe(false);
    expect(toast.settledCents).toBe(0);
    expect(toast.outstandingCents).toBe(600);
    expect(toast.selectable).toBe(true);
  });
});

// ==================================================================================================
// C — mixed
// ==================================================================================================

describe('C. a part-paid order keeps its unpaid items sellable', () => {
  it('a half-settled line owes exactly its unsettled half', () => {
    const LINES = [
      line({
        id: 'half',
        total_cents: 1000,
        allocations: [alloc('s', 400, '2026-09-07T12:00:00Z'), alloc('o', 600, null)],
      }),
    ];
    const lines = payableLines(payload('oX', LINES), [order({id: 'oX', payment_status: 'pending'})]);
    expect(lines[0].isPaid).toBe(false);
    expect(lines[0].settledCents).toBe(400);
    expect(lines[0].outstandingCents).toBe(600);
  });

  it('routes a part-paid order down the allocation path, not the whole-order path', () => {
    // Sending it whole would charge the original total again -- the money-path hazard.
    const LINES = [
      line({id: 'paid', total_cents: 500, allocations: [alloc('s', 500, '2026-09-07T12:00:00Z')]}),
      line({id: 'owed', total_cents: 500}),
    ];
    const lines = payableLines(payload('oY', LINES), [order({id: 'oY', payment_status: 'pending'})]);
    const plan = planFor(lines, new Set(['owed']));
    expect(plan.kind).toBe('allocations');
  });
});

// ==================================================================================================
// D — the gratuity
// ==================================================================================================

describe('D. a gratuity never marks an item paid', () => {
  it('N$17.00 of items plus a N$20.00 tip still leaves N$20.00 of items owed', () => {
    /**
     * ORDER #45 EXACTLY. The reader was charged N$37.00 -- 1700c of items plus a 2000c gratuity --
     * and 1700 + 2000 happens to equal the N$37.00 order total. That coincidence is what closed
     * this order wrongly at the webhook.
     *
     * A gratuity is not an allocation and cannot become one: it lives in payment_tips and never
     * appears in `line.allocations`, so there is no path by which it can settle an item. This
     * asserts the consequence -- the outstanding figure is unmoved by the tip's existence.
     */
    const LINES = [
      line({id: 'p1', total_cents: 500, allocations: [alloc('s1', 500, '2026-09-07T12:37:23.557Z')]}),
      line({id: 'p2', total_cents: 1200, allocations: [alloc('s2', 1200, '2026-09-07T12:37:23.557Z')]}),
      line({id: 'owed1', total_cents: 900}),
      line({id: 'owed2', total_cents: 500}),
      line({id: 'owed3', total_cents: 600, allocations: [alloc('open', 600, null)]}),
    ];
    const lines = payableLines(payload('o45', LINES), [order({id: 'o45', total: 37, payment_status: 'pending'})]);

    const settled = lines.reduce((s, l) => s + l.settledCents, 0);
    expect(settled).toBe(1700);
    expect(outstandingTotalCents(lines)).toBe(2000);
    expect(settled + outstandingTotalCents(lines)).toBe(3700); // the order total, tip excluded
  });

  it('no line reports a settled amount larger than the allocations on it', () => {
    // The shape a tip would have to take to leak in. It cannot: nothing adds to settledCents but
    // an allocation carrying settled_at.
    const LINES = [line({id: 'l', total_cents: 500, allocations: [alloc('s', 500, '2026-09-07T12:00:00Z')]})];
    const lines = payableLines(payload('o', LINES), [order({id: 'o', payment_status: 'pending'})]);
    expect(lines[0].settledCents).toBe(500);
  });
});
