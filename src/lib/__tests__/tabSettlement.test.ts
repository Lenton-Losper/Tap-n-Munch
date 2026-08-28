/**
 * The rule that decides what a waiter believes about a table's money.
 *
 * The assertion this file exists for is PAID IS NOT CLOSED. Everything else here supports it:
 * a tab whose every order is paid must come back as a state that is distinguishable from the
 * state of a tab whose session has ended, because the waiter's next action differs completely
 * (keep serving them vs. the table is free).
 */
import {
  amountOwed,
  canOfferSettle,
  deriveTabSettlementState,
  settleableOrderIds,
} from '../tabSettlement';
import type {TabOrder, TableWithTab} from '../../types';

function order(overrides: Partial<TabOrder> & {id: string}): TabOrder {
  return {
    order_number: 1,
    total: 100,
    status: 'completed',
    payment_status: 'unpaid',
    items: [],
    placed_at: '2026-08-28T08:00:00Z',
    ...overrides,
  };
}

function table(
  tabOverrides: Partial<TableWithTab['tab']> | null,
  orders: TabOrder[] = [],
): TableWithTab {
  return {
    id: 'table-9140',
    table_number: 9140,
    status: 'occupied',
    can_close: false,
    tab:
      tabOverrides === null
        ? null
        : {
            id: 'tab-1',
            status: 'open',
            total: 100,
            unpaid_total: 100,
            orders,
            ...tabOverrides,
          },
  };
}

describe('deriveTabSettlementState', () => {
  it('reports a live tab with nothing collected as unpaid', () => {
    expect(
      deriveTabSettlementState(
        table({}, [order({id: 'o1'}), order({id: 'o2'})]),
      ),
    ).toBe('unpaid');
  });

  it('reports a tab with some paid and some owing as partially_paid', () => {
    expect(
      deriveTabSettlementState(
        table({unpaid_total: 100}, [
          order({id: 'o1', payment_status: 'paid'}),
          order({id: 'o2', payment_status: 'unpaid'}),
        ]),
      ),
    ).toBe('partially_paid');
  });

  /**
   * THE ASSERTION THIS MODULE EXISTS FOR.
   *
   * Every order paid, tab status still 'open' — which is exactly the row the settle route
   * leaves behind, because clearReadyToPayAndReopenTab REOPENS the tab after money is taken and
   * never writes settled_at. The state must be 'fully_paid' and it must NOT be 'closed'.
   */
  it('reports a fully paid but still open tab as fully_paid, NEVER as closed', () => {
    const state = deriveTabSettlementState(
      table({status: 'open', unpaid_total: 0}, [
        order({id: 'o1', payment_status: 'paid'}),
        order({id: 'o2', payment_status: 'paid'}),
      ]),
    );
    expect(state).toBe('fully_paid');
    expect(state).not.toBe('closed');
  });

  it('reports a settled tab as closed even when its orders are paid', () => {
    expect(
      deriveTabSettlementState(
        table({status: 'settled', unpaid_total: 0}, [
          order({id: 'o1', payment_status: 'paid'}),
        ]),
      ),
    ).toBe('closed');
  });

  /**
   * The three states are mutually exclusive AND mutually distinguishable. Written as one
   * assertion rather than three because the defect being guarded against is two of them
   * collapsing into the same value, which per-state tests would each still pass.
   */
  it('gives unpaid, partially_paid, fully_paid and closed four distinct values', () => {
    const states = [
      deriveTabSettlementState(table({}, [order({id: 'a'})])),
      deriveTabSettlementState(
        table({}, [
          order({id: 'a', payment_status: 'paid'}),
          order({id: 'b', payment_status: 'unpaid'}),
        ]),
      ),
      deriveTabSettlementState(
        table({unpaid_total: 0}, [order({id: 'a', payment_status: 'paid'})]),
      ),
      deriveTabSettlementState(
        table({status: 'settled', unpaid_total: 0}, [
          order({id: 'a', payment_status: 'paid'}),
        ]),
      ),
    ];
    expect(new Set(states).size).toBe(4);
    expect(states).toEqual(['unpaid', 'partially_paid', 'fully_paid', 'closed']);
  });

  it('treats ready_to_pay as a live tab, not a closed one', () => {
    expect(
      deriveTabSettlementState(table({status: 'ready_to_pay'}, [order({id: 'a'})])),
    ).toBe('unpaid');
  });

  it('answers unknown — not unpaid — when the money payload is missing', () => {
    expect(deriveTabSettlementState(null)).toBe('unknown');
    expect(deriveTabSettlementState(undefined)).toBe('unknown');
  });

  it('answers no_tab for a table with no tab', () => {
    expect(deriveTabSettlementState(table(null))).toBe('no_tab');
  });

  it('fails closed on a tab status this build does not recognise', () => {
    expect(
      deriveTabSettlementState(
        table({status: 'some_future_status'}, [order({id: 'a'})]),
      ),
    ).toBe('closed');
  });

  /**
   * A cancelled order owes nothing and is not paid. It must not be able to hold a tab in
   * 'unpaid' forever, and it must not make an otherwise-unpaid tab look partially paid.
   */
  it('ignores cancelled orders in both directions', () => {
    expect(
      deriveTabSettlementState(
        table({unpaid_total: 0}, [
          order({id: 'a', payment_status: 'paid'}),
          order({id: 'b', payment_status: 'cancelled'}),
        ]),
      ),
    ).toBe('fully_paid');
    expect(
      deriveTabSettlementState(
        table({}, [
          order({id: 'a', payment_status: 'unpaid'}),
          order({id: 'b', payment_status: 'cancelled'}),
        ]),
      ),
    ).toBe('unpaid');
  });
});

describe('canOfferSettle', () => {
  it('offers settle only where money is genuinely owed on a live tab', () => {
    expect(canOfferSettle('unpaid')).toBe(true);
    expect(canOfferSettle('partially_paid')).toBe(true);
  });

  it('withholds settle for fully_paid, closed, no_tab and unknown', () => {
    expect(canOfferSettle('fully_paid')).toBe(false);
    expect(canOfferSettle('closed')).toBe(false);
    expect(canOfferSettle('no_tab')).toBe(false);
    expect(canOfferSettle('unknown')).toBe(false);
  });
});

describe('amountOwed', () => {
  /**
   * The figure must be the server's unpaid_total and must not be reconstructed from the orders.
   * The fixture below is deliberately contradictory — three orders of 100 each, all unpaid,
   * against an unpaid_total of 250 (a discount the device knows nothing about). A client-side
   * sum answers 300 and disagrees with the bill the customer is looking at.
   */
  it("returns the server's unpaid_total, never a sum of the order totals", () => {
    expect(
      amountOwed(
        table({unpaid_total: 250}, [
          order({id: 'a', total: 100}),
          order({id: 'b', total: 100}),
          order({id: 'c', total: 100}),
        ]),
      ),
    ).toBe(250);
  });

  it('returns null rather than 0 when there is no figure to report', () => {
    expect(amountOwed(null)).toBeNull();
    expect(amountOwed(table(null))).toBeNull();
    expect(
      amountOwed(table({unpaid_total: undefined as unknown as number}, [])),
    ).toBeNull();
  });

  it('reports a genuine zero as zero', () => {
    expect(amountOwed(table({unpaid_total: 0}, []))).toBe(0);
  });
});

describe('settleableOrderIds', () => {
  it("takes the server's per-order affordances and does not re-derive them", () => {
    expect(
      settleableOrderIds(
        table({}, [
          order({id: 'card', can_settle_card: true, can_settle_cash: false}),
          order({id: 'cash', can_settle_card: false, can_settle_cash: true}),
          order({id: 'neither', can_settle_card: false, can_settle_cash: false}),
        ]),
      ),
    ).toEqual(['card', 'cash']);
  });

  /**
   * An order whose payment_status LOOKS settleable but which the server declined to mark as
   * settleable must not be offered. This is the drift the module refuses to introduce.
   */
  it('excludes an unpaid order the server did not mark settleable', () => {
    expect(
      settleableOrderIds(
        table({}, [
          order({
            id: 'looks-unpaid',
            payment_status: 'unpaid',
            can_settle_card: false,
            can_settle_cash: false,
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('excludes orders from a server that predates the affordance fields', () => {
    expect(settleableOrderIds(table({}, [order({id: 'legacy'})]))).toEqual([]);
  });
});

/**
 * ZERO OWED BECAUSE CANCELLED IS NOT ZERO OWED BECAUSE PAID.
 *
 * PRODUCTION, Digi Cofee Table 1, 2026-08-28: the stale-payment sweep cancelled orders #30, #31
 * and #32 (NAD 3 + 5 + 11) two to three minutes after each was placed. `paid_at` was null on all
 * three and the kitchen had already cooked the food. Nothing was owed because nothing was
 * billable, so `deriveTabSettlementState` returned `fully_paid` and the screen told the waiter
 * the bill was settled.
 *
 * THE CONTROLS ARE THE POINT. "A cancelled tab is not fully_paid" passes trivially if the
 * function stops returning `fully_paid` at all. Every case below is paired with a genuinely paid
 * tab that MUST still be `fully_paid`.
 */
describe('a tab whose orders were all cancelled is not paid', () => {
  it('reports nothing_billed, not fully_paid, from the server counts', () => {
    expect(
      deriveTabSettlementState(
        table({
          unpaid_total: 0,
          paid_order_count: 0,
          unpaid_order_count: 0,
          billable_order_count: 0,
          order_count: 3,
        }),
      ),
    ).toBe('nothing_billed');
  });

  it('CONTROL: a genuinely settled tab still reports fully_paid', () => {
    expect(
      deriveTabSettlementState(
        table({
          unpaid_total: 0,
          paid_order_count: 2,
          unpaid_order_count: 0,
          billable_order_count: 2,
          order_count: 2,
        }),
      ),
    ).toBe('fully_paid');
  });

  it('falls back to scanning orders when the server sends no counts', () => {
    expect(
      deriveTabSettlementState(
        table({unpaid_total: 0}, [
          {id: 'o1', payment_status: 'cancelled'} as TabOrder,
          {id: 'o2', payment_status: 'cancelled'} as TabOrder,
        ]),
      ),
    ).toBe('nothing_billed');
  });

  it('CONTROL: the same fallback still reports a paid tab as fully_paid', () => {
    expect(
      deriveTabSettlementState(
        table({unpaid_total: 0}, [{id: 'o1', payment_status: 'paid'} as TabOrder]),
      ),
    ).toBe('fully_paid');
  });

  it('does not offer to settle a tab where there is nothing to charge for', () => {
    expect(canOfferSettle('nothing_billed')).toBe(false);
  });
});
