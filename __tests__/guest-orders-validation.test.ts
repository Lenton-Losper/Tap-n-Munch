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
