import {
  isCashSettleablePaymentStatus,
  isClaimablePaymentStatus,
  isMidFlightCardPayment,
  owesMoney,
  selectClaimableOrdersForSettle,
} from '../paymentIntegrity';

describe('isClaimablePaymentStatus', () => {
  it.each(['unpaid', 'pending', 'UNPAID', ' Pending '])(
    'treats %j as claimable',
    status => {
      expect(isClaimablePaymentStatus(status)).toBe(true);
    },
  );

  it.each(['paid', 'cancelled', 'refunded', '', null, undefined])(
    'treats %j as NOT claimable',
    status => {
      expect(isClaimablePaymentStatus(status)).toBe(false);
    },
  );
});

describe('selectClaimableOrdersForSettle', () => {
  const orders = [
    {id: 'order-unpaid', total: 100, payment_status: 'unpaid'},
    {id: 'order-pending', total: 50, payment_status: 'pending'},
    {id: 'order-cancelled', total: 9999, payment_status: 'cancelled'},
    {id: 'order-paid', total: 75, payment_status: 'paid'},
  ];

  it('sums only the claimable orders into amount — a cancelled order can never reach the card charge', () => {
    const result = selectClaimableOrdersForSettle(orders, [
      'order-unpaid',
      'order-pending',
      'order-cancelled',
    ]);

    // The cancelled order's 9999 total must never be added in, even though
    // its id was passed in — this is the exact overcharge this filter exists
    // to prevent.
    expect(result.amount).toBe(150);
    expect(result.orderIds).toEqual(['order-unpaid', 'order-pending']);
    expect(result.orderIds).not.toContain('order-cancelled');
  });

  it('excludes an already-paid order from the total even if selected', () => {
    const result = selectClaimableOrdersForSettle(orders, [
      'order-unpaid',
      'order-paid',
    ]);

    expect(result.amount).toBe(100);
    expect(result.orderIds).toEqual(['order-unpaid']);
  });

  it('returns a zero amount and empty id list when every requested order is non-claimable', () => {
    const result = selectClaimableOrdersForSettle(orders, [
      'order-cancelled',
      'order-paid',
    ]);

    expect(result.amount).toBe(0);
    expect(result.orderIds).toEqual([]);
    expect(result.orders).toEqual([]);
  });

  it('keeps orderIds and amount in agreement so the card charge and the settleTab call always match', () => {
    const result = selectClaimableOrdersForSettle(orders, [
      'order-unpaid',
      'order-pending',
      'order-cancelled',
      'order-paid',
    ]);

    const recomputed = result.orders.reduce((sum, o) => sum + o.total, 0);
    expect(result.amount).toBe(recomputed);
    expect(result.orderIds).toEqual(result.orders.map(o => o.id));
  });

  it('ignores ids not present in orders at all', () => {
    const result = selectClaimableOrdersForSettle(orders, [
      'order-unpaid',
      'does-not-exist',
    ]);

    expect(result.amount).toBe(100);
    expect(result.orderIds).toEqual(['order-unpaid']);
  });
});

// #231/#230: owesMoney is the set TablesScreen's unpaid-count badge now uses. It must be
// wider than isClaimablePaymentStatus (a cash_pending/failed/terminal_pending order is still
// owed, just not claimable for a NEW card charge right now) and must exclude 'cancelled' —
// that exclusion is the entire point of #230, since `!== 'paid'` treated a cancelled order as
// still owed.
describe('owesMoney', () => {
  it.each(['unpaid', 'pending', 'cash_pending', 'failed', 'terminal_pending', 'FAILED', ' Pending '])(
    'treats %j as still owed',
    status => {
      expect(owesMoney(status)).toBe(true);
    },
  );

  it.each(['paid', 'cancelled', 'refunded', '', null, undefined])(
    'treats %j as NOT owed — this is the #230 fix: a cancelled order must never count as unpaid',
    status => {
      expect(owesMoney(status)).toBe(false);
    },
  );
});

describe('isMidFlightCardPayment', () => {
  it('is true only for terminal_pending', () => {
    expect(isMidFlightCardPayment('terminal_pending')).toBe(true);
    expect(isMidFlightCardPayment('TERMINAL_PENDING')).toBe(true);
  });

  it.each(['unpaid', 'pending', 'cash_pending', 'failed', 'paid', 'cancelled'])(
    'is false for %j',
    status => {
      expect(isMidFlightCardPayment(status)).toBe(false);
    },
  );
});

describe('isCashSettleablePaymentStatus', () => {
  it.each(['unpaid', 'pending', 'cash_pending', 'failed'])(
    'treats %j as cash-settleable',
    status => {
      expect(isCashSettleablePaymentStatus(status)).toBe(true);
    },
  );

  it('excludes terminal_pending — a card payment already in flight must not also be cash-settleable', () => {
    expect(isCashSettleablePaymentStatus('terminal_pending')).toBe(false);
  });

  it.each(['paid', 'cancelled', ''])('excludes %j', status => {
    expect(isCashSettleablePaymentStatus(status)).toBe(false);
  });
});
