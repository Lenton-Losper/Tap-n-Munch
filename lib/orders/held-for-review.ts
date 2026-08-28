/**
 * #353 — the "Held for review" surface. What is not paid, not cancelled, and needs a person.
 *
 * WHY THE SCOPE IS "NEEDS A HUMAN" AND NOT "HAS A HOLD STATUS".
 *
 * Measured on production 2026-08-27:
 *
 *   orders carrying amount_mismatch_hold or verification_unavailable_hold ....  0
 *   orders stranded at plain `pending` past any reasonable timeout ..........  19  (N$484)
 *   oldest of those ........................................................  40.6 days
 *
 * A surface keyed on the hold statuses alone would render EMPTY today while nineteen orders
 * worth N$484 sit unresolved — an all-clear that is false, which is the same defect class as a
 * duplicate-charge report of zero read off a dead ledger. The hold statuses are ONE row type.
 * Stranded `pending` is another. Both render here; only the "why" line differs by cause.
 *
 * THE THING THAT MAKES THIS SURFACE NECESSARY RATHER THAN MERELY NICE. Measured the same day:
 * all 20 stale pending orders on production carry `is_closed = true`, and only ONE order in the
 * entire database has `is_closed = false`. Every dashboard read goes through
 * `.eq('is_closed', false)` (lib/supabase/orders.ts, components/orders-dashboard.tsx), so not one
 * of these orders is visible on any staff screen. That is not a new observation — the close route
 * says it in its own comment: "money still owed stays RECORDED and becomes INVISIBLE at the same
 * moment ... Surfacing an owed-money count to staff is follow-up work." This is that work, and it
 * is why `selectHeldForReviewOrders` must be fed by a query that does NOT filter on is_closed.
 * Feeding it the dashboard's existing in-memory `orders` array would reproduce the empty render
 * exactly.
 *
 * RLS permits it: `Staff can read orders for their restaurants` (authenticated, SELECT,
 * `restaurant_id IN (SELECT user_restaurant_ids())`) carries no is_closed condition. Verified
 * against production's pg_policy. No migration is required for this surface.
 *
 * THE CAUSE SET IS CONSUMED, NEVER COUNTED. `HELD_FOR_REVIEW_PAYMENT_STATUSES` has one member on
 * this branch and gains `verification_unavailable_hold` when #153 merges. Nothing here may assume
 * either number: the copy map is keyed by status and read through the array, so a member added
 * later starts rendering without a change to this file.
 *
 * AN UNMAPPED CAUSE READS AS "UNKNOWN, LOOK AT IT" — never as fine. This repo has already shipped
 * the opposite: my-orders labelled any status it did not recognise "🎉 New". A hold status that
 * reaches this surface without copy gets `unsignedCopy()`, which is impossible to mistake for an
 * all-clear.
 */
import {
  HELD_FOR_REVIEW_PAYMENT_STATUSES,
  isHeldForReviewPaymentStatus,
  isPaidPaymentStatus,
} from '@/lib/payments/payment-integrity'

/**
 * How long a `pending` order rests before it is treated as stranded rather than in flight.
 *
 * MEASURED, not chosen. Across 1,117 real paid orders placed since 2026-07-30 (the date after
 * which paid_at stopped being fabricated by Close Table), placed_at -> paid_at was:
 *
 *   pos    n=1113   p50 0.3 min   p95 0.8 min   p99 1.2 min   max 5.0 min
 *   table  n=4      p50 4.8 min   p95 5.7 min   p99 5.9 min   max 5.9 min
 *
 * ZERO of the 1,117 took longer than thirty minutes. Two hours is twenty times the longest
 * payment ever observed, so nothing that is merely slow can land here. At the time of writing
 * there are also zero pending orders younger than two hours, so the threshold classifies no live
 * order today.
 *
 * Deliberately NOT `STALE_POS_TIMEOUT_MS` (two minutes). That constant governs a sweep that
 * CANCELS, where being eager costs a retry; this one governs a screen that ACCUSES an order of
 * being abandoned, where being eager costs staff their trust in the screen.
 */
export const STRANDED_PENDING_THRESHOLD_MS = 2 * 60 * 60 * 1000

/** The cause key for an order sitting at plain `pending` past STRANDED_PENDING_THRESHOLD_MS. */
export const STRANDED_PENDING_CAUSE = 'stranded_pending'

/**
 * Held, and NO PAYMENT WAS EVER STARTED -- no gateway reference, no attempt timestamp.
 *
 * Split out of `stranded_pending` on 2026-08-28, because that one cause was carrying two orders
 * with opposite risk profiles and one signed sentence that is false for half of them:
 *
 *   - `stranded_pending` says "The card machine reported a problem". Five of Riviera's seven held
 *     orders never touched a card machine.
 *   - The override refused all five with "there is nothing to re-check against", which presented
 *     the SAFEST orders on the board as the only ones that could not be cleared.
 *
 * A Finatic charge requires a merchant order number. With no reference and no attempt, none was
 * created, so no charge was possible -- which is why this cause can be cancelled without asking
 * the gateway anything.
 */
export const NEVER_ATTEMPTED_CAUSE = 'stranded_never_attempted'

/**
 * THE GUARD. A merchant order number OR an attempt timestamp means a payment was started, and the
 * order is NOT this cause however old it is. Either one alone is enough: a reference with no
 * timestamp and a timestamp with no reference are both evidence that something reached a card
 * machine, and neither may take the path that skips the gateway.
 */
export function neverAttemptedPayment(order: HeldForReviewCandidate): boolean {
  const reference = String(order.paycloud_merchant_order_no ?? '').trim()
  const attempt = String(order.payment_attempt_started_at ?? '').trim()
  return reference === '' && attempt === ''
}

/**
 * Marker carried by every string on this surface that the owner has NOT signed off.
 *
 * It is rendered verbatim, on purpose. The alternative — inventing plausible staff-facing prose
 * and marking it only in a comment — is how unsigned wording ships. A reviewer, a test and a
 * `grep` all see the same thing.
 */
export const UNSIGNED_COPY_MARKER = 'COPY NOT SIGNED'

export type HeldForReviewCopy = {
  /** Short cause name, shown as the row's badge. */
  label: string
  /** The sentence that makes the decision possible. */
  why: string
}

/**
 * The section chrome. SIGNED OFF by the owner, verbatim — do not reword, re-wrap or re-punctuate.
 */
export const HELD_FOR_REVIEW_SECTION_COPY = {
  heading: 'Held for review',
  intro:
    'These orders are not paid and are not cancelled. Each one needs a person to decide what happened.',
} as const

/**
 * Per-cause copy, keyed by cause. The two hold entries are SIGNED OFF, verbatim.
 *
 * TWO SENTENCES ARE PINNED BY OWNER RULING and are asserted character-for-character by
 * __tests__/353-held-for-review-copy.test.ts:
 *
 *   'A card may still have been charged on the machine.'
 *   'Nothing has been taken from this order yet.'
 *
 * They are opposites, and each is the single fact that makes its decision possible. A staff
 * member reading the first must go and check the terminal roll before doing anything; a staff
 * member reading the second may act without checking anything. Softening either — or, worse,
 * letting one row inherit the other's sentence through a shared default — turns a decidable
 * situation back into a guess.
 *
 * `verification_unavailable_hold` is present here even though it does not exist in
 * HELD_FOR_REVIEW_PAYMENT_STATUSES on this branch. #153 adds it. Copy that is already signed is
 * cheaper to carry than to re-obtain, and `unsignedCauses()` checks the direction that actually
 * matters: every status in the array has copy. The reverse is deliberately allowed, which is what
 * makes this file merge-ready rather than merge-blocking.
 */
export const HELD_FOR_REVIEW_CAUSE_COPY: Readonly<Record<string, HeldForReviewCopy>> = {
  amount_mismatch_hold: {
    label: 'Amount does not match',
    why:
      'The payment that came back was for a different amount than this order. ' +
      'Nothing has been taken from this order yet.',
  },
  verification_unavailable_hold: {
    label: 'Cannot check this payment',
    why:
      'Card payments are not set up at this venue, so we cannot ask the payment provider what ' +
      'happened. A card may still have been charged on the machine.',
  },
  /**
   * SIGNED OFF 2026-08-27, verbatim, after six of these surfaced on a live venue's dashboard
   * rendering as `COPY NOT SIGNED (stranded_pending)` in front of staff.
   *
   * 'Nothing was taken.' is the load-bearing sentence and is pinned character-for-character. It is
   * the opposite of `verification_unavailable_hold`'s 'A card may still have been charged on the
   * machine.', and the two must never converge: one row tells staff to go and check the terminal
   * roll before acting, this one tells them they may act without checking anything. A reword that
   * softens this into "the payment may not have completed" hands back the guess the sentence
   * exists to remove.
   */
  [STRANDED_PENDING_CAUSE]: {
    label: 'Payment never confirmed',
    why:
      'The card machine reported a problem and the payment provider has no record of this order. ' +
      'Nothing was taken. Decide whether to take payment again or cancel it.',
  },
  /**
   * WRITTEN BY THE IMPLEMENTER 2026-08-28 AND NOT YET SIGNED BY THE OWNER.
   *
   * Drafted rather than left as PENDING COPY at the owner's explicit instruction, because the
   * board needed working buttons this morning and the wording can be corrected after. It is in
   * the signed map so it renders as prose rather than as a marker -- so it is NOT protected by
   * the character-for-character suite, and it is the one entry here a reviewer should read as
   * provisional.
   *
   * What it must keep saying, whatever the wording becomes: no payment was started, nothing was
   * taken, and no checking is needed before cancelling. That is the whole difference from
   * `stranded_pending`, whose sentence sends staff to the card machine.
   */
  [NEVER_ATTEMPTED_CAUSE]: {
    label: 'No payment was started',
    why:
      'This order was placed but no payment was ever started on it. The card machine was never ' +
      'used and the payment provider was never contacted, so nothing was taken. It can be ' +
      'cancelled without checking anything.',
  },
}

/**
 * Copy for a cause the owner has not signed off. Carries no claim about the order at all.
 *
 * NOT a friendly default. The failure this avoids is the one my-orders shipped: an unrecognised
 * value rendering as something reassuring. "COPY NOT SIGNED (stranded_pending)" is useless to a
 * staff member, which is correct — the row still appears, with its amount, its age and its table,
 * so the order is visible and unresolved rather than invisible and unresolved. What it must never
 * do is read as an explanation.
 */
export function unsignedCopy(cause: string): HeldForReviewCopy {
  const tag = `${UNSIGNED_COPY_MARKER} (${cause})`
  return { label: tag, why: tag }
}

/** True when this cause's staff-facing wording has been signed off by the owner. */
export function isSignedCopyCause(cause: string): boolean {
  return Object.prototype.hasOwnProperty.call(HELD_FOR_REVIEW_CAUSE_COPY, cause)
}

/**
 * Causes reaching the surface today whose wording is still unsigned. Read by the copy test, so
 * the list of what is outstanding is a fact in the code rather than a note in a report.
 */
export function unsignedCauses(): string[] {
  const causes = [...HELD_FOR_REVIEW_PAYMENT_STATUSES, STRANDED_PENDING_CAUSE]
  return causes.filter((cause) => !isSignedCopyCause(cause))
}

/**
 * The copy for a cause, or the unsigned marker. Never a reassuring fallback.
 */
export function heldForReviewCopy(cause: string): HeldForReviewCopy {
  return HELD_FOR_REVIEW_CAUSE_COPY[cause] ?? unsignedCopy(cause)
}

/** The order shape this surface reads. Everything is `unknown` — these rows come from the wire. */
export type HeldForReviewCandidate = {
  id: string | number
  payment_status?: unknown
  status?: unknown
  total?: unknown
  placed_at?: unknown
  table_number?: unknown
  channel?: unknown
  order_number?: unknown
  paycloud_merchant_order_no?: unknown
  /**
   * Needed to tell "a card was presented and we cannot tell what happened" from "no payment was
   * ever started". `getHeldForReviewOrders` uses `select('*')`, so it is fetched -- but a caller
   * that narrows that select and drops this column would silently route every order down the
   * light path. That is the reason this field is documented rather than merely added.
   */
  payment_attempt_started_at?: unknown
}

export type HeldForReviewRow = {
  id: string
  cause: string
  label: string
  why: string
  /** What is owed, in major units. */
  total: number
  /** How long it has been held, in milliseconds. Null when placed_at is missing or unparseable. */
  heldForMs: number | null
  /** The table, as a display string. Null when the order is not on a table (POS sales are 0). */
  table: string | null
  channel: string
  /** True when no gateway reference exists, so no payment provider can be asked about it. */
  hasGatewayReference: boolean
  /** True when this row's wording has been signed off. */
  copySigned: boolean
}

function normalise(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
}

function ageMs(placedAt: unknown, nowMs: number): number | null {
  if (placedAt === null || placedAt === undefined || placedAt === '') return null
  const placed =
    placedAt instanceof Date ? placedAt.getTime() : new Date(placedAt as string).getTime()
  if (!Number.isFinite(placed)) return null
  // A placed_at in the future (clock skew between app server and database) clamps to zero
  // rather than producing a negative age that would sort to the top of the list.
  return Math.max(0, nowMs - placed)
}

/**
 * The cause this order is held under, or null when it does not belong on the surface.
 *
 * ORDER OF THE GUARDS IS LOAD-BEARING. Paid and cancelled leave first, so no later branch can
 * pull a resolved order back in. `status === 'cancelled'` is checked as well as
 * `payment_status`: production carries a kiosk order at status 'cancelled' with payment_status
 * still 'pending' (no cancelled_at, no cancellation_reason), and the signed heading says these
 * orders "are not cancelled". Every render surface in the app reads that order as cancelled, so
 * this one does too.
 */
export function heldForReviewCause(
  order: HeldForReviewCandidate,
  nowMs: number = Date.now(),
  thresholdMs: number = STRANDED_PENDING_THRESHOLD_MS,
): string | null {
  const paymentStatus = normalise(order.payment_status)
  const status = normalise(order.status)

  if (isPaidPaymentStatus(paymentStatus)) return null
  if (paymentStatus === 'cancelled' || status === 'cancelled') return null

  // Held statuses need a person NOW, at any age -- a gateway has already answered about them.
  if (isHeldForReviewPaymentStatus(paymentStatus)) return paymentStatus

  if (paymentStatus === 'pending') {
    const age = ageMs(order.placed_at, nowMs)
    // See NEVER_ATTEMPTED_CAUSE. The split happens here so every surface -- panel, override,
    // reports -- reads one classification rather than each re-deriving it.
    // Unparseable placed_at is NOT an excuse to drop the order. A pending order whose age cannot
    // be established is exactly as unresolved as one whose age can, and dropping it here is the
    // invisible-absence shape this whole surface exists to remove. It renders with a null age.
    if (age === null || age >= thresholdMs) {
      return neverAttemptedPayment(order) ? NEVER_ATTEMPTED_CAUSE : STRANDED_PENDING_CAUSE
    }
  }

  return null
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * One rendered row, for an order already known to be held under `cause`.
 *
 * Split out from the selector so a caller can build a row for a cause this branch cannot yet
 * DETECT. `verification_unavailable_hold` is the live case: its copy is signed, but #153 has not
 * merged, so `HELD_FOR_REVIEW_PAYMENT_STATUSES` does not contain it and no fixture routed through
 * `selectHeldForReviewOrders` can produce that row. Without this seam the pinned sentence
 * 'A card may still have been charged on the machine.' could only be asserted against a constant,
 * never against anything a staff member would actually see.
 */
export function buildHeldForReviewRow(
  order: HeldForReviewCandidate,
  cause: string,
  nowMs: number = Date.now(),
): HeldForReviewRow {
  const copy = heldForReviewCopy(cause)
  const tableNumber = Number(order.table_number)
  return {
    id: String(order.id),
    cause,
    label: copy.label,
    why: copy.why,
    total: toNumber(order.total),
    heldForMs: ageMs(order.placed_at, nowMs),
    // POS sales carry table_number 0, which is not a table. Rendering "Table 0" invents a
    // place the order was never at.
    table: Number.isFinite(tableNumber) && tableNumber > 0 ? String(tableNumber) : null,
    channel: String(order.channel ?? '').trim(),
    hasGatewayReference: String(order.paycloud_merchant_order_no ?? '').trim() !== '',
    copySigned: isSignedCopyCause(cause),
  }
}

/**
 * Every order that needs a person, oldest first.
 *
 * Oldest first, deliberately: the thing a staff member most needs to see is the order that has
 * been ignored longest, and a newest-first list buries it under whatever happened this morning.
 */
export function selectHeldForReviewOrders(
  orders: readonly HeldForReviewCandidate[],
  nowMs: number = Date.now(),
  thresholdMs: number = STRANDED_PENDING_THRESHOLD_MS,
): HeldForReviewRow[] {
  const rows: HeldForReviewRow[] = []

  for (const order of orders ?? []) {
    const cause = heldForReviewCause(order, nowMs, thresholdMs)
    if (!cause) continue
    rows.push(buildHeldForReviewRow(order, cause, nowMs))
  }

  // Oldest first. A null age sorts to the top: an order whose placed_at cannot be read is the
  // least explicable row on the screen, not the least urgent.
  rows.sort((a, b) => (b.heldForMs ?? Number.POSITIVE_INFINITY) - (a.heldForMs ?? Number.POSITIVE_INFINITY))
  return rows
}

/** Total still owed across the surface, in major units. */
export function heldForReviewTotal(rows: readonly HeldForReviewRow[]): number {
  return rows.reduce((sum, row) => sum + row.total, 0)
}

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * "how long it has been held", as a coarse duration.
 *
 * Coarse on purpose. The decision this feeds is "is anyone coming back for this", and at 40 days
 * the difference between 40 and 41 changes nothing, while a precise-looking figure invites a
 * staff member to believe the screen knows more than it does.
 */
export function formatHeldDuration(heldForMs: number | null): string {
  if (heldForMs === null || !Number.isFinite(heldForMs)) return 'unknown'
  if (heldForMs >= DAY_MS) {
    const days = Math.floor(heldForMs / DAY_MS)
    return days === 1 ? '1 day' : `${days} days`
  }
  if (heldForMs >= HOUR_MS) {
    const hours = Math.floor(heldForMs / HOUR_MS)
    return hours === 1 ? '1 hour' : `${hours} hours`
  }
  const minutes = Math.floor(heldForMs / MINUTE_MS)
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}

/**
 * The digits only, so a caller can prefix the restaurant's own currency symbol. Split out because
 * the dashboard reads `restaurant.currency` and defaults to 'N$'; a hard-coded prefix here would
 * print the wrong symbol for any venue that ever sets another one.
 */
export function heldAmountDigits(amount: number): string {
  return (Number.isFinite(amount) ? amount : 0).toFixed(2)
}

/** Namibian dollar, matching how totals are shown elsewhere in the dashboard. */
export function formatHeldAmount(amount: number): string {
  return `N$${heldAmountDigits(amount)}`
}
