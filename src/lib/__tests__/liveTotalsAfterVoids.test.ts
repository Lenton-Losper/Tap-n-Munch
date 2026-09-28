/**
 * WHAT A TABLE OWES AFTER VOIDS -- sprint 2026-09-28.
 *
 * `amend_order_lines` never rewrites the original order: a void marks the line voided and a
 * reduction adds a REPLACEMENT order carrying the surviving quantity. `orders.total` therefore keeps
 * counting voided food, and summing it across a tab counts a reduced line twice. The device's
 * settle amount used to fall back to the full `order.total` whenever an order had no payable lines
 * -- which is exactly the shape of a fully voided order.
 *
 * Every assertion here goes through the functions the screens call (selectClaimableOrdersForSettle,
 * selectCashSettleableOrders, orderMoney, tabRunningTotal, resolveOrderMoney), never a restatement.
 *
 * MUTATIONS (run by hand, recorded in the sprint report):
 *   M1  settlementAmount.ts: skip the voided-line subtraction in orderMoney's line fallback (the
 *       "fully voided order owes its full total" shape) -> the fully-voided, partial-void and
 *       Riviera "financials absent" cases go RED.
 *   M2  settlementAmount.ts: ignore `basis.financials` and always derive from order.total/lines
 *       -> every "financials present" case goes RED (the server's figure disagrees on purpose).
 */
import {selectClaimableOrdersForSettle} from '../paymentIntegrity';
import {selectCashSettleableOrders} from '../cashSettlement';
import {
  orderMoney,
  orderMoneyWithoutTab,
  outstandingCentsForOrder,
  settlementAmountFor,
} from '../settlementAmount';
import {resolveOrderMoney} from '../orderLiveMoney';
import {tabRunningTotal} from '../tabLines';
import {line, money, noLinesPayload, payloadWith} from './helpers/linesPayload';

const unpaid = (id: string, total: number) => ({
  id,
  total,
  status: 'completed',
  payment_status: 'unpaid',
  can_settle_cash: true,
});

// ==================================================================================================
// A FULLY VOIDED ORDER OWES NOTHING
// ==================================================================================================

describe('a fully voided order', () => {
  const ORDER = unpaid('o1', 120);
  const PAYLOAD = payloadWith([
    {
      id: 'o1',
      total: 120,
      lines: [line({cents: 8000, voided: true}), line({cents: 4000, voided: true})],
    },
  ]);

  it('contributes 0 to the card settle, never its N$120 original', () => {
    const {amount} = selectClaimableOrdersForSettle([ORDER], ['o1'], PAYLOAD);
    expect(amount).toBe(0);
  });

  it('contributes 0 to the cash settle', () => {
    expect(selectCashSettleableOrders([ORDER], ['o1'], PAYLOAD).amount).toBe(0);
  });

  it('reads original 12000, live 0', () => {
    expect(orderMoney(ORDER, PAYLOAD)).toMatchObject({
      originalCents: 12000,
      voidedCents: 12000,
      liveCents: 0,
      outstandingCents: 0,
      source: 'lines',
    });
  });

  it('does not inflate a sibling order it is settled with', () => {
    const sibling = unpaid('o2', 50);
    const payload = payloadWith([
      {id: 'o1', total: 120, lines: [line({cents: 12000, voided: true})]},
      {id: 'o2', total: 50, lines: [line({cents: 5000})]},
    ]);
    expect(settlementAmountFor([ORDER, sibling], payload)).toBe(50);
  });
});

// ==================================================================================================
// A PARTIAL VOID
// ==================================================================================================

describe('a partially voided order', () => {
  const ORDER = unpaid('o1', 100);

  it('owes original minus the voided line', () => {
    const payload = payloadWith([
      {id: 'o1', total: 100, lines: [line({cents: 6000}), line({cents: 4000, voided: true})]},
    ]);
    expect(outstandingCentsForOrder(ORDER, payload)).toBe(6000);
    expect(selectClaimableOrdersForSettle([ORDER], ['o1'], payload).amount).toBe(60);
  });

  it('and minus anything already settled against its live lines', () => {
    const payload = payloadWith([
      {
        id: 'o1',
        total: 100,
        lines: [line({cents: 6000, settledCents: 2500}), line({cents: 4000, voided: true})],
      },
    ]);
    expect(orderMoney(ORDER, payload)).toMatchObject({
      liveCents: 6000,
      paidCents: 2500,
      outstandingCents: 3500,
    });
  });

  it('a voided line nobody priced makes the order UNKNOWN, never a guess', () => {
    const payload = payloadWith([
      {id: 'o1', total: 100, lines: [line({cents: 6000}), line({cents: null, voided: true})]},
    ]);
    expect(orderMoney(ORDER, payload)).toBeNull();
    expect(selectClaimableOrdersForSettle([ORDER], ['o1'], payload).amount).toBeNull();
  });

  it('an unpriced LIVE line does not reduce what is owed (the subtraction never reads it)', () => {
    const payload = payloadWith([
      {id: 'o1', total: 100, lines: [line({cents: null}), line({cents: 4000, voided: true})]},
    ]);
    expect(outstandingCentsForOrder(ORDER, payload)).toBe(6000);
  });

  it('a cancelled order owes nothing, whatever its stored total', () => {
    const payload = payloadWith([{id: 'o1', total: 100, lines: [line({cents: 10000})]}]);
    expect(orderMoney({...ORDER, status: 'cancelled'}, payload)?.outstandingCents).toBe(0);
  });
});

// ==================================================================================================
// RIVIERA, AS IN THE SPRINT BRIEF
// ==================================================================================================

/**
 * One order: Modena 240, Wish You Were Here 2x = 380, Salmon 2x = 920, Burger 2x = 180, Jameson 80,
 * Hansa 80, Soft 35, Mixers 30 -- N$1,945. Then WYWH, Burger and Salmon are reduced 2 -> 1: each
 * ORIGINAL line is voided whole, and three replacement orders carry one unit each at half the line.
 *
 * Payable: 1945 - 380 - 920 - 180 = 465 on the original, plus 190 + 460 + 90 = 1,205.
 * The wrong answers this pins against: 1,945 (the original alone) and 2,685 (1,945 + 740).
 */
function riviera(opts: {modenaCancelled?: boolean} = {}) {
  const original = [
    line({id: 'modena', name: 'Modena', cents: 24000, voided: opts.modenaCancelled === true}),
    line({id: 'wywh', name: 'Wish You Were Here', quantity: 2, cents: 38000, voided: true}),
    line({id: 'salmon', name: 'Salmon', quantity: 2, cents: 92000, voided: true}),
    line({id: 'burger', name: 'Burger', quantity: 2, cents: 18000, voided: true}),
    line({id: 'jameson', name: 'Jameson', cents: 8000}),
    line({id: 'hansa', name: 'Hansa', cents: 8000}),
    line({id: 'soft', name: 'Soft drink', cents: 3500}),
    line({id: 'mixers', name: 'Mixers', cents: 3000}),
  ];
  const orders = [
    unpaid('orig', 1945),
    unpaid('r-wywh', 190),
    unpaid('r-salmon', 460),
    unpaid('r-burger', 90),
  ];
  const lines = [
    {id: 'orig', total: 1945, lines: original},
    {id: 'r-wywh', total: 190, lines: [line({name: 'Wish You Were Here', cents: 19000})]},
    {id: 'r-salmon', total: 460, lines: [line({name: 'Salmon', cents: 46000})]},
    {id: 'r-burger', total: 90, lines: [line({name: 'Burger', cents: 9000})]},
  ];
  const origVoided = 38000 + 92000 + 18000 + (opts.modenaCancelled ? 24000 : 0);
  const origLive = 194500 - origVoided;
  const financials = {
    tab: money({original_cents: 194500 + 74000, voided_cents: origVoided}),
    orders: {
      orig: money({original_cents: 194500, voided_cents: origVoided}),
      'r-wywh': money({original_cents: 19000}),
      'r-salmon': money({original_cents: 46000}),
      'r-burger': money({original_cents: 9000}),
    },
  };
  return {orders, lines, origLive, financials};
}

describe('Riviera: three reductions, then Modena cancelled', () => {
  const ALL = ['orig', 'r-wywh', 'r-salmon', 'r-burger'];

  describe.each([
    ['financials ABSENT (older server, derived from the lines)', false],
    ['financials PRESENT (the server is the authority)', true],
  ])('%s', (_label, withFinancials) => {
    it('the tab is payable for N$1,205 -- not 1,945, not 2,685', () => {
      const r = riviera();
      const payload = payloadWith(r.lines, withFinancials ? r.financials : undefined);
      const card = selectClaimableOrdersForSettle(r.orders, ALL, payload).amount;
      const cash = selectCashSettleableOrders(r.orders, ALL, payload).amount;
      expect(card).toBe(1205);
      expect(cash).toBe(1205);
      expect(card).not.toBe(1945);
      expect(card).not.toBe(2685);
    });

    it('the original order alone is N$465', () => {
      const r = riviera();
      const payload = payloadWith(r.lines, withFinancials ? r.financials : undefined);
      expect(r.origLive).toBe(46500);
      expect(outstandingCentsForOrder(r.orders[0], payload)).toBe(46500);
      expect(orderMoney(r.orders[0], payload)).toMatchObject({
        originalCents: 194500,
        liveCents: 46500,
      });
    });

    it('after Modena is cancelled the tab is payable for N$965', () => {
      const r = riviera({modenaCancelled: true});
      const payload = payloadWith(r.lines, withFinancials ? r.financials : undefined);
      expect(selectClaimableOrdersForSettle(r.orders, ALL, payload).amount).toBe(965);
    });
  });

  it('the tab header reads the server live total when financials are sent', () => {
    const r = riviera();
    const payload = payloadWith(r.lines, r.financials);
    expect(tabRunningTotal({...payload, tab: {...payload.tab, total: 2685}})).toBe(1205);
  });

  it('without financials the header shows the server tab.total as sent (not corrected on device)', () => {
    const r = riviera();
    const payload = payloadWith(r.lines);
    expect(tabRunningTotal({...payload, tab: {...payload.tab, total: 1205}})).toBe(1205);
  });
});

// ==================================================================================================
// THE SERVER'S FIGURE WINS
// ==================================================================================================

describe('financials present are authoritative', () => {
  const ORDER = unpaid('o1', 100);

  it('uses outstanding_cents even when the lines would say otherwise', () => {
    // Server: N$100 original, N$30 voided by an order-level rule the device cannot see, N$10 paid.
    const payload = payloadWith(
      [{id: 'o1', total: 100, lines: [line({cents: 10000})]}],
      {
        tab: money({original_cents: 10000, voided_cents: 3000, paid_cents: 1000}),
        orders: {o1: money({original_cents: 10000, voided_cents: 3000, paid_cents: 1000})},
      },
    );
    expect(outstandingCentsForOrder(ORDER, payload)).toBe(6000);
    expect(selectClaimableOrdersForSettle([ORDER], ['o1'], payload).amount).toBe(60);
    expect(orderMoney(ORDER, payload)?.source).toBe('server');
  });

  it('an order the server block does not mention is UNKNOWN, not its total', () => {
    const payload = noLinesPayload({tab: money({original_cents: 0}), orders: {}});
    expect(outstandingCentsForOrder(ORDER, payload)).toBeNull();
    expect(selectClaimableOrdersForSettle([ORDER], ['o1'], payload).amount).toBeNull();
  });

  it('one unknown order makes the whole settle unknown', () => {
    const payload = noLinesPayload({
      tab: money({original_cents: 10000}),
      orders: {o1: money({original_cents: 10000})},
    });
    expect(settlementAmountFor([ORDER, unpaid('o2', 5)], payload)).toBeNull();
  });
});

// ==================================================================================================
// THE SINGLE-ORDER SCREENS
// ==================================================================================================

describe('resolveOrderMoney (Order detail, Charge)', () => {
  it('an order on no tab owes its total -- voids are tab-scoped', async () => {
    const fetchLines = jest.fn();
    const state = await resolveOrderMoney({id: 'w1', total: 42.5}, 'jwt', fetchLines);
    expect(state).toEqual({kind: 'known', money: orderMoneyWithoutTab({id: 'w1', total: 42.5})});
    expect(state.kind === 'known' && state.money.outstandingCents).toBe(4250);
    expect(fetchLines).not.toHaveBeenCalled();
  });

  it('an order on a tab reads the tab lines and gets its live figure', async () => {
    const r = riviera();
    const fetchLines = jest.fn(async () => payloadWith(r.lines, r.financials));
    const state = await resolveOrderMoney({id: 'orig', total: 1945, tab_id: 'tab-9'}, 'jwt', fetchLines);
    expect(fetchLines).toHaveBeenCalledWith('tab-9', 'jwt');
    expect(state).toMatchObject({kind: 'known', money: {originalCents: 194500, outstandingCents: 46500}});
  });

  it('a failed read is UNAVAILABLE, never the stored total', async () => {
    const fetchLines = jest.fn(async () => {
      throw new Error('network');
    });
    const state = await resolveOrderMoney({id: 'orig', total: 1945, tab_id: 'tab-9'}, 'jwt', fetchLines);
    expect(state).toEqual({kind: 'unavailable'});
  });

  it('a fully voided order on a tab resolves to 0 owed', async () => {
    const payload = payloadWith([
      {id: 'o1', total: 120, lines: [line({cents: 12000, voided: true})]},
    ]);
    const state = await resolveOrderMoney({id: 'o1', total: 120, tab_id: 't'}, 'jwt', async () => payload);
    expect(state).toMatchObject({kind: 'known', money: {liveCents: 0, outstandingCents: 0}});
  });
});
