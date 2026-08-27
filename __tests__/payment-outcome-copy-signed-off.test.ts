/**
 * The six payment-path staff strings, SIGNED 2026-08-27, pinned character for character.
 *
 * WHY EXACT STRINGS RATHER THAN "CONTAINS THE GIST". Copy is signed as a literal. A test that
 * accepted any sentence about an unavailable card reader would let a well-meaning reword through
 * without a second sign-off, and the reword is exactly what needs approving.
 *
 * THREE OF THESE SPENT DAYS ON PRODUCTION UNSIGNED. `verify-payment-outcome.ts` spelled its
 * placeholders `[COPY PENDING: ...]`, which the gate's `/PENDING COPY/` marker did not match.
 * Nobody read them only because the terminal's response type has no field for the message. This
 * suite exists so the next reword is a decision rather than an accident.
 */
import {
  PREPARE_PAYMENT_STAFF_MESSAGE,
  PREPARE_PAYMENT_OUTCOME_CODES,
} from '@/lib/payments/prepare-payment-outcome'
import {
  VERIFY_PAYMENT_STAFF_MESSAGE,
  VERIFY_PAYMENT_OUTCOME_CODES,
} from '@/lib/payments/verify-payment-outcome'

const SIGNED_PREPARE = {
  [PREPARE_PAYMENT_OUTCOME_CODES.CARD_NOT_AVAILABLE_HERE]:
    'card payments are not set up at this venue. this will not resolve by trying again. take ' +
    'payment another way and let whoever set up the venue know.',
  [PREPARE_PAYMENT_OUTCOME_CODES.PREPARE_FAILED]:
    'this order cannot take a card payment right now. nothing has been charged. it needs looking ' +
    'at rather than retrying.',
  [PREPARE_PAYMENT_OUTCOME_CODES.READINESS_UNKNOWN]:
    'we could not check whether card payment is available here. nothing was started and no card ' +
    'was presented. try again shortly.',
} as const

const SIGNED_VERIFY = {
  [VERIFY_PAYMENT_OUTCOME_CODES.NOT_CONFIRMED]:
    'no confirmation yet. this can still change - check again shortly. do not take a second ' +
    'payment on the strength of this.',
  [VERIFY_PAYMENT_OUTCOME_CODES.PROVIDER_UNREACHABLE]:
    'we could not complete the check. the payment status is unknown, not failed. try again shortly.',
  [VERIFY_PAYMENT_OUTCOME_CODES.CREDENTIALS_NOT_CONFIGURED]:
    'card payments are not set up at this venue, so we cannot check what happened. retrying will ' +
    'not help. the card may still have been charged on the machine - do not take payment again ' +
    'until someone confirms.',
} as const

describe('#160 prepare-payment staff copy — signed 2026-08-27', () => {
  it('matches the signed wording exactly, for all three outcomes', () => {
    for (const [code, text] of Object.entries(SIGNED_PREPARE)) {
      expect(PREPARE_PAYMENT_STAFF_MESSAGE[code as never]).toBe(text)
    }
  })

  it('keeps the three states telling three DIFFERENT things to do', () => {
    // The defect this whole issue exists for: a loop of five identical retries in six minutes at
    // Digi Cofee, because one message covered three situations. Collapsing any two of these
    // removes the instruction that ends the loop.
    const a = PREPARE_PAYMENT_STAFF_MESSAGE[PREPARE_PAYMENT_OUTCOME_CODES.CARD_NOT_AVAILABLE_HERE]
    const b = PREPARE_PAYMENT_STAFF_MESSAGE[PREPARE_PAYMENT_OUTCOME_CODES.PREPARE_FAILED]
    const c = PREPARE_PAYMENT_STAFF_MESSAGE[PREPARE_PAYMENT_OUTCOME_CODES.READINESS_UNKNOWN]
    expect(new Set([a, b, c]).size).toBe(3)

    // permanent -> stop retrying;  order-specific -> look at it;  transient -> try again
    expect(a).toContain('will not resolve by trying again')
    expect(b).toContain('needs looking at rather than retrying')
    expect(c).toContain('try again shortly')
  })

  it('never claims a payment failed when none was attempted', () => {
    // CARD_NOT_AVAILABLE_HERE and READINESS_UNKNOWN both refuse BEFORE a card is presented.
    for (const code of [
      PREPARE_PAYMENT_OUTCOME_CODES.CARD_NOT_AVAILABLE_HERE,
      PREPARE_PAYMENT_OUTCOME_CODES.READINESS_UNKNOWN,
    ]) {
      expect(PREPARE_PAYMENT_STAFF_MESSAGE[code]).not.toMatch(/payment failed|declined|charge failed/i)
    }
  })

  it('READINESS_UNKNOWN must not say card payment is unavailable — it says we could not CHECK', () => {
    // The distinction #153 made and this issue applies one step earlier. Telling staff at a venue
    // that takes cards every day that it "is not set up" because one credential READ failed is a
    // different and worse error than saying nothing.
    const c = PREPARE_PAYMENT_STAFF_MESSAGE[PREPARE_PAYMENT_OUTCOME_CODES.READINESS_UNKNOWN]
    expect(c).toContain('could not check')
    expect(c).not.toContain('are not set up at this venue')
  })
})

describe('#153 verify-payment staff copy — signed 2026-08-27', () => {
  it('matches the signed wording exactly, for all three outcomes', () => {
    for (const [code, text] of Object.entries(SIGNED_VERIFY)) {
      expect(VERIFY_PAYMENT_STAFF_MESSAGE[code as never]).toBe(text)
    }
  })

  it('PINS the last clause of CREDENTIALS_NOT_CONFIGURED — the owner named it specifically', () => {
    // Owner instruction, 2026-08-27, verbatim: "Pin the last clause of
    // CREDENTIALS_NOT_CONFIGURED. 'do not take payment again until someone confirms' is the
    // load-bearing half and it is the kind of thing that gets shortened out."
    //
    // Without it the message reads "we can't check, retrying won't help" — which a staff member
    // facing an order that looks unpaid resolves by charging the card a second time. The clause is
    // the only thing standing between this message and a double charge.
    const s = VERIFY_PAYMENT_STAFF_MESSAGE[VERIFY_PAYMENT_OUTCOME_CODES.CREDENTIALS_NOT_CONFIGURED]
    expect(s).toContain('do not take payment again until someone confirms')
    // And the half that makes it necessary must survive too.
    expect(s).toContain('the card may still have been charged on the machine')
    // A shortened version that keeps the setup half and drops the money half must FAIL here.
    expect(s.endsWith('until someone confirms.')).toBe(true)
  })

  it('NOT_CONFIRMED forbids a second payment without claiming the first succeeded', () => {
    // Order #149 answered E04111 and was confirmed PAID on the same reference 22 seconds later.
    // This state is "not yet", never "not paid".
    const s = VERIFY_PAYMENT_STAFF_MESSAGE[VERIFY_PAYMENT_OUTCOME_CODES.NOT_CONFIRMED]
    expect(s).toContain('do not take a second payment')
    expect(s).toContain('can still change')
    expect(s).not.toMatch(/\bnot paid\b|\bfailed\b/i)
  })

  it('PROVIDER_UNREACHABLE says unknown, explicitly NOT failed', () => {
    const s = VERIFY_PAYMENT_STAFF_MESSAGE[VERIFY_PAYMENT_OUTCOME_CODES.PROVIDER_UNREACHABLE]
    expect(s).toContain('unknown, not failed')
  })

  it('carries no placeholder marker in either word order', () => {
    for (const s of [...Object.values(VERIFY_PAYMENT_STAFF_MESSAGE), ...Object.values(PREPARE_PAYMENT_STAFF_MESSAGE)]) {
      expect(s).not.toMatch(/PENDING[\s_-]*COPY|COPY[\s_-]*PENDING/i)
    }
  })

  it('uses an ASCII hyphen, never an em dash', () => {
    // A "smart quotes" pass or an editor autocorrect is a silent reword of signed copy, and the
    // terminal's font stack renders an em dash differently.
    for (const s of [...Object.values(VERIFY_PAYMENT_STAFF_MESSAGE), ...Object.values(PREPARE_PAYMENT_STAFF_MESSAGE)]) {
      expect(s).not.toMatch(/[–—]/)
    }
  })
})
