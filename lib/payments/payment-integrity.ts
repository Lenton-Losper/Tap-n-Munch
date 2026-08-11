/**
 * Shared helpers for terminal payment confirmation integrity.
 * Amounts are compared in major currency units (e.g. NAD) with cent tolerance.
 */

/**
 * Tolerance for a CLIENT-submitted payment amount, in WHOLE CENTS. The default.
 *
 * One cent rather than zero, deliberately. The terminal and the server can legitimately land a
 * cent apart, and refusing that is not the safe default it looks like: the card has ALREADY been
 * charged by the time the refusal is issued, so a spurious mismatch takes the customer's money
 * and loses the order at the same time. Two cents is a real disagreement and is still refused.
 *
 * This was the tolerance for EVERY comparison until #190. It is now the client-leg tolerance
 * only — see GATEWAY_AMOUNT_TOLERANCE_CENTS for why a gateway echo gets no tolerance at all.
 * The two client legs are payment/route.ts and tabs/[tabId]/settle/route.ts.
 */
export const PAYMENT_AMOUNT_TOLERANCE_CENTS = 1

/**
 * Round a money value to whole cents. Apply on WRITE.
 *
 * Summing order totals in JS produces values that are not the amount anyone means:
 * 35.10 + 27.25 + 42.95 is 105.30000000000001, and roughly a quarter of multi-order sums land
 * off the 2dp value like that. The money columns are `numeric` with no scale, so the artefact
 * is stored verbatim rather than rounded away by the column.
 *
 * This is NOT about the amount comparison, which is already correct — amountsMatch above
 * rounds both operands to integer cents, so a 1e-13 drift is absorbed and 105.30000000000001
 * matches 105.30 even at zero tolerance. It is about what the row then HOLDS. Two consequences
 * beyond tidiness:
 *
 *   - a stored 105.30000000000001 compared against a terminal-reported 105.30 makes an
 *     identical payment look like a disagreement to any consumer that does not round first,
 *     and not every consumer of these rows is this codebase;
 *   - the refund ceiling is checked as (prior + requested) > sale.amount, so a row sitting a
 *     fraction of a cent BELOW the true total can refuse a full refund of the amount actually
 *     charged.
 *
 * Non-finite input is returned unchanged rather than becoming NaN, so a caller that is already
 * holding a bad number gets the same bad number and not a second, different failure mode.
 */
export function roundToCents(amount: number): number {
  if (!Number.isFinite(amount)) return amount
  return Math.round(amount * 100) / 100
}

/**
 * Tolerance for a GATEWAY-echoed amount, in WHOLE CENTS. Zero — exact agreement or nothing.
 *
 * The default above is right for a CLIENT leg, where a terminal-submitted figure is validated
 * against the server's total and the two can legitimately land a cent apart. It is wrong for a
 * gateway leg, and #190 is the split.
 *
 * On a gateway leg Finatic is echoing back OUR OWN figure: push-to-terminal sends
 * Number(order.total) as order_amount, and the verification compares against Number(order.total)
 * again. There is no device arithmetic, no rounding step, and no second source of truth anywhere
 * in that round trip — so nothing can produce a legitimate one-cent difference. A cent of
 * daylight is not a rounding artefact; it means the reference correlated to a DIFFERENT SALE,
 * which is the one outcome that must never be written through (it would mark this order paid on
 * somebody else's money, and the row would look entirely ordinary afterwards).
 *
 * The three gateway legs:
 *   app/api/terminal/orders/[orderId]/verify-payment/route.ts
 *   lib/payments/handle-terminal-payment-failed.ts
 *   app/api/payments/reconcile/route.ts   (#197 — never called amountsMatch at all)
 *
 * ABSENT is not AGREEING. Every one of those sites must also refuse when the gateway response
 * carries no amount. A tolerance cannot express that, so it is enforced at each site with an
 * explicit null check: if the gateway did not give us an amount, we did not verify the amount,
 * and applying the payment while recording "never checked" is the same unguarded write #180
 * closed.
 *
 * Named rather than passed as a bare `0` so the split is greppable and a site cannot drift onto
 * the wrong tolerance silently.
 */
export const GATEWAY_AMOUNT_TOLERANCE_CENTS = 0

/**
 * True when two money values are the same payment, compared as INTEGER CENTS.
 *
 * This was `Math.abs(a - b) <= 0.01` in floating point, which is not a one-cent tolerance — it
 * is a one-cent tolerance for some amounts and a ZERO tolerance for others. Neither operand nor
 * the literal 0.01 is exactly representable, so a genuine one-cent gap frequently exceeds it:
 *
 *   78.36 - 78.35 === 0.010000000000005116   refused
 *   20.01 - 20.00 === 0.010000000000001563   refused
 *   35.00 - 34.99 === 0.00999999999999801    accepted
 *
 * Measured across every one-cent pair from NAD 10.00 to 500.00, 28.5% were refused — decided by
 * binary representation rather than by anything about the payment, which is why the same APK
 * build appeared to work at one price and fail at another (#180).
 *
 * Rounding to whole cents first removes the question entirely. Same convention as the ledger
 * amount comparison in 10cf29c: money is compared as integers in both places.
 *
 * `toleranceCents` is a COUNT OF CENTS, not a major-unit amount. It was renamed from `tolerance`
 * precisely so a leftover `0.01` cannot be passed silently — that would now mean "zero cents"
 * after rounding, a stricter comparison than any caller intends.
 */
export function amountsMatch(
  clientAmount: number,
  expectedAmount: number,
  toleranceCents = PAYMENT_AMOUNT_TOLERANCE_CENTS,
): boolean {
  if (!Number.isFinite(clientAmount) || !Number.isFinite(expectedAmount)) {
    return false
  }
  return (
    Math.abs(Math.round(clientAmount * 100) - Math.round(expectedAmount * 100)) <= toleranceCents
  )
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
