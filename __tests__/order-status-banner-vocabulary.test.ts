/**
 * #173, at the level the defect actually lives: what state a status change resolves to.
 *
 * These bind to `customerOrderState`, which `OrderStatusBanner` now switches on. That is the
 * honest scope: the RULE is the mapping, and that the banner uses it is covered by reading and by
 * tsc, not by test (#205's lesson — a test that carries its own copy of a rule stays green against
 * a render site that has been reverted).
 *
 * The two cases below are the two halves of #173, written as the defect rather than as the fix:
 *
 *   1. accepted -> ready must NOT resolve to "being prepared". The old arm read
 *      `oldStatus === 'accepted' ? 'is being prepared' : 'is ready!'`, so precisely this
 *      transition — the common one, whenever the kitchen sets no explicit `preparing` step —
 *      announced the LESS advanced state.
 *   2. `confirmed`, which is what the TERMINAL writes where the dashboard writes `accepted`, must
 *      resolve to something. It had no case and fell to `default: null`, so the customer heard
 *      nothing at all.
 */
import { customerOrderState } from '@/lib/orders/customer-status'

describe('#173 — a ready order is not told it is being prepared', () => {
  it('resolves ready to ready, whatever it came from', () => {
    // The transition the old code got wrong. `customerOrderState` takes no previous status at
    // all, which is what makes the defect unexpressible rather than merely fixed.
    expect(customerOrderState({ status: 'ready' })).toBe('ready')
  })

  it('keeps preparing and ready as different answers', () => {
    expect(customerOrderState({ status: 'preparing' })).toBe('preparing')
    expect(customerOrderState({ status: 'preparing' })).not.toBe(
      customerOrderState({ status: 'ready' })
    )
  })
})

describe('#173 — a terminal-confirmed order says something', () => {
  it('resolves the terminal spelling, which previously fell through to silence', () => {
    expect(customerOrderState({ status: 'confirmed' })).toBe('accepted')
  })

  it('agrees with the dashboard spelling', () => {
    expect(customerOrderState({ status: 'confirmed' })).toBe(
      customerOrderState({ status: 'accepted' })
    )
  })
})

describe('#173 — payment beats the kitchen status', () => {
  it('says paid for a settled order the kitchen is still working on', () => {
    // The terminal can settle an order mid-preparation, and markOrderPaidConfirmed writes
    // `completed` from any status. Announcing the kitchen state here would tell a customer their
    // food is being cooked after they have paid for it.
    expect(customerOrderState({ status: 'preparing', paymentStatus: 'paid' })).toBe('paid')
  })

  it('does NOT say paid for a completed order with no payment', () => {
    // #234: staff reconcile can complete an order without a payment. This is the one wrong
    // answer in the table that would cost somebody money.
    expect(customerOrderState({ status: 'completed', paymentStatus: 'pending' })).not.toBe('paid')
  })
})

describe('#173 — states the banner must stay silent about', () => {
  it.each(['waiting_review', 'pending', 'accepting'])(
    'resolves %s to waiting, which the banner does not announce',
    (status) => {
      // "Still waiting" is not news. The banner exists to announce a change for the better.
      expect(customerOrderState({ status })).toBe('waiting')
    }
  )

  it('resolves an unrecognised status to unknown rather than to a claim', () => {
    expect(customerOrderState({ status: 'some_status_added_later' })).toBe('unknown')
  })
})
