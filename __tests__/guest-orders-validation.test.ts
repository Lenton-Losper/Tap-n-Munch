import {
  guestCanAccessOrder,
  guestCanReceiveOrderDelivery,
  parseOptionalInt,
  paymentRefOrFilter,
} from '@/lib/guest-orders/validation'
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

  it('allows closed orders with UUID alone', () => {
    expect(guestCanAccessOrder(closedOrder, {})).toBe(true)
  })

  it('allows paid or completed orders with UUID alone', () => {
    expect(guestCanAccessOrder({ ...openOrder, payment_status: 'paid' }, {})).toBe(true)
    expect(guestCanAccessOrder({ ...openOrder, status: 'completed' }, {})).toBe(true)
    expect(guestCanAccessOrder({ ...openOrder, status: 'cancelled' }, {})).toBe(true)
  })

  it('requires table_number binding for open orders', () => {
    expect(guestCanAccessOrder(openOrder, { tableNumber: 5 })).toBe(true)
    expect(guestCanAccessOrder(openOrder, { tableNumber: 6 })).toBe(false)
    expect(guestCanAccessOrder(openOrder, {})).toBe(false)
  })

  it('allows session_id binding for open orders', () => {
    expect(guestCanAccessOrder(openOrder, { sessionId: 'sess-abc' })).toBe(true)
    expect(guestCanAccessOrder(openOrder, { sessionId: 'other' })).toBe(false)
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

/**
 * QRA-19. The delivery predicate is the read predicate with the terminal-state short-circuit
 * removed. It exists because POST /api/guest/orders/[orderId]/receipt/email is not a read: it
 * takes an attacker-chosen address and has the restaurant mail that customer's itemised receipt
 * to it, and it forces receipt issuance (which allocates a document number) on the way.
 *
 * The pair of cases that matter are the first two: guestCanAccessOrder says YES to a paid order
 * on restaurant scope alone, and guestCanReceiveOrderDelivery says NO to exactly the same call.
 * If those two ever agree again, the exposure is back.
 */
describe('guestCanReceiveOrderDelivery', () => {
  const paidOrder: GuestOrderRow = {
    id: 'order-1',
    restaurant_id: 'rest-a',
    table_number: 5,
    session_id: 'sess-abc',
    member_session_id: 'sess-abc',
    is_closed: false,
    status: 'completed',
    payment_status: 'paid',
  } as GuestOrderRow

  it('refuses a PAID order on restaurant scope alone, where the read helper allows it', () => {
    const restaurantScopeOnly = { restaurantId: 'rest-a' }

    // The read rule -- deliberate, and unchanged (#279 / the shareable receipt link).
    expect(guestCanAccessOrder(paidOrder, restaurantScopeOnly)).toBe(true)
    // The delivery rule.
    expect(guestCanReceiveOrderDelivery(paidOrder, restaurantScopeOnly)).toBe(false)
  })

  it('allows the session that placed the order', () => {
    expect(
      guestCanReceiveOrderDelivery(paidOrder, { restaurantId: 'rest-a', sessionId: 'sess-abc' }),
    ).toBe(true)
  })

  it('allows a session id matched against member_session_id, not only session_id', () => {
    const order = { ...paidOrder, session_id: 'sess-other', member_session_id: 'sess-mine' }
    expect(
      guestCanReceiveOrderDelivery(order, { restaurantId: 'rest-a', sessionIds: ['sess-mine'] }),
    ).toBe(true)
  })

  it('allows the table the order sits at', () => {
    expect(
      guestCanReceiveOrderDelivery(paidOrder, { restaurantId: 'rest-a', tableNumber: 5 }),
    ).toBe(true)
  })

  it('refuses a different table', () => {
    expect(
      guestCanReceiveOrderDelivery(paidOrder, { restaurantId: 'rest-a', tableNumber: 6 }),
    ).toBe(false)
  })

  it('refuses a different restaurant even with the right session id', () => {
    expect(
      guestCanReceiveOrderDelivery(paidOrder, { restaurantId: 'rest-b', sessionId: 'sess-abc' }),
    ).toBe(false)
  })

  it('refuses when no restaurant is supplied at all', () => {
    expect(guestCanReceiveOrderDelivery(paidOrder, { sessionId: 'sess-abc' })).toBe(false)
  })
})
