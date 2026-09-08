/**
 * THE DEVICE SENDS WHAT IS STILL OWED.
 *
 * ==================================================================================================
 * THE ORPHAN THIS PREVENTS
 * ==================================================================================================
 *
 * The server moved its whole-order charge basis to the outstanding amount. The device kept summing
 * `order.total`, and on a part-paid order the order of operations turns that disagreement into a
 * lost charge rather than a refusal:
 *
 *   1. prepare-payment charges the reader the correct outstanding amount.   MONEY MOVES.
 *   2. the device reports success and calls /settle with the whole total.
 *   3. the server's cross-check refuses it.
 *
 * A real charge with no settlement recorded against it. On the cash path it is less severe and
 * still wrong: a legitimate collection blocked at the till.
 *
 * ==================================================================================================
 * BOUND TO THE PRODUCTION PATH, NOT TO A COPY
 * ==================================================================================================
 *
 * These call selectClaimableOrdersForSettle and selectCashSettleableOrders -- the two functions
 * TableDetailScreen actually calls for the /settle amount -- rather than restating the arithmetic.
 * Reimplementing the rule here would prove the rule and nothing about the code: delete the change
 * and a restatement still passes.
 *
 * A source-level assertion at the bottom pins that the screen PASSES its lines to both, because a
 * correct function that is called without line data silently returns the old figure.
 */
/**
 * This is a React Native project with no @types/node, so the node builtins are declared locally
 * rather than pulling a type package in for one assertion. Jest supplies both at runtime.
 */
declare const require: (mod: string) => unknown;
declare const __dirname: string;
const {readFileSync} = require('fs') as {readFileSync: (p: string, enc: string) => string};
const {join} = require('path') as {join: (...parts: string[]) => string};
import { selectClaimableOrdersForSettle } from '../paymentIntegrity';
import { selectCashSettleableOrders } from '../cashSettlement';
import { outstandingCentsForOrder, settlementAmountFor } from '../settlementAmount';

/**
 * ORDER #45 AT DIGI COFEE, EXACTLY.
 *
 * N$37.00 across seven lines. Two allocations settled for N$17.00 -- one Coffee at N$5.00 and two
 * cheese toast at N$12.00 -- leaving N$20.00: three Cappucinos, one Coffee, and a cheese toast that
 * was allocated but never paid for.
 */
const ORDER_45 = {id: 'o45', total: 37, payment_status: 'pending', can_settle_cash: true};

const LINES_45 = [
  {orderId: 'o45', outstandingCents: 300}, // Cappucino
  {orderId: 'o45', outstandingCents: 300}, // Cappucino
  {orderId: 'o45', outstandingCents: 300}, // Cappucino
  {orderId: 'o45', outstandingCents: 500}, // Coffee, never allocated
  {orderId: 'o45', outstandingCents: 0}, // Coffee, settled
  {orderId: 'o45', outstandingCents: 600}, // cheese toast, allocated but unsettled
  {orderId: 'o45', outstandingCents: 0}, // cheese toast x2, settled
];

// ==================================================================================================
// THE PRODUCTION SHAPE
// ==================================================================================================

describe('order #45: 3700 total, 1700 settled, 2000 outstanding', () => {
  it('the CARD path sends N$20.00, not N$37.00', () => {
    const {amount} = selectClaimableOrdersForSettle([ORDER_45], ['o45'], LINES_45);
    expect(amount).toBe(20);
    expect(amount).not.toBe(37);
  });

  it('the CASH path sends N$20.00, not N$37.00', () => {
    // Cash matters as much: at the till there is no gateway record to reconcile against later.
    const {amount} = selectCashSettleableOrders([ORDER_45], ['o45'], LINES_45);
    expect(amount).toBe(20);
    expect(amount).not.toBe(37);
  });

  it('the two paths agree, exactly', () => {
    const card = selectClaimableOrdersForSettle([ORDER_45], ['o45'], LINES_45).amount;
    const cash = selectCashSettleableOrders([ORDER_45], ['o45'], LINES_45).amount;
    expect(card).toBe(cash);
  });

  it('in cents: 3700 total minus 1700 settled is 2000', () => {
    expect(outstandingCentsForOrder(ORDER_45, LINES_45)).toBe(2000);
    expect(3700 - 1700).toBe(2000);
  });
});

// ==================================================================================================
// POSITIVE CONTROLS: the ordinary order must not change
// ==================================================================================================

describe('an untouched order, where outstanding EQUALS total', () => {
  const ORDINARY = {id: 'o1', total: 122, payment_status: 'pending', can_settle_cash: true};

  it('CARD still sends the full N$122.00 when no line is part-paid', () => {
    /**
     * THE CONTROL THIS SUITE NEEDS. Every other case asserts the figure went DOWN; a change that
     * returned zero, or dropped the fallback, would satisfy them all and quietly stop collecting.
     */
    const lines = [
      {orderId: 'o1', outstandingCents: 600},
      {orderId: 'o1', outstandingCents: 1000},
      {orderId: 'o1', outstandingCents: 10000},
      {orderId: 'o1', outstandingCents: 600},
    ];
    expect(selectClaimableOrdersForSettle([ORDINARY], ['o1'], lines).amount).toBe(122);
  });

  it('CASH still sends the full N$122.00', () => {
    const lines = [{orderId: 'o1', outstandingCents: 12200}];
    expect(selectCashSettleableOrders([ORDINARY], ['o1'], lines).amount).toBe(122);
  });

  it('an order with NO line data at all falls back to its total', () => {
    // A tab the server cannot itemise cannot have been split, so its total IS its outstanding.
    expect(selectClaimableOrdersForSettle([ORDINARY], ['o1']).amount).toBe(122);
    expect(selectClaimableOrdersForSettle([ORDINARY], ['o1'], []).amount).toBe(122);
    expect(selectCashSettleableOrders([ORDINARY], ['o1'], []).amount).toBe(122);
  });

  it('lines belonging to OTHER orders do not reduce this one', () => {
    const foreign = [{orderId: 'someone-else', outstandingCents: 0}];
    expect(selectClaimableOrdersForSettle([ORDINARY], ['o1'], foreign).amount).toBe(122);
  });
});

// ==================================================================================================
// MULTI-ORDER — the reconciliation fix must not regress
// ==================================================================================================

describe('several orders settled together', () => {
  const A = {id: 'a', total: 37, payment_status: 'pending', can_settle_cash: true};
  const B = {id: 'b', total: 10, payment_status: 'pending', can_settle_cash: true};

  const LINES = [
    ...LINES_45.map(l => ({...l, orderId: 'a'})),
    {orderId: 'b', outstandingCents: 1000},
  ];

  it('sums each order OWN outstanding: 2000 + 1000 = N$30.00', () => {
    const {orderIds, amount} = selectClaimableOrdersForSettle([A, B], ['a', 'b'], LINES);
    expect(orderIds).toEqual(['a', 'b']);
    expect(amount).toBe(30);
  });

  it('a part-paid order does not drag down a fully-owed sibling', () => {
    // Clamped per order. Clamping on the sum would let one absorb the other's debt.
    expect(outstandingCentsForOrder(A, LINES)).toBe(2000);
    expect(outstandingCentsForOrder(B, LINES)).toBe(1000);
  });

  it('an over-settled order contributes zero, never a negative', () => {
    const over = {id: 'c', total: 5, payment_status: 'pending'};
    const lines = [{orderId: 'c', outstandingCents: 0}];
    expect(settlementAmountFor([over, B], [...lines, {orderId: 'b', outstandingCents: 1000}])).toBe(10);
  });

  it('the amount and the order ids come from the same filtered set', () => {
    // A non-claimable order must contribute neither an id nor a cent.
    const paid = {id: 'p', total: 99, payment_status: 'paid'};
    const {orderIds, amount} = selectClaimableOrdersForSettle([A, paid], ['a', 'p'], LINES);
    expect(orderIds).toEqual(['a']);
    expect(amount).toBe(20);
  });
});

// ==================================================================================================
// THE GRATUITY IS NOT IN THIS FIGURE
// ==================================================================================================

describe('the gratuity', () => {
  it('never reaches the /settle amount', () => {
    /**
     * The tip rides alongside the bill and is added exactly once, by the server, in
     * prepare-payment (chargeCents = orderCents + tipCents). /settle records what the ITEMS were
     * worth; payment_tips records the rest. There is no tip input to these functions at all --
     * asserted here so a future signature change has to break this test to add one.
     */
    expect(selectClaimableOrdersForSettle.length).toBeLessThanOrEqual(3);
    expect(selectCashSettleableOrders.length).toBeLessThanOrEqual(3);
    const {amount} = selectClaimableOrdersForSettle([ORDER_45], ['o45'], LINES_45);
    expect(amount).toBe(20); // not 30 with a N$10 tip, not 40 with N$20
  });
});

// ==================================================================================================
// BOUND TO THE SCREEN
// ==================================================================================================

describe('the screen passes its line data to both paths', () => {
  const SCREEN = readFileSync(
    join(__dirname, '..', '..', 'screens', 'TableDetailScreen.tsx'),
    'utf8',
  );

  it('the card settle passes payable', () => {
    /**
     * A correct function called WITHOUT lines silently returns the old whole-total figure, and
     * every test above would still pass. This is the assertion that catches that.
     */
    expect(SCREEN).toContain(
      'selectClaimableOrdersForSettle(\n      orders,\n      requestedOrderIds,\n      payable,\n    )',
    );
  });

  it('the cash settle passes payable', () => {
    expect(SCREEN).toContain(
      'selectCashSettleableOrders(\n      orders,\n      requestedOrderIds,\n      payable,\n    )',
    );
  });
});
