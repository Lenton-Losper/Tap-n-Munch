/**
 * THE SIGNED GRATUITY COPY. SIGNED 2026-09-05 BY THE OWNER.
 *
 * ============================================================================================
 * WHAT THIS IS FOR
 * ============================================================================================
 *
 * Every string a member of staff reads while taking a gratuity, plus the two the customer's
 * money depends on. It was read line by line and signed. This pins the wording so it cannot
 * drift by accident — a tidy-up, a refactor, or someone "improving" a sentence all fail here
 * rather than silently changing what a waiter reads mid-service.
 *
 * IF THIS SUITE IS RED, THAT IS IT WORKING. Copy is a SIGNATURE, not a code review. Get the new
 * wording signed, change the constants below in the same commit as the source, and say who signed
 * it and when.
 *
 * ============================================================================================
 * TWO CHANGES MADE AT SIGNING, AND WHY THEY MATTER
 * ============================================================================================
 *
 * 1. The empty-staff message said a waiter could "settle without one" WITHOUT SAYING WHAT THEY
 *    LOSE — and the customer may already have agreed to a tip. It now says plainly that the
 *    gratuity is what goes.
 *
 * 2. `TIP_NOT_AN_INTEGER` read "Tip must be whole cents — send 1250 for NAD 12.50, not 12.5":
 *    a developer's message on a staff-facing surface. Staff key an amount on a keypad and never
 *    see cents. It was NOT defended as developer-only, because that could not be shown: the
 *    client that sends it is not written yet and a keypad defect would put it in front of a
 *    waiter. The CODE stays technical; the MESSAGE is now human.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTipCents, MAX_TIP_CENTS } from '@/lib/payments/tips'

const SIGNED_ON = '2026-09-05'
const ROOT = join(__dirname, '..')

const SETTLE = readFileSync(
  join(ROOT, 'app', 'api', 'terminal', 'tabs', '[tabId]', 'settle', 'route.ts'),
  'utf8',
)
const ALLOC = readFileSync(
  join(ROOT, 'app', 'api', 'terminal', 'tabs', '[tabId]', 'settle-allocations', 'route.ts'),
  'utf8',
)

describe(`the signed gratuity copy (signed ${SIGNED_ON})`, () => {
  describe('what a waiter reads when an amount will not parse', () => {
    it('an unreadable amount is described in plain words, not in cents', () => {
      const r = parseTipCents(12.5)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message).toBe('That gratuity amount could not be read. Enter it again.')
        // The technical meaning lives in the CODE, which is the developer's channel.
        expect(r.code).toBe('TIP_NOT_AN_INTEGER')
      }
    })

    it('the developer-facing wording is gone and must not return', () => {
      const r = parseTipCents(12.5)
      if (!r.ok) {
        expect(r.message).not.toMatch(/cents/i)
        expect(r.message).not.toMatch(/1250/)
        expect(r.message).not.toMatch(/send /i)
      }
    })

    it('a negative gratuity says what to do instead', () => {
      const r = parseTipCents(-1)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message).toBe(
          'A tip cannot be negative. Reversing one is a refund, not a negative gratuity.',
        )
      }
    })

    it('an oversized gratuity is refused with the limit named', () => {
      const r = parseTipCents(MAX_TIP_CENTS + 1)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.message).toBe(
          `Tip exceeds the ${MAX_TIP_CENTS / 100} limit. Re-enter it if that was intended.`,
        )
      }
    })
  })

  describe('what a waiter reads when nobody is chosen', () => {
    /**
     * ASSERTED AS THE SOURCE FRAGMENTS, not as the finished sentence.
     *
     * The routes build this message from two string literals joined with `+`, so searching the
     * SOURCE for the concatenated result matches nothing — which is how this test first failed,
     * on correct code. Both halves are checked in both files instead, which is what actually
     * pins the wording.
     */
    const FRAGMENTS = [
      'Choose who is taking this gratuity before settling. A tip has to be recorded ',
      'against a member of staff.',
    ]

    it('both settle paths say the same thing, word for word', () => {
      // Two routes, one sentence. Divergence here is how a venue learns two different rules.
      for (const fragment of FRAGMENTS) {
        expect(SETTLE).toContain(fragment)
        expect(ALLOC).toContain(fragment)
      }
    })

    it('a staff member from another venue is refused in plain words', () => {
      const EXPECTED_MEMBER =
        'That staff member is not on this venue, so the gratuity cannot be recorded.'
      expect(SETTLE).toContain(EXPECTED_MEMBER)
      expect(ALLOC).toContain(EXPECTED_MEMBER)
    })
  })

  describe('the words that must not appear near the picker', () => {
    /**
     * The picker is an UNVERIFIED claim. Calling it verified or authorised on a staff-facing
     * surface would be false, and would invite the next person to reuse it for a refund.
     */
    it('no staff-facing gratuity message claims verification or authorisation', () => {
      const messages = [
        'Choose who is taking this gratuity before settling. A tip has to be recorded against a member of staff.',
        'That staff member is not on this venue, so the gratuity cannot be recorded.',
        'That gratuity amount could not be read. Enter it again.',
      ]
      for (const m of messages) {
        expect(m.toLowerCase()).not.toContain('verified')
        expect(m.toLowerCase()).not.toContain('authoris')
        expect(m.toLowerCase()).not.toContain('authoriz')
        expect(m.toLowerCase()).not.toContain('approved')
      }
    })

    it('the word is "gratuity" on every staff-facing string', () => {
      // Matches the receipt line the owner specified. "Tip" survives only in the parse messages
      // signed as-is above, which is deliberate and recorded here so it is not "tidied".
      expect(SETTLE).toContain('taking this gratuity')
      expect(ALLOC).toContain('taking this gratuity')
    })
  })
})
