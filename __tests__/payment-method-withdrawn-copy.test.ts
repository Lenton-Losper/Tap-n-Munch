/**
 * #209 -- the withdrawn-method toast must name the method that was actually withdrawn.
 *
 * The old string was `'Cash payments are no longer available. Please select Card.'`, hardcoded in
 * a branch that fires for card as well. A customer whose CARD was disabled was told cash was gone
 * and told to pick card -- the method that had just been turned off.
 *
 * Two assertions carry the fix, and the second is the one that matters: the message must not
 * INSTRUCT the customer toward a method it cannot know is still available.
 */
import {
  paymentMethodWithdrawnCopy,
  PAYMENT_METHOD_WITHDRAWN_TITLE,
  type PaymentPreference,
} from '@/lib/customer-copy/payment-method-withdrawn'

describe('#209 -- the message names the withdrawn method', () => {
  it('cash withdrawn says Cash', () => {
    expect(paymentMethodWithdrawnCopy('cash')).toBe(
      'Cash payments are no longer available. Please choose another method.'
    )
  })

  it('card withdrawn says Card, and does NOT say Cash', () => {
    // The live regression. Before the fix this read "Cash ... Please select Card."
    const text = paymentMethodWithdrawnCopy('card')
    expect(text).toContain('Card payments are no longer available')
    expect(text).not.toContain('Cash')
  })

  it('never tells the customer to select a specific method', () => {
    // Nothing in this module knows which of the remaining methods are still enabled, so naming
    // one is a guess. The refreshed selector is what tells the truth about what is available.
    for (const p of ['cash', 'card', 'other', null] as Array<PaymentPreference | null>) {
      const text = paymentMethodWithdrawnCopy(p)
      expect(text).not.toMatch(/select (Card|Cash)/i)
      expect(text).toContain('choose another method')
    }
  })

  it('each method produces a message naming only itself', () => {
    const cash = paymentMethodWithdrawnCopy('cash')
    const card = paymentMethodWithdrawnCopy('card')
    expect(cash).not.toBe(card)
    expect(cash.startsWith('Cash')).toBe(true)
    expect(card.startsWith('Card')).toBe(true)
  })

  it('a null or other preference degrades to a neutral sentence, not to Cash', () => {
    // `other` cannot reach this branch -- the route guards `paymentPreference !== 'other'` -- but
    // a client must not depend on a server guard staying where it is, and the failure must not be
    // "assume cash", which is precisely the bug being fixed.
    expect(paymentMethodWithdrawnCopy('other')).toBe(
      'That payments are no longer available. Please choose another method.'
    )
    expect(paymentMethodWithdrawnCopy(null)).not.toContain('Cash')
  })

  it('the title is unchanged', () => {
    expect(PAYMENT_METHOD_WITHDRAWN_TITLE).toBe('Payment option unavailable')
  })
})
