/**
 * Cash settlement status rules.
 *
 * The decision these encode: cash may be taken for an order at any point EXCEPT while a card
 * payment is genuinely in flight against that same order, because the gateway may still answer
 * yes and the customer would be collected on twice. Everything else -- including an order that
 * was pushed to the terminal earlier, or whose card attempt failed -- stays payable in cash.
 */
import {
  CARD_IN_FLIGHT_TIMEOUT_SECONDS,
  CASH_SETTLEABLE_PAYMENT_STATUSES,
  CLAIMABLE_PAYMENT_STATUSES,
  isCardPaymentStillInFlight,
  isCashSettleablePaymentStatus,
  isClaimablePaymentStatus,
  isMidFlightCardPayment,
  normalizeSettlementPaymentMethod,
  OWES_MONEY_PAYMENT_STATUSES,
  owesMoney,
  secondsSincePush,
  settleableStatusesForMethod,
} from '@/lib/payments/payment-integrity'

/** Every value actually written to orders.payment_status anywhere in the codebase. */
const WRITTEN_STATUSES = [
  'pending',
  'paid',
  'cancelled',
  'failed',
  'cash_pending',
  'terminal_pending',
] as const

describe('cash settleability', () => {
  it('allows cash for an ordinary unpaid order', () => {
    expect(isCashSettleablePaymentStatus('pending')).toBe(true)
  })

  it('allows cash for an order already flagged as paying by cash', () => {
    // The cancel-terminal path parks orders here; before this change they could never be
    // settled at all -- the claim skipped them and the endpoint said "already paid".
    expect(isCashSettleablePaymentStatus('cash_pending')).toBe(true)
  })

  it('allows cash after a failed card attempt', () => {
    // Money is genuinely owed. This is the case that would have stranded a guest at the table.
    expect(isCashSettleablePaymentStatus('failed')).toBe(true)
  })

  it('refuses cash while a card payment is in flight', () => {
    expect(isCashSettleablePaymentStatus('terminal_pending')).toBe(false)
    expect(isMidFlightCardPayment('terminal_pending')).toBe(true)
  })

  it('refuses cash for orders that are settled or void', () => {
    expect(isCashSettleablePaymentStatus('paid')).toBe(false)
    expect(isCashSettleablePaymentStatus('cancelled')).toBe(false)
  })

  it('does not block cash merely because the order touched the terminal before', () => {
    // A blanket "never pushed to card" rule would be too restrictive for how staff operate.
    // Only the live attempt blocks; a resolved one does not.
    const resolvedAfterCardAttempt = ['cash_pending', 'failed']
    for (const status of resolvedAfterCardAttempt) {
      expect(isCashSettleablePaymentStatus(status)).toBe(true)
    }
  })

  it('normalises case and whitespace so a stray value cannot slip through', () => {
    expect(isCashSettleablePaymentStatus('  Cash_Pending ')).toBe(true)
    expect(isMidFlightCardPayment(' TERMINAL_PENDING')).toBe(true)
    expect(isCashSettleablePaymentStatus('PAID')).toBe(false)
  })

  it('treats unknown and empty statuses as not settleable', () => {
    for (const status of [undefined, null, '', 'nonsense']) {
      expect(isCashSettleablePaymentStatus(status)).toBe(false)
    }
  })
})

describe('owesMoney', () => {
  it('counts every status where the restaurant has not been paid', () => {
    for (const status of ['pending', 'cash_pending', 'failed', 'terminal_pending']) {
      expect(owesMoney(status)).toBe(true)
    }
  })

  it('excludes settled and void orders', () => {
    expect(owesMoney('paid')).toBe(false)
    expect(owesMoney('cancelled')).toBe(false)
  })

  it('is a superset of what a card settlement can claim', () => {
    // The gap between these two sets is exactly what used to vanish from a tab's unpaid
    // total and let can_close report true over real debt.
    for (const status of CLAIMABLE_PAYMENT_STATUSES) {
      expect(OWES_MONEY_PAYMENT_STATUSES).toContain(status)
    }
    expect(OWES_MONEY_PAYMENT_STATUSES.length).toBeGreaterThan(
      CLAIMABLE_PAYMENT_STATUSES.length,
    )
  })

  it('classifies every status the codebase actually writes', () => {
    // Guards the real failure mode: a new status added to a write path but not to these sets
    // would silently become invisible debt.
    for (const status of WRITTEN_STATUSES) {
      const settled = status === 'paid' || status === 'cancelled'
      expect(owesMoney(status)).toBe(!settled)
    }
  })
})

describe('settleableStatusesForMethod', () => {
  it('leaves card behaviour exactly as it was', () => {
    expect(settleableStatusesForMethod('card')).toEqual(CLAIMABLE_PAYMENT_STATUSES)
  })

  it('gives cash the wider set', () => {
    expect(settleableStatusesForMethod('cash')).toEqual(CASH_SETTLEABLE_PAYMENT_STATUSES)
  })

  it('never lets either method claim an in-flight card payment', () => {
    for (const method of ['card', 'cash'] as const) {
      expect(settleableStatusesForMethod(method)).not.toContain('terminal_pending')
    }
  })

  it('never lets either method re-claim a paid order', () => {
    for (const method of ['card', 'cash'] as const) {
      expect(settleableStatusesForMethod(method)).not.toContain('paid')
    }
  })
})

describe('card in-flight timeout', () => {
  const NOW = new Date('2026-08-01T12:00:00.000Z')
  const agoSeconds = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString()

  it('is set within the band the timeout was specified against', () => {
    expect(CARD_IN_FLIGHT_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(45)
    expect(CARD_IN_FLIGHT_TIMEOUT_SECONDS).toBeLessThanOrEqual(120)
  })

  it('blocks cash while the attempt is fresh', () => {
    expect(isCardPaymentStillInFlight('terminal_pending', agoSeconds(1), NOW)).toBe(true)
    expect(isCardPaymentStillInFlight('terminal_pending', agoSeconds(30), NOW)).toBe(true)
  })

  it('still blocks one second before the timeout', () => {
    expect(
      isCardPaymentStillInFlight(
        'terminal_pending',
        agoSeconds(CARD_IN_FLIGHT_TIMEOUT_SECONDS - 1),
        NOW,
      ),
    ).toBe(true)
  })

  it('releases exactly at the timeout', () => {
    expect(
      isCardPaymentStillInFlight(
        'terminal_pending',
        agoSeconds(CARD_IN_FLIGHT_TIMEOUT_SECONDS),
        NOW,
      ),
    ).toBe(false)
  })

  it('releases well past the timeout', () => {
    expect(isCardPaymentStillInFlight('terminal_pending', agoSeconds(600), NOW)).toBe(false)
  })

  it('treats a missing push time as expired, never as permanently in flight', () => {
    // Rows predating the terminal_pushed_at column. Blocking them forever is the exact
    // failure the timeout exists to prevent.
    for (const pushedAt of [null, undefined, '', 'not-a-date']) {
      expect(isCardPaymentStillInFlight('terminal_pending', pushedAt, NOW)).toBe(false)
    }
  })

  it('only ever applies to the in-flight status', () => {
    // A fresh timestamp on any other status must not start blocking cash.
    for (const status of ['pending', 'cash_pending', 'failed', 'paid', 'cancelled']) {
      expect(isCardPaymentStillInFlight(status, agoSeconds(1), NOW)).toBe(false)
    }
  })

  it('clamps a future push time instead of extending the block', () => {
    // Clock skew between the app server and the database must not hold cash off indefinitely.
    const future = new Date(NOW.getTime() + 3_600_000).toISOString()
    expect(secondsSincePush(future, NOW)).toBe(0)
    expect(isCardPaymentStillInFlight('terminal_pending', future, NOW)).toBe(true)
  })

  it('measures elapsed time in seconds', () => {
    expect(secondsSincePush(agoSeconds(45), NOW)).toBe(45)
    expect(secondsSincePush(null, NOW)).toBeNull()
  })

  it('honours an explicit override so the window is testable end to end', () => {
    expect(isCardPaymentStillInFlight('terminal_pending', agoSeconds(5), NOW, 10)).toBe(true)
    expect(isCardPaymentStillInFlight('terminal_pending', agoSeconds(15), NOW, 10)).toBe(false)
  })
})

describe('normalizeSettlementPaymentMethod', () => {
  it('accepts the supported methods', () => {
    expect(normalizeSettlementPaymentMethod('cash')).toBe('cash')
    expect(normalizeSettlementPaymentMethod('card')).toBe('card')
  })

  it('canonicalises case and padding', () => {
    // Load-bearing: formatPaymentLabel matches case-insensitively but the staff dashboard and
    // the guest confirmation screen compare byte-exact against 'cash', so an unnormalised
    // 'Cash' would print CASH on the receipt while reading as card on both screens.
    expect(normalizeSettlementPaymentMethod('Cash')).toBe('cash')
    expect(normalizeSettlementPaymentMethod('  CARD  ')).toBe('card')
  })

  it('rejects rather than defaults for anything unrecognised', () => {
    for (const method of ['bitcoin', 'card_terminal', '', null, undefined, 42, {}]) {
      expect(normalizeSettlementPaymentMethod(method)).toBeNull()
    }
  })
})
