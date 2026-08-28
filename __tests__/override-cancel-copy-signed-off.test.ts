/**
 * THE FOUR OVERRIDE STRINGS, PINNED CHARACTER FOR CHARACTER. OWNER, 2026-08-28.
 *
 * Modelled on `clear-held-for-review-copy-signed-off.test.ts`. Copy is signed as a LITERAL, not as
 * a gist: a test asserting "mentions the card may have been charged" would pass for a reword that
 * changed the register entirely, and the register is what was signed. Change one of these and this
 * suite goes red — which is the point. Getting it green again is a decision, not an edit.
 *
 * PROOF CEILING: STATIC. This proves the strings are what was approved. It does not prove they are
 * rendered, or rendered on the right control — the panel test covers that.
 */
import {
  OVERRIDE_CANCEL_COPY,
  OVERRIDE_CANCEL_PINNED_SENTENCE,
  OVERRIDE_CANCEL_REFUSAL_COPY,
} from '@/lib/orders/override-cancel-copy'

describe('the signed override copy', () => {
  it('button', () => {
    expect(OVERRIDE_CANCEL_COPY.button).toBe('Cancel this order anyway')
  })

  it('title', () => {
    expect(OVERRIDE_CANCEL_COPY.title).toBe('Cancel this order?')
  })

  it('body, verbatim', () => {
    expect(OVERRIDE_CANCEL_COPY.body).toBe(
      'The payment provider still has no record of this order, and it is not old enough for us ' +
        'to be sure. The card may have been charged. Cancelling now is your decision, not the ' +
        "system's, and it will be recorded against your name. Only do this if you know what " +
        'happened at the card machine.',
    )
  })

  it('confirm', () => {
    expect(OVERRIDE_CANCEL_COPY.confirm).toBe('Yes, cancel it')
  })
})

/**
 * The owner pinned this sentence BY NAME, separately from the whole-body match, exactly as
 * `allGatewayCallsFailed` pins 'This does NOT mean they were unpaid'.
 *
 * It is the only sentence in the dialog that states the actual risk — money that may already have
 * left a customer's account. It is also the most shortenable: a tidier who keeps "the provider has
 * no record" and drops this turns a warning into reassurance.
 */
describe('the sentence the owner pinned by name', () => {
  it('appears in the body verbatim', () => {
    expect(OVERRIDE_CANCEL_COPY.body).toContain(OVERRIDE_CANCEL_PINNED_SENTENCE)
    expect(OVERRIDE_CANCEL_PINNED_SENTENCE).toBe('The card may have been charged.')
  })

  it('is not softened into a conditional', () => {
    // "may have been charged" is the signed wording. "might have", "could have" and "may have
    // been charged in some cases" are all rewords that need a second sign-off.
    expect(OVERRIDE_CANCEL_COPY.body).not.toMatch(/might have been charged/i)
    expect(OVERRIDE_CANCEL_COPY.body).not.toMatch(/could have been charged/i)
  })
})

/**
 * The clause the owner CHANGED at sign-off. Asserted in both directions so the earlier, more
 * accusatory wording cannot come back in a tidy-up.
 *
 * Same fact, different register: the point is that the action is attributable, not that the person
 * doing it is in trouble. Copy that reads as an accusation makes the safe action feel like the
 * risky one, and then nobody presses it and the board only grows.
 */
describe('the register change made at sign-off', () => {
  it('says it will be recorded against your NAME', () => {
    expect(OVERRIDE_CANCEL_COPY.body).toContain('it will be recorded against your name')
  })

  it('does NOT carry the pre-sign-off wording', () => {
    expect(OVERRIDE_CANCEL_COPY.body).not.toContain('it is recorded against you')
  })
})

/**
 * THE REFUSAL THAT CANNOT BE OVERRIDDEN. An override is permission to overrule a TIMING rule; it is
 * never permission to cancel an order the provider reports as paid.
 */
describe('the paid refusal', () => {
  it('says the order was NOT cancelled, and what to do instead', () => {
    expect(OVERRIDE_CANCEL_REFUSAL_COPY.gateway_reports_paid).toBe(
      'The payment provider now reports this order as PAID, so it has not been cancelled. ' +
        'Refund it instead if the customer is owed money.',
    )
  })

  it('never tells staff an unreachable provider means unpaid', () => {
    expect(OVERRIDE_CANCEL_REFUSAL_COPY.gateway_unreachable).toContain(
      'The card may have been charged.',
    )
    expect(OVERRIDE_CANCEL_REFUSAL_COPY.gateway_status_unrecognised).toContain(
      'Do not assume this order is unpaid.',
    )
  })
})

/**
 * No string on this control may ship carrying the PENDING marker: all four were signed. This is the
 * same gate `scripts/check-no-pending-copy.mjs` enforces on the production deploy, asserted here so
 * it fails in the suite rather than at deploy time.
 */
describe('nothing here is unsigned', () => {
  it('carries no PENDING COPY marker', () => {
    const all = [
      ...Object.values(OVERRIDE_CANCEL_COPY),
      ...Object.values(OVERRIDE_CANCEL_REFUSAL_COPY),
    ]
    for (const s of all) expect(s).not.toMatch(/PENDING COPY/i)
  })
})
