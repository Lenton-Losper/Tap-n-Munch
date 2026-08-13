/**
 * Customer order editing — the rules, bound to the shipped modules rather than restated.
 *
 * Everything here imports the functions the route and the two UIs call. A test that carries
 * its own copy of the rule stays green against a render site that has been reverted (#205), so
 * the point of these is that they fail when `lib/orders/edit-lock.ts` changes, not when a
 * paraphrase of it does.
 *
 * Hermetic: no supabase, no HTTP, no timers. `nowMs` is passed in everywhere for the same
 * reason — a lock going stale is the passage of time and nothing else, and that has to be
 * assertable without waiting three minutes.
 */
import {
  EDITABLE_ORDER_STATUSES,
  EDITABLE_PAYMENT_STATUSES,
  EDIT_LOCK_TTL_MS,
  editLockExpiryFrom,
  editRefusalReason,
  editRequiresReacceptance,
  isEditLockActive,
  isEditLockHeldByOther,
  isEditableOrderStatus,
  requestEditRefusalReason,
  appendEditHistory,
} from '@/lib/orders/edit-lock'
import { InvalidEditError, repriceKeptLines } from '@/lib/orders/reprice-priced-lines'
import { effectiveRequestPricing } from '@/lib/orders/order-request-pricing'
import { redactGuestOrderRow } from '@/lib/guest-orders/validation'

const NOW = Date.parse('2026-08-13T12:00:00.000Z')

function editableOrder(overrides: Record<string, unknown> = {}) {
  return {
    status: 'accepted',
    payment_status: 'pending',
    payment_checkout_url: null,
    edit_lock_token: null,
    edit_lock_session_id: null,
    edit_lock_expires_at: null,
    ...overrides,
  }
}

describe('the ruling: editable only before preparation starts', () => {
  it('allows the two statuses before the kitchen has it', () => {
    expect([...EDITABLE_ORDER_STATUSES]).toEqual(['pending', 'accepted'])
    expect(isEditableOrderStatus('pending')).toBe(true)
    expect(isEditableOrderStatus('accepted')).toBe(true)
  })

  it('closes editing permanently once preparing, and stays closed after', () => {
    for (const status of ['preparing', 'ready', 'completed', 'served']) {
      expect(editRefusalReason(editableOrder({ status }), { sessionId: 's1', nowMs: NOW })).toBe(
        'preparation_started',
      )
    }
  })

  it('refuses a status it has never heard of rather than falling through to editable', () => {
    // The gate is an allowlist. A denylist would let any status added later be editable by
    // default, and the failure mode is a customer editing an order that is already out.
    expect(
      editRefusalReason(editableOrder({ status: 'awaiting_courier' }), { sessionId: 's1', nowMs: NOW }),
    ).toBe('not_editable_status')
  })

  it('refuses ready_for_terminal — the amount is being collected at the table', () => {
    expect(
      editRefusalReason(editableOrder({ status: 'ready_for_terminal' }), { sessionId: 's1', nowMs: NOW }),
    ).toBe('not_editable_status')
  })
})

describe('money closes editing before the kitchen does', () => {
  it('allows only the unsettled payment states', () => {
    expect([...EDITABLE_PAYMENT_STATUSES]).toEqual(['pending', 'cash_pending'])
  })

  it('refuses a paid order', () => {
    expect(
      editRefusalReason(editableOrder({ payment_status: 'paid' }), { sessionId: 's1', nowMs: NOW }),
    ).toBe('payment_settled')
  })

  it('refuses while a hosted checkout session is open, even though payment is still pending', () => {
    // The session was created for the OLD total. Moving the total under it is the case QR
    // payments have no recovery path for.
    expect(
      editRefusalReason(
        editableOrder({ payment_checkout_url: 'https://checkout.example/abc' }),
        { sessionId: 's1', nowMs: NOW },
      ),
    ).toBe('payment_in_flight')
  })
})

describe('the lock: three minutes, and whose it is', () => {
  it('is three minutes', () => {
    expect(EDIT_LOCK_TTL_MS).toBe(180_000)
    expect(Date.parse(editLockExpiryFrom(NOW)) - NOW).toBe(180_000)
  })

  it('is not active once expired — no row changes, only the clock', () => {
    const row = editableOrder({
      edit_lock_token: 'tok',
      edit_lock_session_id: 's2',
      edit_lock_expires_at: new Date(NOW + 1000).toISOString(),
    })
    expect(isEditLockActive(row, NOW)).toBe(true)
    expect(isEditLockActive(row, NOW + 2000)).toBe(false)
  })

  it('blocks a different session while live, and stops blocking on expiry', () => {
    const row = editableOrder({
      edit_lock_token: 'tok',
      edit_lock_session_id: 's2',
      edit_lock_expires_at: new Date(NOW + 60_000).toISOString(),
    })
    expect(editRefusalReason(row, { sessionId: 's1', nowMs: NOW })).toBe('locked_by_other')
    expect(editRefusalReason(row, { sessionId: 's1', nowMs: NOW + 61_000 })).toBeNull()
  })

  it('lets the holder renew their own lock — reloading is not a conflict', () => {
    const row = editableOrder({
      edit_lock_token: 'tok',
      edit_lock_session_id: 's2',
      edit_lock_expires_at: new Date(NOW + 60_000).toISOString(),
    })
    expect(isEditLockHeldByOther(row, { sessionId: 's2', nowMs: NOW })).toBe(false)
    expect(editRefusalReason(row, { sessionId: 's2', nowMs: NOW })).toBeNull()
  })

  it('treats a live lock with no recorded holder as somebody else’s', () => {
    // Failing open here would hand the lock to whoever asked next.
    const row = editableOrder({
      edit_lock_token: 'tok',
      edit_lock_session_id: null,
      edit_lock_expires_at: new Date(NOW + 60_000).toISOString(),
    })
    expect(isEditLockHeldByOther(row, { sessionId: 's1', nowMs: NOW })).toBe(true)
  })

  it('treats a token with no expiry as not a lock', () => {
    expect(isEditLockActive(editableOrder({ edit_lock_token: 'tok' }), NOW)).toBe(false)
  })
})

describe('the pre-Accept surface has its own vocabulary', () => {
  it('is editable while waiting for review', () => {
    expect(requestEditRefusalReason({ status: 'waiting_review' }, { sessionId: 's1', nowMs: NOW })).toBeNull()
  })

  it('refuses during the transient accepting claim — the checkout is being built', () => {
    expect(requestEditRefusalReason({ status: 'accepting' }, { sessionId: 's1', nowMs: NOW })).toBe(
      'payment_in_flight',
    )
  })

  it('tells an accepted request apart from a declined one', () => {
    expect(requestEditRefusalReason({ status: 'accepted' }, { sessionId: 's1', nowMs: NOW })).toBe(
      'request_accepted',
    )
    expect(requestEditRefusalReason({ status: 'declined' }, { sessionId: 's1', nowMs: NOW })).toBe(
      'request_declined',
    )
  })
})

describe('re-acceptance is decided in cents, not by float tolerance', () => {
  it('is required when the total moves', () => {
    expect(editRequiresReacceptance(120.5, 95)).toBe(true)
  })

  it('is not required when it does not', () => {
    expect(editRequiresReacceptance(120.5, 120.5)).toBe(false)
  })

  /**
   * RULED 2026-08-13: removals are NOT exempt. A removal changes what the kitchen makes and
   * what the customer pays, so staff see it before cooking; only a notes-only edit is exempt.
   *
   * This test exists to fail if someone implements the rejected alternative
   * (`nextTotal > previousTotal`, exempting a falling total) from the comment on
   * editRequiresReacceptance. A comment alone did not seem like enough to stop that.
   */
  it('is required for a REMOVAL, which lowers the total — removals are not exempt', () => {
    expect(editRequiresReacceptance(225, 200)).toBe(true)
    // The rejected alternative would return false here. If this ever passes as false, the
    // ruling has been reversed without anyone saying so.
    expect(editRequiresReacceptance(225, 200)).not.toBe(200 > 225)
  })

  it('sees a one-cent change at an amount where a 0.01 float tolerance would not', () => {
    // 28.5% of exact one-cent differences fail `Math.abs(a-b) <= 0.01` by binary
    // representation alone (#180). A cent moving IS the total changing.
    expect(editRequiresReacceptance(0.29, 0.3)).toBe(true)
    expect(Math.abs(0.3 - 0.29) <= 0.01).toBe(false)
  })
})

describe('repricing a reduction: from the order’s own priced lines, never the live menu', () => {
  const lines = [
    { name: 'Burger', quantity: 2, unitPrice: 100, subtotal: 173.91, tax: 26.09, total: 200, taxRatePercentage: 15, taxInclusive: true },
    { name: 'Coke', quantity: 1, unitPrice: 25, subtotal: 21.74, tax: 3.26, total: 25, taxRatePercentage: 15, taxInclusive: true },
  ]

  it('drops a removed line and re-sums the rest', () => {
    const result = repriceKeptLines(lines, [{ index: 0, quantity: 2 }])
    expect(result.items).toHaveLength(1)
    expect(result.total).toBe(200)
  })

  it('keeps a surviving line at exactly the price it was quoted', () => {
    const result = repriceKeptLines(lines, [
      { index: 0, quantity: 2 },
      { index: 1, quantity: 1 },
    ])
    // Untouched lines are passed through, not recomputed — the customer keeps the price the
    // restaurant accepted even if the menu has moved since.
    expect(result.items[0]).toBe(lines[0])
    expect(result.total).toBe(225)
  })

  it('splits an inclusive rate the same way the pricing lib does when a quantity drops', () => {
    const result = repriceKeptLines(lines, [{ index: 0, quantity: 1 }])
    expect(result.items[0]).toMatchObject({ quantity: 1, total: 100, tax: 13.04, subtotal: 86.96 })
    expect(result.total).toBe(100)
  })

  it('refuses to raise a quantity — that is a new order, with the checks a new order gets', () => {
    expect(() => repriceKeptLines(lines, [{ index: 0, quantity: 3 }])).toThrow(InvalidEditError)
  })

  it('refuses to empty the order', () => {
    expect(() => repriceKeptLines(lines, [])).toThrow(InvalidEditError)
  })

  it('refuses a line index that is not part of the order', () => {
    expect(() => repriceKeptLines(lines, [{ index: 9, quantity: 1 }])).toThrow(InvalidEditError)
  })

  it('refuses the same line twice', () => {
    expect(() =>
      repriceKeptLines(lines, [
        { index: 0, quantity: 1 },
        { index: 0, quantity: 1 },
      ]),
    ).toThrow(InvalidEditError)
  })

  it('refuses a fractional quantity', () => {
    expect(() => repriceKeptLines(lines, [{ index: 0, quantity: 1.5 }])).toThrow(InvalidEditError)
  })

  it('reads no price from the request — only an index and a quantity', () => {
    const result = repriceKeptLines(lines, [
      // A crafted client sending its own money alongside the instruction changes nothing.
      { index: 1, quantity: 1, total: 0.01, unitPrice: 0.01 } as never,
    ])
    expect(result.total).toBe(25)
  })
})

describe('order_request pricing precedence, in one place', () => {
  const base = { items: [{ n: 1 }], subtotal: 10, tax: 1, total: 11 }

  it('falls back to the original submission', () => {
    expect(effectiveRequestPricing(base)).toMatchObject({ total: 11, source: 'original' })
  })

  it('prefers the customer’s own amendment over the original', () => {
    expect(
      effectiveRequestPricing({ ...base, items_customer: [{ n: 2 }], total_customer: 7 }),
    ).toMatchObject({ total: 7, source: 'customer_edited' })
  })

  it('prefers a staff review over both — the most recent writer wins', () => {
    expect(
      effectiveRequestPricing({
        ...base,
        items_customer: [{ n: 2 }],
        total_customer: 7,
        items_reviewed: [{ n: 3 }],
        total_reviewed: 5,
      }),
    ).toMatchObject({ total: 5, source: 'staff_reviewed' })
  })
})

describe('the lock token is a capability and never leaves on a read', () => {
  it('is stripped, and replaced by the boolean the UI needs', () => {
    const redacted = redactGuestOrderRow({
      id: 'o1',
      total: 50,
      edit_lock_token: 'secret-token',
      edit_lock_session_id: 'someone-else',
    })
    // Whoever holds this token can commit an edit. guestCanAccessOrder admits an open order on
    // table_number alone, so returning it on a read would let one diner edit another's order.
    expect(redacted).not.toHaveProperty('edit_lock_token')
    expect(redacted.edit_lock_held).toBe(true)
    expect(JSON.stringify(redacted)).not.toContain('secret-token')
  })

  it('reports no lock held when there is none', () => {
    expect(redactGuestOrderRow({ id: 'o1' }).edit_lock_held).toBe(false)
  })

  it('states which table the row came from rather than leaving it to be guessed', () => {
    expect(redactGuestOrderRow({ id: 'o1' }).surface).toBe('orders')
    expect(redactGuestOrderRow({ id: 'r1' }, 'order_requests').surface).toBe('order_requests')
  })
})

describe('edit history is append-only and bounded', () => {
  const entry = (n: number) => ({
    edited_at: new Date(NOW + n).toISOString(),
    previous_total: n,
    new_total: n - 1,
    previous_items: [],
    notes_changed: false,
    items_changed: true,
  })

  it('appends to what is already there', () => {
    expect(appendEditHistory([entry(1)], entry(2))).toHaveLength(2)
  })

  it('survives a null or malformed column rather than throwing', () => {
    expect(appendEditHistory(null, entry(1))).toHaveLength(1)
    expect(appendEditHistory('not an array', entry(1))).toHaveLength(1)
  })

  it('keeps the most recent 20 so one row cannot grow without limit', () => {
    let history = appendEditHistory(null, entry(0))
    for (let i = 1; i < 30; i += 1) history = appendEditHistory(history, entry(i))
    expect(history).toHaveLength(20)
    expect(history[history.length - 1].previous_total).toBe(29)
  })
})
