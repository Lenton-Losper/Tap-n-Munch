/**
 * THE PAYMENT STATE MACHINE — one enumeration, one transition table, one place to change it.
 *
 * ==================================================================================================
 * WHY THIS EXISTS
 * ==================================================================================================
 *
 * `orders.payment_status` had NO database CHECK constraint and no centralised rule about which
 * value may follow which. Nine values are writable from application code and they were asserted
 * ad hoc: each route decided for itself which statuses it would transition FROM, by passing its own
 * `fromPaymentStatuses` array or by inlining `.in('payment_status', [...])`. Three production rows
 * are in states no rule permits — see `PRODUCTION CONTRADICTIONS` below.
 *
 * That is the same class `lib/payments/expected-charge.ts` fixed for amounts: three copies of one
 * rule is the shape that drifts, and the copy nobody watches is the one that drifts first.
 *
 * ==================================================================================================
 * WHAT THIS DOES *NOT* DO
 * ==================================================================================================
 *
 * IT DOES NOT WIDEN ANY EXISTING TRANSITION. Every edge below was derived from a caller that
 * already performs it; nothing was added because it seemed reasonable. The existing sets
 * (`CLAIMABLE_PAYMENT_STATUSES`, `CASH_SETTLEABLE_PAYMENT_STATUSES`,
 * `claimableStatusesForRecovery`) remain the callers' own gates and stay authoritative for
 * *whether that caller may act*. This answers the narrower question the database also needs to
 * answer: *is the resulting pair of states a legal one at all*.
 *
 * IT DOES NOT AUTO-CORRECT ANYTHING. A contradictory row that already exists stays exactly as it
 * is; resolving those is an explicit, reviewed migration (see docs/payment-hardening-remediation.md),
 * never a sweep.
 */

/**
 * EVERY VALUE `orders.payment_status` MAY HOLD.
 *
 * Enumerated from the writers, not from production: production currently holds only `paid`,
 * `cancelled` and `pending`, and constraining to what happens to be present would make the next
 * legitimate `terminal_pending` write a 500. The brief's instruction — "do NOT blindly add a CHECK
 * constraint until all existing values have been enumerated" — cuts both ways: the constraint must
 * admit every value the code can legitimately write, and production's three are a subset of these.
 */
export const PAYMENT_STATUSES = [
  /** Historical member of the claimable set. Nothing in the codebase writes it; reads accept it. */
  'unpaid',
  /** Placed, nothing collected. The ordinary starting state. */
  'pending',
  /** A card attempt is in flight at a reader. */
  'terminal_pending',
  /** A card attempt was abandoned/cancelled; cash may now be taken. */
  'cash_pending',
  /** The gateway said no. Still owed. */
  'failed',
  /** #223. A real gateway payment exists whose amount we could not agree. Held for a human. */
  'amount_mismatch_hold',
  /** #153. No gateway answer is obtainable. Held for a human. Nothing collected. */
  'verification_unavailable_hold',
  /** Collected. Terminal. */
  'paid',
  /** Not collected and never will be. Terminal. */
  'cancelled',
] as const

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(normalizePaymentStatus(value))
}

/** Trim + lowercase, the normalisation every reader in payment-integrity.ts already applies. */
export function normalizePaymentStatus(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

/**
 * THE LEGAL TRANSITIONS.
 *
 * Read as: from KEY, the order may move to any status in the VALUE. A status is always allowed to
 * stay where it is (a re-write of the same value is a no-op, not a transition), so self-edges are
 * implicit and deliberately absent from the table.
 *
 * `paid` and `cancelled` are TERMINAL with exactly two exits each, and both are deliberate:
 *
 *   cancelled -> paid    the E04111 recovery. An order auto-cancelled on "the gateway has no
 *                        record" is un-cancelled when the gateway later proves it was charged.
 *                        `claimableStatusesForRecovery` already performs this edge; it is not new.
 *
 *   paid -> <nothing>    A PAID ORDER CANNOT BECOME UNPAID. Financial invariant 8. A reversal is a
 *                        refund — an append to the ledger, not a walk-back of this column — so
 *                        there is no edge out of `paid` at all, and `canTransition` refusing one is
 *                        the point rather than an omission.
 */
const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  unpaid: ['pending', 'terminal_pending', 'cash_pending', 'failed', 'paid', 'cancelled'],
  pending: [
    'terminal_pending',
    'cash_pending',
    'failed',
    'amount_mismatch_hold',
    'verification_unavailable_hold',
    'paid',
    'cancelled',
  ],
  terminal_pending: [
    'cash_pending',
    'failed',
    'amount_mismatch_hold',
    'verification_unavailable_hold',
    'paid',
    'cancelled',
    // A terminal attempt that is abandoned returns to the ordinary unpaid state.
    'pending',
  ],
  cash_pending: ['terminal_pending', 'failed', 'paid', 'cancelled', 'pending'],
  failed: ['terminal_pending', 'cash_pending', 'paid', 'cancelled', 'pending'],
  // A held order is resolved by a human: either the payment is proven and applied, or it is not
  // and the order goes back to being owed. It never settles itself.
  amount_mismatch_hold: ['paid', 'cancelled', 'pending', 'cash_pending'],
  verification_unavailable_hold: ['paid', 'cancelled', 'pending', 'cash_pending'],
  // TERMINAL. See the docblock above: a refund appends to the ledger, it does not walk this back.
  paid: [],
  // The E04111 recovery, and nothing else.
  cancelled: ['paid'],
}

export type TransitionVerdict =
  | { ok: true; reason: 'same_state' | 'legal' }
  | { ok: false; reason: 'unknown_from' | 'unknown_to' | 'illegal' }

/**
 * May `from` become `to`?
 *
 * FAILS CLOSED on a value it does not recognise. An unreadable current status is not permission to
 * overwrite it — the same direction every gate in this area already takes.
 */
export function canTransition(from: unknown, to: unknown): TransitionVerdict {
  const a = normalizePaymentStatus(from)
  const b = normalizePaymentStatus(to)
  if (!isPaymentStatus(a)) return { ok: false, reason: 'unknown_from' }
  if (!isPaymentStatus(b)) return { ok: false, reason: 'unknown_to' }
  if (a === b) return { ok: true, reason: 'same_state' }
  return TRANSITIONS[a as PaymentStatus].includes(b as PaymentStatus)
    ? { ok: true, reason: 'legal' }
    : { ok: false, reason: 'illegal' }
}

/**
 * Which of these statuses may legally become `to`.
 *
 * This is what a conditional claim UPDATE needs: `.in('payment_status', transitionsInto('paid'))`
 * expresses "claim it only if it is somewhere a claim is allowed from", in one place, rather than
 * each caller carrying its own list. Callers may still NARROW it — `settleableStatusesForMethod`
 * does, and should — but nothing may widen past this.
 */
export function transitionsInto(to: PaymentStatus): PaymentStatus[] {
  return PAYMENT_STATUSES.filter((from) => from !== to && TRANSITIONS[from].includes(to))
}

/**
 * ==================================================================================================
 * THE COMPANION INVARIANTS — the two `orders` columns that must agree with payment_status
 * ==================================================================================================
 *
 * PRODUCTION CONTRADICTIONS, measured 2026-09-19 (read-only):
 *
 *   3 rows   payment_status='paid' AND status='cancelled'   (#456, #500, #546, all FNB ChowNow,
 *                                                            all 2026-07-24)
 *   1 row    payment_status='paid' AND cancelled_at IS NOT NULL  (#377, cancellation_reason
 *                                                            'auto_timeout', paid 324ms later)
 *
 * All four predate `markOrderPaidConfirmed`'s clearing of `cancelled_at`/`cancellation_reason`,
 * which is why no new row has joined them. They are NOT corrected here — see the remediation plan.
 * `paidOrderContradictions` is what makes them findable rather than a thing somebody remembers.
 */
export type OrderConsistencyRow = {
  payment_status?: unknown
  status?: unknown
  cancelled_at?: unknown
}

export type OrderContradiction =
  | 'paid_but_status_not_completed'
  | 'paid_but_cancelled_at_set'
  | 'cancelled_but_status_not_cancelled'

/**
 * What is internally contradictory about this row. Empty means nothing is.
 *
 * A REPORT, NOT A GATE. It names the disagreements so reconciliation can surface them; it does not
 * refuse anything, because the rows that trip it are historical and refusing to read them would
 * hide them.
 */
export function orderContradictions(row: OrderConsistencyRow): OrderContradiction[] {
  const payment = normalizePaymentStatus(row?.payment_status)
  const status = normalizePaymentStatus(row?.status)
  const cancelledAt = row?.cancelled_at
  const out: OrderContradiction[] = []

  if (payment === 'paid') {
    if (status !== 'completed') out.push('paid_but_status_not_completed')
    if (cancelledAt != null && cancelledAt !== '') out.push('paid_but_cancelled_at_set')
  }
  if (payment === 'cancelled' && status !== 'cancelled') {
    out.push('cancelled_but_status_not_cancelled')
  }
  return out
}
