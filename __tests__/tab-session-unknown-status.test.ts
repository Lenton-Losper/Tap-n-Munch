/**
 * AN UNRECOGNISED TAB STATUS MUST NOT EVICT A CUSTOMER MID-MEAL.
 *
 * ============================================================================================
 * THE RULING THIS ENFORCES, AND THE CODE THAT CONTRADICTED IT
 * ============================================================================================
 *
 * lib/tab-status.ts records it in full:
 *
 *     "A DENYLIST, DELIBERATELY, AND NOT `!isActiveTabStatus`. An unrecognised status must not
 *      evict a customer who is in the middle of a meal: the failure mode being fixed here IS
 *      eviction, and a status this vocabulary has not heard of is not evidence that the party
 *      has left."
 *
 * Thirty lines away, `shouldClearTabAfterSettlement` did the opposite. Its last line was a bare
 * `return true`, so any status outside `open | ready_to_pay | settled | closed` fell through it
 * and answered "clear the session". contexts/tab-context.tsx calls it on EVERY poll, and the
 * answer runs `clearTabSession()` — the customer's tab is wiped and they are returned to the
 * landing page with a live meal in front of them.
 *
 * `tabs.status` has NO CHECK constraint, so the set is open-ended: a typo in any writer, or any
 * future value, triggers this. It does not need a new feature to go wrong.
 *
 * The same inverted allowlist was live on the receipt page, which called `handleSessionExpired`
 * for anything not in ACTIVE_TAB_STATUSES. That is the same eviction by another door and is
 * covered here too.
 *
 * ============================================================================================
 * WHAT "UNKNOWN" MEANS IN EACH DIRECTION
 * ============================================================================================
 *
 * The two mistakes are not symmetrical, which is the whole reason for the denylist:
 *
 *   keeping a session that should have ended  →  a customer sees a stale tab until the next poll
 *                                                 that returns a status the vocabulary knows.
 *   ending a session that should have kept    →  a customer mid-meal loses their tab, their
 *                                                 basket, and their way back to the bill.
 *
 * Nothing is weakened by choosing the first: cross-tenant safety on this path comes from the
 * session VERSION check and the restaurant scoping beside it, never from the status string.
 */
import {
  isTabSessionEndedStatus,
  shouldClearTabAfterSettlement,
  shouldRedirectFromTabReceipt,
  type TabRow,
} from '@/lib/tab-session'

const tab = (status: string | null | undefined, extra: Partial<TabRow> = {}): TabRow =>
  ({ id: 'tab-1', status, ...extra }) as TabRow

/** Every value the vocabulary actually knows, from lib/tab-status.ts. */
const ACTIVE = ['open', 'ready_to_pay']
const ENDED = ['settled', 'closed', 'completed', 'cancelled']

/**
 * Statuses the vocabulary has NOT heard of. Two are plausible typos of live values, two are
 * shapes a future feature would plausibly introduce, and one is a value the DATABASE would accept
 * today — `tabs.status` carries no CHECK constraint.
 */
const UNKNOWN = ['ordering_stopped', 'oepn', 'READY_TO_PAY_', 'on_hold', 'paused']

describe('shouldClearTabAfterSettlement', () => {
  it.each(ACTIVE)('keeps the session on an active status: %s', (status) => {
    expect(shouldClearTabAfterSettlement(tab(status))).toBe(false)
  })

  it.each(ENDED)('clears the session on a genuinely ended status: %s', (status) => {
    expect(shouldClearTabAfterSettlement(tab(status))).toBe(true)
  })

  it.each(UNKNOWN)('does NOT evict on an unrecognised status: %s', (status) => {
    expect(shouldClearTabAfterSettlement(tab(status))).toBe(false)
  })

  it('does not evict on an empty status string', () => {
    // A row read through a projection that omitted the column answers '' here. That is "not read",
    // not "finished".
    expect(shouldClearTabAfterSettlement(tab(''))).toBe(false)
    expect(shouldClearTabAfterSettlement(tab(null))).toBe(false)
    expect(shouldClearTabAfterSettlement(tab(undefined))).toBe(false)
  })

  it('is case-insensitive about the statuses it does know', () => {
    expect(shouldClearTabAfterSettlement(tab('SETTLED'))).toBe(true)
    expect(shouldClearTabAfterSettlement(tab('Open'))).toBe(false)
  })

  it('still shows the card-payment thank-you rather than clearing', () => {
    expect(
      shouldClearTabAfterSettlement(tab('settled', { settled_type: 'card_payment' })),
    ).toBe(false)
  })

  it('still clears when there is no tab at all', () => {
    // Unchanged, and deliberately so: "no tab" is a different input from "a status I do not
    // recognise". This test pins that the fix did not quietly widen to that case.
    expect(shouldClearTabAfterSettlement(null)).toBe(true)
    expect(shouldClearTabAfterSettlement(undefined)).toBe(true)
  })
})

describe('shouldRedirectFromTabReceipt', () => {
  it.each(ACTIVE)('stays on the receipt for an active status: %s', (status) => {
    expect(shouldRedirectFromTabReceipt(tab(status))).toBe(false)
  })

  it.each(ENDED)('redirects away on a genuinely ended status: %s', (status) => {
    expect(shouldRedirectFromTabReceipt(tab(status))).toBe(true)
  })

  it.each(UNKNOWN)('does NOT redirect on an unrecognised status: %s', (status) => {
    expect(shouldRedirectFromTabReceipt(tab(status))).toBe(false)
  })
})

describe('the predicate the fix leans on', () => {
  it('answers false for everything outside the ended vocabulary', () => {
    for (const status of [...ACTIVE, ...UNKNOWN, '', null, undefined]) {
      expect(isTabSessionEndedStatus(status)).toBe(false)
    }
    for (const status of ENDED) {
      expect(isTabSessionEndedStatus(status)).toBe(true)
    }
  })
})
