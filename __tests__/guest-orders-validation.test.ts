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

/**
 * QRA-19, then #304. The delivery predicate exists because
 * POST /api/guest/orders/[orderId]/receipt/email is not a read: it takes an attacker-chosen
 * address and has the restaurant mail that customer's itemised receipt to it, and it forces
 * receipt issuance (which allocates a document number) on the way.
 *
 * TWO CASES CARRY THIS BLOCK.
 *
 * 1. guestCanAccessOrder says YES to a paid order on restaurant scope alone and
 *    guestCanReceiveOrderDelivery says NO to exactly the same call (QRA-19). If those two ever
 *    agree again, the original exposure is back.
 *
 * 2. The correct table number, alone, is REFUSED (#304). QRA-19 left a table branch here, and a
 *    table number is not a secret -- it is printed on the QR code and sits in every menu URL, so
 *    it authorised any diner who could read the table, or anyone willing to walk 0..N. Measured
 *    on the deployed handler before the fix, against an UNPAID order so nothing could be issued
 *    or mailed: correct table_number -> 400 "not paid yet", which is past the gate; any other
 *    table_number, and restaurant scope alone -> 404.
 *
 * The `tableNumber` key is gone from the parameter type, so the #304 case is asserted through
 * `as never` -- the compiler refuses it and this pins the RUNTIME answer too, for a caller that
 * reaches this function without going through tsc.
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

  /**
   * #304. THE CASE THE ISSUE IS ABOUT. This used to be `.toBe(true)` under the name "allows the
   * table the order sits at", and that assertion was the exposure: the caller supplies both the
   * table number and the destination address, and neither is a secret.
   *
   * Cast because `tableNumber` is deliberately not in the parameter type any more -- a caller
   * that passes one now fails to compile. This asserts the other half: that if one reaches the
   * function anyway, it authorises nothing.
   */
  it('refuses the correct table number, presented alone (#304)', () => {
    expect(
      guestCanReceiveOrderDelivery(paidOrder, {
        restaurantId: 'rest-a',
        tableNumber: 5,
      } as never),
    ).toBe(false)
  })

  it('refuses a different table (#304: every table number is refused)', () => {
    expect(
      guestCanReceiveOrderDelivery(paidOrder, {
        restaurantId: 'rest-a',
        tableNumber: 6,
      } as never),
    ).toBe(false)
  })

  /**
   * The regression this fix could plausibly cause, pinned as a case rather than assumed.
   *
   * The only client that calls the route is the kiosk success screen, and it presents EVERY id
   * the browser holds (`heldSessionIds()`), one repeated `session_id` param each. Kiosk orders
   * carry a `sess_<uuid>` id in both columns -- verified on production, 8 of 8 -- so the customer
   * who just paid still reaches their own receipt with the table branch gone.
   */
  it('still allows the kiosk customer, who presents every id the browser holds', () => {
    const kioskOrder = {
      ...paidOrder,
      table_number: 1001,
      session_id: 'sess_2ad27ff6-f25a-4e13-bf99-cde48a6f1a22',
      member_session_id: 'sess_2ad27ff6-f25a-4e13-bf99-cde48a6f1a22',
    }
    expect(
      guestCanReceiveOrderDelivery(kioskOrder, {
        restaurantId: 'rest-a',
        sessionId: 'sess_2ad27ff6-f25a-4e13-bf99-cde48a6f1a22',
        sessionIds: ['sess_2ad27ff6-f25a-4e13-bf99-cde48a6f1a22', 'session_1756_abc'],
      }),
    ).toBe(true)
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
