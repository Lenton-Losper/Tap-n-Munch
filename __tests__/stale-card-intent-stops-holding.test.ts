/**
 * A CARD HOLD MUST EXPIRE. THE INTENT ITSELF MUST NOT.
 *
 * ==================================================================================================
 * THE PRODUCTION FAILURE
 * ==================================================================================================
 *
 * Digi Cofee, 2026-09-07. terminal_payment_intents 538981e8:
 *
 *   status       uncertain
 *   resolved_at  07:13:24        <- the device DID come back
 *   created_at   07:12:20
 *   allocations  all four of order #47's
 *
 * Five and a half hours later a waiter tapping Settle Selected still met "Someone is already paying
 * for these by card." Nobody was paying. allocationIdsHeldByLiveCard filtered on status alone, so a
 * row that had already been resolved -- but whose status is terminal by design -- held its items
 * for ever. Nothing sweeps that table; there is no expiry anywhere.
 *
 * ==================================================================================================
 * WHAT IS AND IS NOT BEING CHANGED
 * ==================================================================================================
 *
 * NOT changed: the state machine. `uncertain` stays terminal, nothing resolves it automatically,
 * and the ruling at the top of payment-intents.ts is intact -- E04111 means NO RECORD, never NOT
 * PAID, so auto-settling is a free meal and auto-failing charges twice.
 *
 * Changed: only how long such a row may keep the till shut. Those were the same question purely
 * because the hold had no clock.
 *
 * So these tests assert the two separately, and the second is the one that protects the ruling:
 * a released hold must leave the row exactly as it found it.
 */
import {
  intentHoldIsStillLive,
  INTENT_HOLD_MAX_AGE_MS,
} from '@/lib/payments/payment-intents'

const NOW = Date.parse('2026-09-07T12:45:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

// ==================================================================================================
// A-G
// ==================================================================================================

describe('A. launched + recent', () => {
  it('blocks — a reader may be live right now', () => {
    expect(
      intentHoldIsStillLive({ status: 'launched', created_at: ago(30 * 1000), resolved_at: null }, NOW),
    ).toBe(true)
  })
})

describe('B. uncertain + recent', () => {
  it('blocks — the gateway may still answer yes', () => {
    /**
     * The case the hold exists for, and it must not regress. Releasing here would let a second
     * customer pay for the first customer's food while the first customer's card was settling.
     */
    expect(
      intentHoldIsStillLive({ status: 'uncertain', created_at: ago(2 * MINUTE), resolved_at: ago(MINUTE) }, NOW),
    ).toBe(true)
  })
})

describe('C. uncertain + resolved_at + stale', () => {
  it('does NOT block', () => {
    expect(
      intentHoldIsStillLive({ status: 'uncertain', created_at: ago(6 * HOUR), resolved_at: ago(5 * HOUR) }, NOW),
    ).toBe(false)
  })
})

describe('D. uncertain + unresolved + inside the window', () => {
  it('blocks', () => {
    // The device never came back. Within the window that is indistinguishable from a live reader.
    expect(
      intentHoldIsStillLive({ status: 'uncertain', created_at: ago(10 * MINUTE), resolved_at: null }, NOW),
    ).toBe(true)
  })
})

describe('E. confirmed', () => {
  it('never blocks', () => {
    expect(
      intentHoldIsStillLive({ status: 'confirmed', created_at: ago(MINUTE), resolved_at: ago(MINUTE) }, NOW),
    ).toBe(false)
  })
})

describe('F. failed', () => {
  it('never blocks', () => {
    expect(
      intentHoldIsStillLive({ status: 'failed', created_at: ago(MINUTE), resolved_at: ago(MINUTE) }, NOW),
    ).toBe(false)
  })
})

describe('G. a stale intent cannot block a new payment for ever', () => {
  it('releases once the window has passed, however old it gets', () => {
    for (const age of [2 * HOUR, 12 * HOUR, 7 * 24 * HOUR]) {
      expect(
        intentHoldIsStillLive({ status: 'uncertain', created_at: ago(age), resolved_at: null }, NOW),
      ).toBe(false)
    }
  })
})

// ==================================================================================================
// THE EXACT PRODUCTION ROW
// ==================================================================================================

describe('intent 538981e8, exactly as production holds it', () => {
  it('is NOT held', () => {
    const held = intentHoldIsStillLive(
      {
        status: 'uncertain',
        created_at: '2026-09-07T07:12:20.320Z',
        resolved_at: '2026-09-07T07:13:24.203Z',
      },
      Date.parse('2026-09-07T12:45:00.000Z'),
    )
    expect(held).toBe(false)
  })

  it('WAS held while it was fresh — the same row, an hour earlier', () => {
    /**
     * THE TWO-SIDED CONTROL. Asserting only that the stale row is released cannot tell a correct
     * age rule from one that released everything; this pins the same row on the other side of the
     * window.
     */
    const held = intentHoldIsStillLive(
      {
        status: 'uncertain',
        created_at: '2026-09-07T07:12:20.320Z',
        resolved_at: '2026-09-07T07:13:24.203Z',
      },
      Date.parse('2026-09-07T07:20:00.000Z'),
    )
    expect(held).toBe(true)
  })
})

// ==================================================================================================
// THE BOUNDARY, AND FAILING CLOSED
// ==================================================================================================

describe('the window boundary', () => {
  it('holds just inside it and releases just outside', () => {
    const justInside = { status: 'uncertain', created_at: ago(INTENT_HOLD_MAX_AGE_MS - 1000), resolved_at: null }
    const justOutside = { status: 'uncertain', created_at: ago(INTENT_HOLD_MAX_AGE_MS + 1000), resolved_at: null }
    expect(intentHoldIsStillLive(justInside, NOW)).toBe(true)
    expect(intentHoldIsStillLive(justOutside, NOW)).toBe(false)
  })

  it('is long enough that a real reader interaction can never be released mid-payment', () => {
    // CARD_IN_FLIGHT_TIMEOUT_SECONDS is 90. The window has to be comfortably beyond it.
    expect(INTENT_HOLD_MAX_AGE_MS).toBeGreaterThan(90 * 1000 * 10)
  })
})

describe('unknowns fail CLOSED', () => {
  it('a missing timestamp keeps holding', () => {
    expect(intentHoldIsStillLive({ status: 'uncertain', created_at: null, resolved_at: null }, NOW)).toBe(true)
  })

  it('an unparseable timestamp keeps holding', () => {
    expect(
      intentHoldIsStillLive({ status: 'uncertain', created_at: 'not-a-date', resolved_at: null }, NOW),
    ).toBe(true)
  })

  it('an unrecognised status does not hold', () => {
    // Only launched/uncertain ever held. An unknown status is not a hold this function invented.
    expect(intentHoldIsStillLive({ status: 'something-new', created_at: ago(0), resolved_at: null }, NOW)).toBe(false)
  })
})
