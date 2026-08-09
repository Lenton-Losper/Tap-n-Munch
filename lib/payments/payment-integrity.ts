/**
 * Shared helpers for terminal payment confirmation integrity.
 * Amounts are compared in major currency units (e.g. NAD) with cent tolerance.
 */

/** Max absolute difference allowed between client amount and server total (NAD cents ≈ 0.01). */
export const PAYMENT_AMOUNT_TOLERANCE = 0.01

/**
 * Round a money value to whole cents.
 *
 * Summing order totals in JS produces values that are not the amount anyone means:
 * 12.50 + 19.99 is 32.489999999999995, and roughly a quarter of two-order sums land off the
 * 2dp value like that. payment_events.amount is `numeric` with no scale, so the artefact is
 * stored verbatim rather than rounded away by the column.
 *
 * That matters in two places beyond tidiness. Comparing a stored 32.489999999999995 against a
 * terminal-reported 32.49 makes an identical payment look like a disagreement, and the refund
 * ceiling is checked as (prior + requested) > sale.amount, so a sale row a fraction of a cent
 * BELOW the true total can refuse a full refund of the amount actually charged.
 *
 * Applied on write, so ledger rows hold the monetary value and not a binary artefact of how it
 * was summed.
 */
export function roundToCents(amount: number): number {
  if (!Number.isFinite(amount)) return amount
  return Math.round(amount * 100) / 100
}

/** Whole-cent integer form of a money value. Exact, so comparisons cannot drift. */
export function toCents(amount: number): number {
  return Math.round(amount * 100)
}

/**
 * True when two money values are within `toleranceCents` of each other, compared as INTEGERS.
 *
 * Use this, not amountsMatch, when the question is "are these the same payment". amountsMatch
 * does `Math.abs(a - b) <= 0.01` in floating point, and a one-cent difference is frequently
 * NOT representable as exactly 0.01: 32.49 - 32.48 is 0.010000000000005116 and 20 - 19.99 is
 * 0.010000000000001563, both of which exceed the tolerance, while 35 - 34.99 is
 * 0.00999999999999801 and passes. Measured across every one-cent pair from 1.00 to 50.00,
 * 36.4% are rejected. Which side a given pair lands on is an artefact of binary representation,
 * so a float tolerance gives a comparison that works for some amounts and not others.
 *
 * Converting to integer cents first removes the question entirely.
 */
export function amountsMatchInCents(
  a: number,
  b: number,
  toleranceCents = 1,
): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(toCents(a) - toCents(b)) <= toleranceCents
}

export function amountsMatch(
  clientAmount: number,
  expectedAmount: number,
  tolerance = PAYMENT_AMOUNT_TOLERANCE,
): boolean {
  if (!Number.isFinite(clientAmount) || !Number.isFinite(expectedAmount)) {
    return false
  }
  return Math.abs(clientAmount - expectedAmount) <= tolerance
}

/** Payment statuses that may still be claimed as paid by a CARD settlement. */
export const CLAIMABLE_PAYMENT_STATUSES = ['unpaid', 'pending'] as const

export type ClaimablePaymentStatus = (typeof CLAIMABLE_PAYMENT_STATUSES)[number]

export function isClaimablePaymentStatus(status: unknown): boolean {
  return matchesStatusSet(status, CLAIMABLE_PAYMENT_STATUSES)
}

/**
 * The card payment is in flight: pushed to the terminal, awaiting the gateway's answer.
 * Cash must not be taken against such an order or the two payment paths race and the
 * order can be collected on twice. Staff resolve it first -- POST /api/payments/cancel-terminal
 * closes the card attempt and moves the order to 'cash_pending', which IS cash-settleable.
 */
export const MID_FLIGHT_CARD_PAYMENT_STATUSES = ['terminal_pending'] as const

export function isMidFlightCardPayment(status: unknown): boolean {
  return matchesStatusSet(status, MID_FLIGHT_CARD_PAYMENT_STATUSES)
}

/**
 * How long a pushed card attempt is treated as still live.
 *
 * Above a real transaction, below the point where staff are stuck. A card round trip is
 * seconds; even a slow one -- customer finding the card, PIN entry, a retry on the reader --
 * is well under a minute, so 90s does not race a genuine payment. Past it the attempt is
 * assumed dead: the terminal crashed, the reader was walked away from, the push never
 * surfaced. Cash then becomes available again for that order without staff intervention.
 *
 * NOT measured from production data: card round-trip durations are not recoverable from the
 * database (completed_at and paid_at are written in the same statement, so their difference is
 * identically zero, and nothing recorded the push time -- which is what terminal_pushed_at now
 * fixes). Settlements that happen after this window record card_in_flight_seconds in the audit
 * metadata, so the first weeks of real use give the evidence to retune this.
 */
export const CARD_IN_FLIGHT_TIMEOUT_SECONDS = 90

/**
 * True while a card payment should still be considered live, and therefore while cash must be
 * refused for that order.
 *
 * A null/absent/unparseable push time counts as EXPIRED, not in-flight. Such a row was pushed
 * before this column existed, so it is by definition older than the timeout; treating it as
 * live would block cash on it permanently -- the exact failure this timeout exists to prevent.
 */
export function isCardPaymentStillInFlight(
  status: unknown,
  terminalPushedAt: unknown,
  now: Date = new Date(),
  timeoutSeconds: number = CARD_IN_FLIGHT_TIMEOUT_SECONDS,
): boolean {
  if (!isMidFlightCardPayment(status)) return false

  const elapsed = secondsSincePush(terminalPushedAt, now)
  if (elapsed === null) return false

  return elapsed < timeoutSeconds
}

/** Seconds since the card attempt was pushed, or null when there is no usable push time. */
export function secondsSincePush(
  terminalPushedAt: unknown,
  now: Date = new Date(),
): number | null {
  if (terminalPushedAt === null || terminalPushedAt === undefined || terminalPushedAt === '') {
    return null
  }
  const pushedAt = new Date(terminalPushedAt as string)
  const pushedMs = pushedAt.getTime()
  if (!Number.isFinite(pushedMs)) return null

  // A push time in the future (clock skew between the app server and the database) is clamped
  // to zero rather than allowed to extend the window arbitrarily.
  return Math.max(0, (now.getTime() - pushedMs) / 1000)
}

/**
 * Statuses where the restaurant is still owed money.
 *
 * Deliberately wider than CLAIMABLE_PAYMENT_STATUSES: a 'cash_pending', 'failed' or
 * 'terminal_pending' order has NOT been collected on. Treating those as settled is how an
 * unpaid order drops out of a tab's unpaid total and lets can_close report true, so this is
 * the set every "how much is still owed / may we close" question must use.
 *
 * 'unpaid' is retained only because it is the historical member of the claimable set; nothing
 * in the codebase writes it. Terminal states ('paid', 'cancelled') are absent by design.
 */
export const OWES_MONEY_PAYMENT_STATUSES = [
  'unpaid',
  'pending',
  'cash_pending',
  'failed',
  'terminal_pending',
] as const

export function owesMoney(status: unknown): boolean {
  return matchesStatusSet(status, OWES_MONEY_PAYMENT_STATUSES)
}

/**
 * Statuses a CASH settlement may claim: everything that still owes money except a card
 * payment that is currently in flight. Cash is deliberately permissive -- an order that has
 * been pushed to the terminal before, or whose card attempt failed, can still be paid in
 * cash; only the live attempt blocks it.
 */
export const CASH_SETTLEABLE_PAYMENT_STATUSES = OWES_MONEY_PAYMENT_STATUSES.filter(
  (status) => !isMidFlightCardPayment(status),
)

export function isCashSettleablePaymentStatus(status: unknown): boolean {
  return matchesStatusSet(status, CASH_SETTLEABLE_PAYMENT_STATUSES)
}

/** Payment methods a terminal settlement may record. */
export const SETTLEMENT_PAYMENT_METHODS = ['card', 'cash'] as const

export type SettlementPaymentMethod = (typeof SETTLEMENT_PAYMENT_METHODS)[number]

/**
 * Normalise a client-supplied payment method to its canonical lowercase form.
 *
 * Returns null for anything not in the allowlist -- callers must reject rather than fall back
 * to a default, or an unrecognised method silently books as a card sale. The normalisation is
 * load-bearing beyond tidiness: formatPaymentLabel() compares case-insensitively while the
 * staff dashboard and the guest confirmation screen compare byte-exact against 'cash', so a
 * stored 'Cash' would print CASH on the receipt yet read as card on both screens.
 */
export function normalizeSettlementPaymentMethod(
  method: unknown,
): SettlementPaymentMethod | null {
  const normalized = String(method ?? '')
    .trim()
    .toLowerCase()
  return (SETTLEMENT_PAYMENT_METHODS as readonly string[]).includes(normalized)
    ? (normalized as SettlementPaymentMethod)
    : null
}

/**
 * Statuses a settlement of the given method may claim. Card behaviour is unchanged; only
 * cash uses the wider set.
 */
export function settleableStatusesForMethod(
  method: SettlementPaymentMethod,
): readonly string[] {
  return method === 'cash'
    ? CASH_SETTLEABLE_PAYMENT_STATUSES
    : CLAIMABLE_PAYMENT_STATUSES
}

/** Trim + lowercase before comparing, so a stray 'Paid' or ' paid' cannot slip through. */
function matchesStatusSet(status: unknown, set: readonly string[]): boolean {
  const s = String(status ?? '')
    .trim()
    .toLowerCase()
  return set.includes(s)
}

/**
 * True only when an order has genuinely been paid.
 *
 * This is the counterpart to isClaimablePaymentStatus, which answers "may this still
 * be claimed" -- the wrong question when deciding whether money has actually been
 * collected. Normalised identically (trim + lowercase) so that a stray 'Paid' or
 * ' paid' can never be misclassified: a byte-exact SQL comparison such as
 * .eq('payment_status','paid') would get this wrong, so callers should read rows and
 * partition with this helper rather than filtering in the database.
 */
export function isPaidPaymentStatus(status: unknown): boolean {
  return String(status ?? '')
    .trim()
    .toLowerCase() === 'paid'
}
