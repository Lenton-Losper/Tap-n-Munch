/**
 * RC-RACES 2026-09-30: the route's early read of the one-terminal-per-attempt rule must agree with
 * the FTOWN trigger (20260930110000). The race itself is proven in two real sessions by
 * supabase/tests/charge-owner-race.test.sh and over HTTP by the concurrency-races chaos scenario.
 */
import {
  CHARGE_ATTEMPT_WINDOW_SECONDS,
  chargeOwnedElsewhereBody,
  secondsUntilAttemptLapses,
} from '@/lib/payments/charge-attempt-owner'

const NOW = Date.parse('2026-09-30T12:00:00Z')
const A = 'terminal-a'
const B = 'terminal-b'
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

describe('secondsUntilAttemptLapses', () => {
  it('refuses another terminal while its attempt is inside the window', () => {
    expect(secondsUntilAttemptLapses({ pending_charge_cents: 100, pending_charge_terminal_id: A, pending_charge_at: at(60) }, B, NOW))
      .toBe(CHARGE_ATTEMPT_WINDOW_SECONDS - 60)
  })
  it('never refuses the owning terminal (a retry of its own attempt)', () => {
    expect(secondsUntilAttemptLapses({ pending_charge_cents: 100, pending_charge_terminal_id: A, pending_charge_at: at(1) }, A, NOW)).toBeNull()
  })
  it('lets another terminal take over once the attempt has lapsed', () => {
    expect(secondsUntilAttemptLapses({ pending_charge_cents: 100, pending_charge_terminal_id: A, pending_charge_at: at(301) }, B, NOW)).toBeNull()
  })
  it('does not refuse when nothing is in flight or the owner is unknown', () => {
    expect(secondsUntilAttemptLapses({ pending_charge_cents: null, pending_charge_terminal_id: A, pending_charge_at: at(1) }, B, NOW)).toBeNull()
    expect(secondsUntilAttemptLapses({ pending_charge_cents: 100, pending_charge_terminal_id: null, pending_charge_at: at(1) }, B, NOW)).toBeNull()
  })
  it('fails closed on a missing timestamp, as the trigger does', () => {
    expect(secondsUntilAttemptLapses({ pending_charge_cents: 100, pending_charge_terminal_id: A, pending_charge_at: null }, B, NOW))
      .toBe(CHARGE_ATTEMPT_WINDOW_SECONDS)
  })
})

describe('chargeOwnedElsewhereBody', () => {
  it('answers with the code every terminal build already treats as a pre-reader refusal', () => {
    const body = chargeOwnedElsewhereBody([{ id: 'o1', order_number: 7 }], 42)
    expect(body).toMatchObject({
      code: 'SETTLEMENT_SET_NOT_CLAIMABLE',
      payment_in_progress_elsewhere: true,
      retry_after_seconds: 42,
      not_claimable: [{ order_id: 'o1', order_number: 7, reason: 'payment_in_progress_elsewhere' }],
    })
  })
})
