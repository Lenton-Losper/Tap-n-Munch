import { readFileSync } from 'node:fs'
import {
  isStillSettling,
  CONFIRM_SETTLE_MAX_ATTEMPTS,
  CONFIRM_SETTLE_RETRY_MS,
} from '@/lib/customer-copy/qr-redesign-copy'

/**
 * #337 — STILL SETTLING RETRIES ITSELF, AND CANNOT FIND DOES NOT.
 *
 * The confirmation screen showed one message for two different truths: a gateway return that landed
 * ahead of its row (transient — will resolve on its own) and a reference that can never match
 * (permanent). It told the customer to "wait a moment and refresh", while its only button navigated
 * away from the page they would refresh.
 *
 * The half that is easy to get wrong is the BOUND. A retry with no ceiling leaves a customer
 * watching a spinner for a lookup that will never succeed; a retry that also covers the permanent
 * reasons does the same thing for reasons that were never transient to begin with.
 *
 * These assertions are on the predicate the SCREEN uses, not a copy of its logic, because the whole
 * reason it is a function is that two call sites have to agree: the effect that schedules the next
 * attempt and the render that picks the message and the button. If those drift, a customer reads
 * "we cannot find your order" while the page is still quietly retrying.
 */
describe('which state the screen is in', () => {
  it('a tn-miss on the first attempt is STILL SETTLING', () => {
    expect(isStillSettling('tn-miss', 0)).toBe(true)
  })

  it('stays settling right up to the last attempt', () => {
    expect(isStillSettling('tn-miss', CONFIRM_SETTLE_MAX_ATTEMPTS - 1)).toBe(true)
  })

  it('STOPS at the bound, so the spinner is not forever', () => {
    expect(isStillSettling('tn-miss', CONFIRM_SETTLE_MAX_ATTEMPTS)).toBe(false)
    expect(isStillSettling('tn-miss', CONFIRM_SETTLE_MAX_ATTEMPTS + 5)).toBe(false)
  })

  it.each(['no-context', 'fallback-empty', null, undefined, ''])(
    'never settles for %s — waiting cannot supply a reference that was never in the URL',
    (reason) => {
      expect(isStillSettling(reason as string | null | undefined, 0)).toBe(false)
    },
  )

  it('the bound and the interval are a sane customer wait', () => {
    // Four tries two seconds apart is about eight seconds. Pinned because both halves are customer
    // experience, not implementation detail: raising either is a decision, not a tweak.
    expect(CONFIRM_SETTLE_MAX_ATTEMPTS).toBe(4)
    expect(CONFIRM_SETTLE_RETRY_MS).toBe(2000)
    expect(CONFIRM_SETTLE_MAX_ATTEMPTS * CONFIRM_SETTLE_RETRY_MS).toBeLessThanOrEqual(10_000)
  })
})

describe('the screen actually uses the predicate', () => {
  const PAGE = readFileSync('app/order-confirmation/page.tsx', 'utf8')

  it('the retry effect asks it rather than re-deriving the condition', () => {
    // A second copy of the condition is how the message and the retry come apart.
    expect(PAGE).toMatch(/isStillSettling\(notFoundReason, settleAttempts\)/)
    const uses = PAGE.match(/isStillSettling\(/g) ?? []
    expect(uses.length).toBeGreaterThanOrEqual(2)
  })

  it('schedules the next attempt rather than telling the customer to refresh', () => {
    // The original copy said "wait a moment and refresh" while its one button left the page.
    expect(PAGE).toMatch(/setSettleAttempts\(\(n\) => n \+ 1\)/)
    expect(PAGE).toMatch(/CONFIRM_SETTLE_RETRY_MS/)
  })

  it('no longer prints a raw reference at the customer', () => {
    // A UUID is not something anyone can read down a phone to staff.
    expect(PAGE).not.toMatch(/\{orderRef\}/)
  })
})
