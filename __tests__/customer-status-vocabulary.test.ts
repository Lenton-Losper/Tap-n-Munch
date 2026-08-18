/**
 * Binds to lib/orders/customer-status.ts.
 *
 * TWO TESTS CARRY THE WHOLE FILE:
 *
 *   `an unmapped status is never rendered as a friendly lie` — the old maps ended
 *   `return configs[status] || configs.pending`, and `configs.pending` was `{🎉, 'New'}`. Every
 *   status the map did not know rendered as a brand new order, including `ready_for_terminal`,
 *   which is a state where the customer is waiting for something to happen to THEM. Spec section
 *   34 removes the NEW badge; removing it without fixing the fallback only moves the lie.
 *
 *   `paid beats every kitchen status` — `markOrderPaidConfirmed` writes `completed` from any
 *   status and the terminal can settle an order mid-preparation. Reading `status` first shows
 *   "Being prepared" on an order already paid for.
 */
import {
  CUSTOMER_ORDER_STATES,
  CUSTOMER_STATUS_COPY,
  customerOrderState,
  customerStateNeedsAttention,
  customerStatusLabel,
} from '@/lib/orders/customer-status'

describe('customerOrderState — the kitchen states', () => {
  it.each([
    ['waiting_review', 'waiting'],
    ['pending', 'waiting'],
    ['accepting', 'waiting'],
    ['accepted', 'accepted'],
    ['confirmed', 'accepted'],
    ['preparing', 'preparing'],
    ['ready', 'ready'],
  ])('maps %s to %s', (status, expected) => {
    expect(customerOrderState({ status })).toBe(expected)
  })

  it('does NOT merge accepted into being-prepared', () => {
    // `accepted` means staff took the order; the kitchen may not have started. It is also the
    // boundary editing closes at, so the two states differ in what the customer can still do.
    expect(customerOrderState({ status: 'accepted' })).not.toBe(
      customerOrderState({ status: 'preparing' })
    )
  })

  it('maps the terminal spelling of accepted the same as the dashboard spelling', () => {
    // The terminal writes `confirmed`; a render site that misses that draws the order as LESS
    // far along than it is.
    expect(customerOrderState({ status: 'confirmed' })).toBe(customerOrderState({ status: 'accepted' }))
  })

  it('is case-insensitive, as the normaliser is', () => {
    expect(customerOrderState({ status: 'PREPARING' })).toBe('preparing')
  })
})

/**
 * THE SPLIT OF 2026-08-18. `needs_you` ("See staff") collapsed a refusal, a cancellation, an
 * order at the terminal and a failed card into one sentence — the app declining to say what
 * happened when it knows. It is gone; these four replaced it.
 *
 * EACH ASSERTED SEPARATELY, and that is the point of the table: a mapping that sent two of them
 * to the same state would pass a test written as "is one of the four".
 */
describe('customerOrderState — the four states that replaced needs_you', () => {
  it.each([
    ['declined', 'declined'],
    ['cancelled', 'cancelled'],
    ['ready_for_terminal', 'awaiting_payment'],
    ['failed', 'payment_failed'],
  ])('maps %s to its own state, %s', (status, expected) => {
    expect(customerOrderState({ status })).toBe(expected)
  })

  it('does NOT merge declined and cancelled — they are different conversations with staff', () => {
    expect(customerOrderState({ status: 'declined' })).not.toBe(
      customerOrderState({ status: 'cancelled' }),
    )
    expect(CUSTOMER_STATUS_COPY.declined).not.toBe(CUSTOMER_STATUS_COPY.cancelled)
  })

  it('treats a failed PAYMENT as a payment failure, whatever the kitchen says', () => {
    expect(customerOrderState({ status: 'preparing', paymentStatus: 'failed' })).toBe(
      'payment_failed',
    )
  })

  /**
   * ONLY the payment failure asks anything of the customer. The other three are STATEMENTS about
   * what happened to the order — treating them as demands is what made the badge read as a
   * control the customer was supposed to operate.
   */
  it('flags exactly the state that expects something of the customer', () => {
    expect(customerStateNeedsAttention('payment_failed')).toBe(true)
    for (const state of CUSTOMER_ORDER_STATES.filter((s) => s !== 'payment_failed')) {
      expect(customerStateNeedsAttention(state)).toBe(false)
    }
  })

  it('is ten words, each distinct — a duplicate would re-merge two states by the back door', () => {
    const words = Object.values(CUSTOMER_STATUS_COPY)
    expect(CUSTOMER_ORDER_STATES).toHaveLength(10)
    expect(new Set(words).size).toBe(words.length)
    expect(words).not.toContain('See staff')
  })

  /**
   * "Waiting for payment", NOT "Ready to pay". The tab strip already says "Ready for payment" for
   * a different fact — the TABLE asking to settle, versus one ORDER waiting at the terminal.
   */
  it('does not reuse the tab strip’s phrasing for a different fact', () => {
    expect(CUSTOMER_STATUS_COPY.awaiting_payment).toBe('Waiting for payment')
    expect(CUSTOMER_STATUS_COPY.awaiting_payment).not.toMatch(/ready/i)
  })
})

describe('customerOrderState — money', () => {
  it('paid beats every kitchen status', () => {
    for (const status of ['pending', 'accepted', 'preparing', 'ready', 'completed', '']) {
      expect(customerOrderState({ status, paymentStatus: 'paid' })).toBe('paid')
    }
  })

  it('never says Paid for a completed order that was not paid for', () => {
    // Staff reconcile can complete an order with no payment (#234). Telling a customer they have
    // paid when the money record says otherwise is the one error here that costs somebody money.
    expect(customerOrderState({ status: 'completed', paymentStatus: 'pending' })).not.toBe('paid')
    expect(customerOrderState({ status: 'completed' })).not.toBe('paid')
  })
})

describe('customerOrderState — the fallback', () => {
  it('an unmapped status is never rendered as a friendly lie', () => {
    for (const status of ['some_future_status', 'accepting_v2', 'held', 'refunded']) {
      const state = customerOrderState({ status })
      expect(state).toBe('unknown')
      // Specifically: never the state a brand-new order is in.
      expect(state).not.toBe('waiting')
    }
  })

  it('treats an absent status as unknown rather than as new', () => {
    expect(customerOrderState({ status: null })).toBe('unknown')
    expect(customerOrderState({ status: undefined })).toBe('unknown')
    expect(customerOrderState({ status: '' })).toBe('unknown')
  })

  it("the unknown copy promises nothing about the order's progress", () => {
    const copy = CUSTOMER_STATUS_COPY.unknown.toLowerCase()
    for (const forbidden of ['new', 'ready', 'prepared', 'preparing', 'paid']) {
      expect(copy).not.toContain(forbidden)
    }
  })
})

describe('the copy', () => {
  /**
   * INVERTED 2026-08-17, when the human signed the seven words off. It used to assert the marker
   * was PRESENT so the morning report could find them. Kept rather than deleted, and pointed the
   * other way: a placeholder must never come back into a shipped surface. These render on every
   * customer screen, so a marker here reaches production faster than anything else in the app.
   */
  it('carries no placeholder marker, now that the wording is signed off', () => {
    for (const state of CUSTOMER_ORDER_STATES) {
      expect(CUSTOMER_STATUS_COPY[state]).not.toMatch(/PENDING COPY/)
      expect(CUSTOMER_STATUS_COPY[state].trim().length).toBeGreaterThan(0)
    }
  })

  it('gives every state a distinct string', () => {
    const values = CUSTOMER_ORDER_STATES.map((s) => CUSTOMER_STATUS_COPY[s])
    expect(new Set(values).size).toBe(values.length)
  })

  it('customerStatusLabel is the same decision as customerOrderState', () => {
    expect(customerStatusLabel('preparing')).toBe(CUSTOMER_STATUS_COPY.preparing)
    expect(customerStatusLabel('preparing', 'paid')).toBe(CUSTOMER_STATUS_COPY.paid)
  })
})
