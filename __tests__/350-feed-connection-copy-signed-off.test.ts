/**
 * #350's feed-connection labels are SIGNED. This pins them.
 *
 * It replaces `350-feed-connection-copy-pending.test.ts`, which asserted the opposite — that every
 * string still carried a `PENDING COPY` marker. That test was a tripwire for this exact moment and
 * it fired correctly the instant the owner's wording went in. Deleting it without putting this in
 * its place would have left the signed copy with no protection at all, which is how the sound
 * labels came to need a gate in the first place.
 *
 * WHY EXACT-STRING ASSERTIONS RATHER THAN "CONTAINS THE GIST". Copy is signed as a literal. A test
 * that accepted any string mentioning "reconnecting" would let a well-meaning reword through
 * without a second sign-off, and the reword is exactly what needs approving.
 */
import { FEED_CONNECTION_COPY } from '@/lib/dashboard/feed-connection-copy'

const SIGNED = {
  live: 'orders are arriving here as they happen',
  reconnecting: 'reconnecting - the list may be a moment behind',
  offline:
    'not receiving new orders. this list is refreshing slowly and orders may be missing. check the connection or reload.',
} as const

describe('#350 feed-connection copy — signed 2026-08-26', () => {
  it('matches the signed wording exactly, character for character', () => {
    expect(FEED_CONNECTION_COPY.live).toBe(SIGNED.live)
    expect(FEED_CONNECTION_COPY.reconnecting).toBe(SIGNED.reconnecting)
    expect(FEED_CONNECTION_COPY.offline).toBe(SIGNED.offline)
  })

  it('carries no placeholder marker on any state', () => {
    for (const [state, label] of Object.entries(FEED_CONNECTION_COPY)) {
      expect(`${state}: ${label}`).not.toMatch(/PENDING COPY|PLACEHOLDER|TODO/i)
    }
  })

  it('uses an ASCII hyphen, never an em dash', () => {
    // The payment-screen rule. An em dash substituted by an editor or a "smart quotes" pass is a
    // silent reword of signed copy, and it renders differently on the terminal's font stack.
    for (const label of Object.values(FEED_CONNECTION_COPY)) {
      expect(label).not.toMatch(/[–—]/)
    }
    expect(FEED_CONNECTION_COPY.reconnecting).toContain(' - ')
  })

  it('says orders may be MISSING, not merely late, in the offline state', () => {
    // The load-bearing half. "The list is a moment behind" is survivable and staff will wait it
    // out; "orders may be missing" is the fact that makes them act. A reword that softens this
    // into lateness turns the one actionable state into another blip they learn to ignore.
    expect(FEED_CONNECTION_COPY.offline).toContain('missing')
  })

  it('keeps exactly ONE imperative across the whole set — offline', () => {
    // Same rule as ORDER_ALERT_COPY. Two instructions in a status readout become two competing
    // demands, and a staff member reading three states each telling them to do something stops
    // reading any of them.
    const imperative = /\b(check|reload|tell|call|refresh|restart)\b/i
    expect(imperative.test(FEED_CONNECTION_COPY.live)).toBe(false)
    expect(imperative.test(FEED_CONNECTION_COPY.reconnecting)).toBe(false)
    expect(imperative.test(FEED_CONNECTION_COPY.offline)).toBe(true)
  })

  it('states a fact and gives no instruction while reconnecting', () => {
    // Deliberate: this state resolves itself. Telling staff to act on a two-second blip trains
    // them to ignore the indicator, which is the failure the sound indicator's docblock names.
    expect(FEED_CONNECTION_COPY.reconnecting).not.toMatch(/reload|check/i)
  })
})
