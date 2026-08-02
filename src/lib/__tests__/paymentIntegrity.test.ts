import {
  isClaimablePaymentStatus,
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
