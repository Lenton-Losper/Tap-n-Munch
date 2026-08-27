/**
 * The E04111 persistence ruling (owner, 2026-08-27), and the rule it is bounded by.
 *
 * TWO RULES COEXIST IN `query-finatic-order-paid.ts` and this suite asserts BOTH directions,
 * because a test that only proved cancels are authorised would pass against a rule that authorises
 * every cancel — which is precisely the defect the older rule exists to prevent.
 *
 *   #149 IS THE COUNTER-EXAMPLE THAT BOUNDS THIS. Order #149 at Mingle went
 *   verification_uncertain -> completed on the SAME reference in 22 seconds. Every "must refuse"
 *   case below is a defence of that order.
 */
import {
  e04111PersistenceAuthorisesCancel,
  E04111_PERSISTENCE_CANCEL_MS,
  E04111_MIN_OBSERVATION_SEPARATION_MS,
} from '@/lib/payments/query-finatic-order-paid'

const NOW = new Date('2026-08-27T06:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000)

describe('E04111 persistence ruling — the 72h threshold', () => {
  it('AUTHORISES a cancel on the real shape of the six cleared on 2026-08-27', () => {
    // Order #435: attempt 2026-08-13T05:59:07, first observation 59 seconds later, still E04111
    // this morning. 14 days and 103 observations.
    const v = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: hoursAgo(14 * 24),
      observedAt: [hoursAgo(14 * 24 - 1), hoursAgo(24), hoursAgo(0.1)],
      reconfirmedNow: true,
      now: NOW,
    })
    expect(v.authorisesCancel).toBe(true)
    expect(v.reason).toBe('persisted_beyond_threshold')
    expect(v.observationCount).toBe(3)
  })

  it('REFUSES #149 — 22 seconds old, which is the case this rule must never touch', () => {
    // The whole reason the older rule exists. If this ever returns true, a payment that was about
    // to confirm gets cancelled.
    const v = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: new Date(NOW.getTime() - 22 * 1000),
      observedAt: [new Date(NOW.getTime() - 22 * 1000)],
      reconfirmedNow: true,
      now: NOW,
    })
    expect(v.authorisesCancel).toBe(false)
    expect(v.reason).toBe('too_recent')
  })

  it('REFUSES at 71h59m and AUTHORISES at 72h — the boundary is exact, not approximate', () => {
    const just_under = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: new Date(NOW.getTime() - (E04111_PERSISTENCE_CANCEL_MS - 60_000)),
      observedAt: [hoursAgo(71), hoursAgo(1)],
      reconfirmedNow: true,
      now: NOW,
    })
    expect(just_under.authorisesCancel).toBe(false)
    expect(just_under.reason).toBe('too_recent')

    const exactly = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: new Date(NOW.getTime() - E04111_PERSISTENCE_CANCEL_MS),
      observedAt: [hoursAgo(71), hoursAgo(1)],
      reconfirmedNow: true,
      now: NOW,
    })
    expect(exactly.authorisesCancel).toBe(true)
  })
})

describe('E04111 persistence ruling — the two-observation requirement', () => {
  it('REFUSES a single observation however old the order is', () => {
    // Age alone is not evidence. One sample of a system known to change its answer is one sample.
    const v = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: hoursAgo(30 * 24),
      observedAt: [hoursAgo(30 * 24)],
      reconfirmedNow: true,
      now: NOW,
    })
    expect(v.authorisesCancel).toBe(false)
    expect(v.reason).toBe('insufficient_observations')
  })

  it('REFUSES two observations minutes apart — a burst is one look, not two', () => {
    // The failure this catches: a retry loop firing five times in a minute would otherwise satisfy
    // "two observations" while proving nothing about persistence. Digi Cofee's order #28 produced
    // exactly that — five verification_uncertain rows in six minutes.
    const v = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: hoursAgo(10 * 24),
      observedAt: [hoursAgo(2), new Date(NOW.getTime() - 90 * 60 * 1000)],
      reconfirmedNow: true,
      now: NOW,
    })
    expect(v.authorisesCancel).toBe(false)
    expect(v.reason).toBe('observations_too_close_together')
  })

  it('AUTHORISES at exactly 24h separation', () => {
    const v = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: hoursAgo(10 * 24),
      observedAt: [
        new Date(NOW.getTime() - E04111_MIN_OBSERVATION_SEPARATION_MS - 1000),
        new Date(NOW.getTime() - 1000),
      ],
      reconfirmedNow: true,
      now: NOW,
    })
    expect(v.authorisesCancel).toBe(true)
  })
})

describe('E04111 persistence ruling — the fresh-query requirement', () => {
  it('REFUSES when the caller has not re-queried in this run, even if everything else holds', () => {
    // Condition 3. A verdict read from an earlier sweep describes a world that has since moved.
    const v = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: hoursAgo(14 * 24),
      observedAt: [hoursAgo(14 * 24), hoursAgo(1)],
      reconfirmedNow: false,
      now: NOW,
    })
    expect(v.authorisesCancel).toBe(false)
    expect(v.reason).toBe('not_reconfirmed_now')
  })

  it('reports not_reconfirmed_now BEFORE any other reason, so the log names the actionable fault', () => {
    // A caller that forgot to re-query AND has a young order should be told about the re-query,
    // because that is the bug in the caller; the age is incidental.
    const v = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: hoursAgo(1),
      observedAt: [],
      reconfirmedNow: false,
      now: NOW,
    })
    expect(v.reason).toBe('not_reconfirmed_now')
  })
})

describe('E04111 persistence ruling — the age anchor', () => {
  it('REFUSES when there is no payment_attempt_started_at, rather than falling back', () => {
    // Falling back to placed_at would measure a clock the gateway race does not run on: an order
    // placed a week ago whose card was presented ten minutes ago is TEN MINUTES old here.
    for (const missing of [null, undefined, '']) {
      const v = e04111PersistenceAuthorisesCancel({
        attemptStartedAt: missing as never,
        observedAt: [hoursAgo(200), hoursAgo(1)],
        reconfirmedNow: true,
        now: NOW,
      })
      expect(v.authorisesCancel).toBe(false)
      expect(v.reason).toBe('no_attempt_timestamp')
      expect(v.ageMs).toBeNull()
    }
  })

  it('REFUSES an unparseable timestamp rather than treating NaN as old', () => {
    const v = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: 'not-a-date',
      observedAt: [hoursAgo(200), hoursAgo(1)],
      reconfirmedNow: true,
      now: NOW,
    })
    expect(v.authorisesCancel).toBe(false)
    expect(v.reason).toBe('no_attempt_timestamp')
  })

  it('returns the age and observation span for the audit row', () => {
    // These are not diagnostics — the ruling requires the audit row to record the age and that the
    // cancel was authorised by persistence rather than by a paid=false answer.
    const v = e04111PersistenceAuthorisesCancel({
      attemptStartedAt: hoursAgo(100),
      observedAt: [hoursAgo(99), hoursAgo(2)],
      reconfirmedNow: true,
      now: NOW,
    })
    expect(v.ageMs).toBe(100 * 60 * 60 * 1000)
    expect(v.observationSpanMs).toBe(97 * 60 * 60 * 1000)
    expect(v.reason).toBe('persisted_beyond_threshold')
  })
})
