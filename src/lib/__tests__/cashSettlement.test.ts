/**
 * Cash settlement client behaviour.
 *
 * The two things most worth pinning down:
 *  1. staff-readable copy for every error code in the settle contract, and
 *  2. that cash eligibility is taken FROM THE SERVER, never re-derived from
 *     payment_status on the client. A second definition here is exactly how the
 *     client and the server drift apart.
 */
import {
  formatNadAmount,
  staffMessageForSettleFailure,
} from '../staffApiErrors';

type OrderLike = {
  id: string;
  total: number;
  payment_status: string;
  can_settle_cash?: boolean;
  card_payment_in_flight?: boolean;
};

/** Mirrors TableDetailScreen's selection: server flag only, strictly true. */
function selectCashSettleable(orders: OrderLike[], requested: string[]) {
  const eligible = orders.filter(
    o => requested.includes(o.id) && o.can_settle_cash === true,
  );
  return {
    orderIds: eligible.map(o => o.id),
    amount: eligible.reduce((sum, o) => sum + o.total, 0),
  };
}

describe('cash settle error copy', () => {
  it('tells staff what to do when a card payment is in flight', () => {
    const msg = staffMessageForSettleFailure({
      status: 409,
      message: 'raw server text',
      code: 'CARD_PAYMENT_IN_FLIGHT',
      retryAfterSeconds: 45,
    });
    expect(msg).toContain('card payment is already in progress');
    expect(msg).toContain('45 seconds');
    // Never leak the raw code or raw server text to a staff member.
    expect(msg).not.toContain('CARD_PAYMENT_IN_FLIGHT');
    expect(msg).not.toContain('raw server text');
  });

  it('rounds the in-flight wait up to whole minutes past 60s', () => {
    const msg = staffMessageForSettleFailure({
      status: 409,
      message: '',
      code: 'CARD_PAYMENT_IN_FLIGHT',
      retryAfterSeconds: 90,
    });
    expect(msg).toContain('2 minutes');
  });

  it('still gives a next step when no retry window is supplied', () => {
    const msg = staffMessageForSettleFailure({
      status: 409,
      message: '',
      code: 'CARD_PAYMENT_IN_FLIGHT',
    });
    expect(msg).toContain('cancel the card payment');
  });

  it('has distinct copy for already-paid and not-settleable', () => {
    const paid = staffMessageForSettleFailure({
      status: 409,
      message: '',
      code: 'ALREADY_PAID',
    });
    const notSettleable = staffMessageForSettleFailure({
      status: 409,
      message: '',
      code: 'NOT_SETTLEABLE',
    });
    expect(paid).toContain('already been paid');
    expect(notSettleable).toContain('cannot be settled');
    // These mean different things to a staff member and must not collapse.
    expect(paid).not.toEqual(notSettleable);
  });

  it('states the expected amount on a mismatch', () => {
    const msg = staffMessageForSettleFailure({
      status: 400,
      message: '',
      code: 'AMOUNT_MISMATCH',
      expected: 64,
    });
    expect(msg).toContain(formatNadAmount(64));
  });

  it('covers the remaining contract codes in plain language', () => {
    for (const code of [
      'UNSUPPORTED_PAYMENT_METHOD',
      'AUTHORIZATION_INVALID',
      'ATTRIBUTION_INCOMPLETE',
    ]) {
      const msg = staffMessageForSettleFailure({
        status: 400,
        message: '',
        code,
      });
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toContain(code);
    }
  });

  it('falls back to the server message for unknown codes', () => {
    const msg = staffMessageForSettleFailure({
      status: 500,
      message: 'Something specific from the server',
      code: 'SOME_NEW_CODE',
    });
    expect(msg).toBe('Something specific from the server');
  });
});

describe('cash eligibility comes from the server', () => {
  const orders: OrderLike[] = [
    {id: 'a', total: 40, payment_status: 'pending', can_settle_cash: true},
    {
      id: 'b',
      total: 25,
      payment_status: 'cash_pending',
      can_settle_cash: true,
    },
    {
      id: 'c',
      total: 55,
      payment_status: 'terminal_pending',
      can_settle_cash: false,
      card_payment_in_flight: true,
    },
    {id: 'd', total: 10, payment_status: 'paid', can_settle_cash: false},
  ];

  it('includes only orders the server marked cash-settleable', () => {
    const {orderIds, amount} = selectCashSettleable(orders, ['a', 'b', 'c', 'd']);
    expect(orderIds).toEqual(['a', 'b']);
    expect(amount).toBe(65);
  });

  it('excludes an order with a live card payment even if selected', () => {
    const {orderIds, amount} = selectCashSettleable(orders, ['c']);
    expect(orderIds).toEqual([]);
    expect(amount).toBe(0);
  });

  it('does not infer eligibility from payment_status when the flag is absent', () => {
    // An older server omits the field. 'pending' looks settleable, but without the
    // server saying so the client must not decide for itself.
    const legacy: OrderLike[] = [{id: 'x', total: 30, payment_status: 'pending'}];
    expect(selectCashSettleable(legacy, ['x']).orderIds).toEqual([]);
  });

  it('derives the amount from the same set it sends, so the two cannot disagree', () => {
    const {orderIds, amount} = selectCashSettleable(orders, ['a', 'c']);
    const recomputed = orders
      .filter(o => orderIds.includes(o.id))
      .reduce((s, o) => s + o.total, 0);
    expect(amount).toBe(recomputed);
    expect(amount).toBe(40);
  });
});
