/**
 * ONE ownership predicate. Three bugs on 2026-08-13 came from callers restating it.
 *
 *   1. guest queries carried a `sessionIds` list but still filtered ONE column
 *   2. My Orders rendered an empty list — the id it queried with had died with the browser tab
 *   3. the edit route answered `404 Order not found` to the customer's own order
 *
 * These bind to the shipped `ownsOrder`. If a future caller checks one id against one column, the
 * cases below are what go red — by name, saying which half was dropped.
 */
import { guestCanAccessOrder, ownsOrder } from '@/lib/guest-orders/validation'

const LOCAL_ID = 'sess_11111111-2222-3333-4444-555555555555'
const TAB_ID = 'session_1786615850151_8kbbfwp6jne'

describe('ownsOrder: EVERY id the client holds, against BOTH columns', () => {
  it('matches on session_id', () => {
    expect(ownsOrder({ session_id: TAB_ID }, [LOCAL_ID, TAB_ID])).toBe(true)
  })

  it('matches on member_session_id — the half that was missing', () => {
    // guestCanAccessOrder compared `order.session_id` only. A row whose placer is recorded in
    // member_session_id was the customer's own order and was refused as a stranger's.
    expect(ownsOrder({ session_id: null, member_session_id: TAB_ID }, [TAB_ID])).toBe(true)
  })

  it('matches when the held id is the SECOND one — the other half that was missing', () => {
    // The panel sent getCurrentSession() only. The order carries the tab-context id.
    expect(ownsOrder({ session_id: TAB_ID }, [LOCAL_ID, TAB_ID])).toBe(true)
    expect(ownsOrder({ session_id: TAB_ID }, [LOCAL_ID])).toBe(false)
  })

  it('refuses a stranger, which is the property that must survive every widening', () => {
    expect(ownsOrder({ session_id: TAB_ID, member_session_id: TAB_ID }, ['sess_someone_else'])).toBe(
      false,
    )
  })

  it('refuses when the client holds nothing', () => {
    expect(ownsOrder({ session_id: TAB_ID }, [])).toBe(false)
    expect(ownsOrder({ session_id: TAB_ID }, [null, undefined, '  '])).toBe(false)
  })

  it('never matches blank against blank', () => {
    // Both empty must be FALSE, not "equal therefore true" — that would make every row with no
    // recorded placer readable by any caller sending an empty id.
    expect(ownsOrder({ session_id: '', member_session_id: '' }, [''])).toBe(false)
    expect(ownsOrder({}, [''])).toBe(false)
  })

  it('trims and dedupes rather than treating " x " and "x" as different people', () => {
    expect(ownsOrder({ session_id: 'x' }, ['  x  ', 'x'])).toBe(true)
  })
})

describe('guestCanAccessOrder delegates instead of restating', () => {
  const open = {
    id: 'o1',
    restaurant_id: 'r1',
    is_closed: false,
    status: 'accepted',
    payment_status: 'pending',
    table_number: 7,
  }

  it('admits the placer by member_session_id, which it could not before', () => {
    expect(
      guestCanAccessOrder(
        { ...open, session_id: null, member_session_id: TAB_ID } as never,
        { restaurantId: 'r1', sessionId: TAB_ID },
      ),
    ).toBe(true)
  })

  it('admits the placer by the second held id', () => {
    expect(
      guestCanAccessOrder({ ...open, session_id: TAB_ID } as never, {
        restaurantId: 'r1',
        sessionId: LOCAL_ID,
        sessionIds: [TAB_ID],
      }),
    ).toBe(true)
  })

  it('still refuses a different restaurant outright, before any session check', () => {
    expect(
      guestCanAccessOrder({ ...open, session_id: TAB_ID } as never, {
        restaurantId: 'OTHER',
        sessionId: TAB_ID,
      }),
    ).toBe(false)
  })

  /**
   * The table branch is UNCHANGED by this work and is deliberately still permissive: an OPEN order
   * is readable by anyone who knows the table number. That is what forced redactGuestOrderRow, it
   * is the only reason the confirmation page loads for tab-flow orders today, and narrowing it is
   * sequenced AFTER this consolidation on the human's ruling. Asserted here so the current
   * behaviour is recorded rather than assumed, and so narrowing it later fails this test loudly
   * instead of silently.
   */
  it('STILL admits an open order on table_number alone — recorded, not endorsed', () => {
    expect(
      guestCanAccessOrder({ ...open, session_id: 'someone_else' } as never, {
        restaurantId: 'r1',
        tableNumber: 7,
        sessionId: 'not-the-placer',
      }),
    ).toBe(true)
  })
})
