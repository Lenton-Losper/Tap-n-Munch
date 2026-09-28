import {
  isClaimablePaymentStatus,
  selectClaimableOrdersForSettle,
} from '../paymentIntegrity';
import {line, noLinesPayload, payloadWith} from './helpers/linesPayload';

// Independent QA verification pass on top of the 15 tests added in
// e37268a. These probe scenarios not covered there: an all-cancelled tab,
// a three-way mix including a refunded status string, empty selection,
// duplicate ids, and result ordering.

describe('selectClaimableOrdersForSettle — QA edge cases', () => {
  it('a tab with only cancelled orders yields nothing claimable, even if every id is selected', () => {
    const orders = [
      {id: 'c1', total: 40, payment_status: 'cancelled'},
      {id: 'c2', total: 60, payment_status: 'cancelled'},
    ];

    const result = selectClaimableOrdersForSettle(orders, ['c1', 'c2'], noLinesPayload());

    expect(result.amount).toBe(0);
    expect(result.orderIds).toEqual([]);
    expect(result.orders).toEqual([]);
  });

  it('mixed refunded + cancelled + claimable: only the claimable order counts', () => {
    const orders = [
      {id: 'claimable', total: 30, payment_status: 'unpaid'},
      {id: 'cancelled', total: 500, payment_status: 'cancelled'},
      {id: 'refunded', total: 200, payment_status: 'refunded'},
    ];

    const result = selectClaimableOrdersForSettle(orders, [
      'claimable',
      'cancelled',
      'refunded',
    ], noLinesPayload());

    expect(result.amount).toBe(30);
    expect(result.orderIds).toEqual(['claimable']);
  });

  it('an empty selection (nothing passed in) settles nothing, regardless of what exists on the tab', () => {
    const orders = [
      {id: 'unpaid-1', total: 100, payment_status: 'unpaid'},
      {id: 'cancelled-1', total: 999, payment_status: 'cancelled'},
    ];

    const result = selectClaimableOrdersForSettle(orders, [], noLinesPayload());

    expect(result.amount).toBe(0);
    expect(result.orderIds).toEqual([]);
    expect(result.orders).toEqual([]);
  });

  it('does not double-count a duplicate id in the requested orderIds', () => {
    const orders = [{id: 'order-1', total: 100, payment_status: 'unpaid'}];

    const result = selectClaimableOrdersForSettle(orders, [
      'order-1',
      'order-1',
      'order-1',
    ], noLinesPayload());

    expect(result.amount).toBe(100);
    expect(result.orderIds).toEqual(['order-1']);
  });

  it('preserves tab order in the result, independent of the order ids were requested in', () => {
    const orders = [
      {id: 'a', total: 10, payment_status: 'unpaid'},
      {id: 'b', total: 20, payment_status: 'pending'},
      {id: 'c', total: 30, payment_status: 'unpaid'},
    ];

    // requested out of order, and with a cancelled/nonexistent id thrown in
    const result = selectClaimableOrdersForSettle(orders, [
      'c',
      'does-not-exist',
      'a',
      'b',
    ], noLinesPayload());

    expect(result.orderIds).toEqual(['a', 'b', 'c']);
    expect(result.amount).toBe(60);
  });

  it('a zero-total claimable order is still included in orderIds even though it adds nothing to amount', () => {
    const orders = [
      {id: 'free-item', total: 0, payment_status: 'unpaid'},
      {id: 'paid-item', total: 40, payment_status: 'unpaid'},
    ];

    const result = selectClaimableOrdersForSettle(orders, [
      'free-item',
      'paid-item',
    ], noLinesPayload());

    expect(result.amount).toBe(40);
    // Still included -- but no longer FIRST. Sprint 2026-09-28: the card path prepares against the
    // first id and prepare-payment now refuses a lead order that owes nothing (409
    // ORDER_NOTHING_OWED), so an owing order leads. This used to assert tab order here.
    expect(result.orderIds).toEqual(['paid-item', 'free-item']);
  });

  it('a fully voided order at the head of the tab does not lead the card settle', () => {
    const orders = [
      {id: 'voided', total: 120, payment_status: 'unpaid'},
      {id: 'a', total: 30, payment_status: 'unpaid'},
      {id: 'b', total: 20, payment_status: 'unpaid'},
    ];
    const basis = payloadWith([
      {id: 'voided', total: 120, lines: [line({cents: 12000, voided: true})]},
      {id: 'a', total: 30, lines: [line({cents: 3000})]},
      {id: 'b', total: 20, lines: [line({cents: 2000})]},
    ]);
    const result = selectClaimableOrdersForSettle(orders, ['voided', 'a', 'b'], basis);
    expect(result.orderIds).toEqual(['a', 'b', 'voided']);
    expect(result.orders.map(o => o.id)).toEqual(result.orderIds);
    expect(result.amount).toBe(50);
  });
});

describe('isClaimablePaymentStatus — QA edge cases', () => {
  it.each([0, 1, {}, [], true, false])(
    'treats non-string value %j as NOT claimable rather than throwing',
    value => {
      expect(() => isClaimablePaymentStatus(value)).not.toThrow();
      expect(isClaimablePaymentStatus(value)).toBe(false);
    },
  );

  it('does not treat a status merely containing "unpaid" as a substring match', () => {
    expect(isClaimablePaymentStatus('unpaid-disputed')).toBe(false);
    expect(isClaimablePaymentStatus('was-pending')).toBe(false);
  });
});
