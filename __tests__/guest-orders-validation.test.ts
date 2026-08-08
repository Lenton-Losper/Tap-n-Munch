import { guestCanAccessOrder, parseOptionalInt, paymentRefOrFilter } from '@/lib/guest-orders/validation'
import type { GuestOrderRow } from '@/lib/guest-orders/types'

describe('guestCanAccessOrder', () => {
  const openOrder: GuestOrderRow = {
    id: 'order-1',
    restaurant_id: 'rest-a',
    table_number: 5,
    session_id: 'sess-abc',
    is_closed: false,
    status: 'pending',
    payment_status: 'pending',
  }

  const closedOrder: GuestOrderRow = {
    ...openOrder,
    is_closed: true,
    status: 'completed',
    payment_status: 'paid',
  }

  /**
   * Every case below carries the restaurant. Restaurant binding became mandatory in f4f9111
   * (multi-tenant isolation hardening) and these four cases were left asserting the pre-hardening
   * contract -- passing `{}` -- so they had been failing ever since. They are updated to the
   * policy the function actually implements, and the two cases that were missing entirely (no
   * restaurant at all, wrong restaurant) are now asserted rather than assumed.
   */
  const AT_REST_A = { restaurantId: 'rest-a' }

  it('denies everything when no restaurant is supplied', () => {
    expect(guestCanAccessOrder(closedOrder, {})).toBe(false)
    expect(guestCanAccessOrder(openOrder, { tableNumber: 5 })).toBe(false)
    expect(guestCanAccessOrder(openOrder, { sessionId: 'sess-abc' })).toBe(false)
  })

  it('denies a caller scoped to a different restaurant', () => {
    expect(guestCanAccessOrder(closedOrder, { restaurantId: 'rest-b' })).toBe(false)
    expect(
      guestCanAccessOrder(openOrder, { restaurantId: 'rest-b', sessionId: 'sess-abc' }),
    ).toBe(false)
  })

  it('allows closed orders on restaurant scope alone', () => {
    expect(guestCanAccessOrder(closedOrder, AT_REST_A)).toBe(true)
  })

  it('allows paid or completed orders on restaurant scope alone', () => {
    expect(guestCanAccessOrder({ ...openOrder, payment_status: 'paid' }, AT_REST_A)).toBe(true)
    expect(guestCanAccessOrder({ ...openOrder, status: 'completed' }, AT_REST_A)).toBe(true)
    expect(guestCanAccessOrder({ ...openOrder, status: 'cancelled' }, AT_REST_A)).toBe(true)
  })

  it('requires table_number binding for open orders', () => {
    expect(guestCanAccessOrder(openOrder, { ...AT_REST_A, tableNumber: 5 })).toBe(true)
    expect(guestCanAccessOrder(openOrder, { ...AT_REST_A, tableNumber: 6 })).toBe(false)
    expect(guestCanAccessOrder(openOrder, AT_REST_A)).toBe(false)
  })

  it('allows session_id binding for open orders', () => {
    expect(guestCanAccessOrder(openOrder, { ...AT_REST_A, sessionId: 'sess-abc' })).toBe(true)
    expect(guestCanAccessOrder(openOrder, { ...AT_REST_A, sessionId: 'other' })).toBe(false)
  })
})

describe('parseOptionalInt', () => {
  it('parses valid integers', () => {
    expect(parseOptionalInt('12')).toBe(12)
    expect(parseOptionalInt('')).toBeNull()
    expect(parseOptionalInt(undefined)).toBeNull()
    expect(parseOptionalInt('abc')).toBeNull()
  })
})

describe('paymentRefOrFilter', () => {
  it('builds OR filter for merchant order no and payment reference', () => {
    expect(paymentRefOrFilter('TN123')).toBe(
      'paycloud_merchant_order_no.eq.TN123,payment_reference.eq.TN123',
    )
  })
})
