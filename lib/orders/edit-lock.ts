/**
 * Customer order-edit lock — the decision rules, with no database and no I/O.
 *
 * The lock itself is three columns on `orders` / `order_requests` (edit_lock_token,
 * edit_lock_session_id, edit_lock_expires_at, added by 20260813120000). This module owns
 * the questions "may this be edited", "who holds the lock", and "does this edit need staff
 * re-acceptance" so that the route, the dashboard and the tests all read the same answer
 * from the same code rather than three restatements of it.
 *
 * RULING (human, 2026-08-13), implemented here:
 *   - a customer may edit only BEFORE preparation starts; once preparing, editing is closed
 *     permanently for that order
 *   - the lock lives in the DATABASE; a browser guard is not a lock
 *   - on simultaneous fire STAFF WINS, never the reverse
 *   - the lock expires after 3 minutes so an abandoned cart cannot hold an order hostage
 *   - an edit that changes the TOTAL requires staff re-acceptance
 */

/** 3 minutes, per the ruling. */
export const EDIT_LOCK_TTL_MS = 3 * 60 * 1000

/**
 * Order statuses a customer may still edit in. `preparing` is deliberately absent and is
 * the point of the whole feature; `ready`, `completed`, `cancelled` follow it.
 *
 * `ready_for_terminal` is also absent, and not by omission: that status means the customer
 * has called staff over to take payment at the terminal, so the amount is already being
 * collected. Editing then would change what is being charged while it is being charged.
 *
 * Order of the array is the order sent to PostgREST's `in.()`; it carries no meaning.
 */
export const EDITABLE_ORDER_STATUSES = ['pending', 'accepted'] as const

/**
 * Payment states a customer may still edit in — an ALLOWLIST, not a denylist. #124 is the
 * reason: `if (paymentMethod && !allowed.includes(paymentMethod))` skipped the whole check
 * whenever the field was absent, so a card-only restaurant accepted cash. A denylist here
 * would have the same shape of hole for every payment state added later, and the failure
 * would be "customer edited an order that had already been paid for".
 */
export const EDITABLE_PAYMENT_STATUSES = ['pending', 'cash_pending'] as const

/**
 * order_request statuses a customer may still edit in. A QR submission lives in
 * order_requests until staff Accept, and that pre-Accept window is the one a customer is
 * most likely to want, so it is a first-class edit surface rather than an afterthought.
 *
 * `accepting` is absent for the reason the review route already gives for refusing STAFF
 * edits in that state: it is the transient claim Accept takes before it creates the order
 * and the Finatic checkout session, so an edit arriving then is repricing a payment that is
 * already being set up.
 */
export const EDITABLE_REQUEST_STATUSES = ['waiting_review'] as const

/** Why an edit is not possible. Distinguishes the cases the customer is told apart. */
export type EditRefusalReason =
  | 'preparation_started'
  | 'payment_settled'
  | 'payment_in_flight'
  | 'locked_by_other'
  | 'not_editable_status'
  | 'request_accepted'
  | 'request_declined'

export function isEditableOrderStatus(status: unknown): boolean {
  return (EDITABLE_ORDER_STATUSES as readonly string[]).includes(
    String(status ?? '').trim().toLowerCase(),
  )
}

export function isEditablePaymentStatus(paymentStatus: unknown): boolean {
  return (EDITABLE_PAYMENT_STATUSES as readonly string[]).includes(
    String(paymentStatus ?? '').trim().toLowerCase(),
  )
}

export function isEditableRequestStatus(status: unknown): boolean {
  return (EDITABLE_REQUEST_STATUSES as readonly string[]).includes(
    String(status ?? '').trim().toLowerCase(),
  )
}

/**
 * Statuses that mean the kitchen has it. Used only to pick which refusal the customer is
 * shown — never as the gate itself, which is the allowlist above. A status nobody has ever
 * heard of must refuse the edit, not fall through to "preparation started".
 */
const KITCHEN_HAS_IT = new Set(['preparing', 'ready', 'completed', 'served'])

export type EditLockRow = {
  status?: unknown
  payment_status?: unknown
  payment_checkout_url?: unknown
  edit_lock_token?: unknown
  edit_lock_session_id?: unknown
  edit_lock_expires_at?: unknown
}

export function isEditLockActive(row: EditLockRow, nowMs: number): boolean {
  if (!String(row.edit_lock_token ?? '').trim()) return false
  const expiresAt = row.edit_lock_expires_at
  if (!expiresAt) return false
  const expiryMs = new Date(String(expiresAt)).getTime()
  if (!Number.isFinite(expiryMs)) return false
  return expiryMs > nowMs
}

/**
 * True when someone ELSE holds a live lock. A customer re-acquiring their own lock is a
 * renewal, not a conflict — reloading the page mid-edit must not lock them out of their own
 * order for three minutes.
 */
export function isEditLockHeldByOther(
  row: EditLockRow,
  params: { sessionId: string; nowMs: number },
): boolean {
  if (!isEditLockActive(row, params.nowMs)) return false
  const holder = String(row.edit_lock_session_id ?? '').trim()
  const asker = String(params.sessionId ?? '').trim()
  // A live lock with no recorded holder belongs to nobody identifiable, so it is treated as
  // somebody else's. Failing open here would hand the lock to whoever asked next.
  if (!holder) return true
  return holder !== asker
}

/**
 * The single gate. Returns null when the edit may proceed, or the reason it may not.
 *
 * `payment_in_flight` is separate from `payment_settled` and is the subtler of the two: a
 * hosted-checkout order carries a payment_checkout_url pointing at a Finatic session that
 * was created for a specific amount (app/api/order-requests/[requestId]/accept/route.ts
 * builds it from the accepted total). Editing the items would move the total while that
 * session still quotes the old one, and the webhook is the only confirmation QR payments
 * have. So a live checkout session closes editing even though payment_status is still
 * 'pending'.
 */
export function editRefusalReason(
  row: EditLockRow,
  params: { sessionId: string; nowMs: number },
): EditRefusalReason | null {
  if (!isEditableOrderStatus(row.status)) {
    return KITCHEN_HAS_IT.has(String(row.status ?? '').trim().toLowerCase())
      ? 'preparation_started'
      : 'not_editable_status'
  }
  if (!isEditablePaymentStatus(row.payment_status)) {
    return 'payment_settled'
  }
  if (String(row.payment_checkout_url ?? '').trim()) {
    return 'payment_in_flight'
  }
  if (isEditLockHeldByOther(row, params)) {
    return 'locked_by_other'
  }
  return null
}

/**
 * The same gate for a pre-Accept order_request. Separate function, not a parameter on the one
 * above, because the two tables have genuinely different status vocabularies and different
 * things to say to the customer — an `accepted` request is not a refusal at all, it means the
 * client should be asking about the real order instead.
 *
 * No payment gate here: an order_request has no payment_status and no checkout session by
 * construction. Payment must never trigger before Accept, which is why the Finatic call lives
 * in the Accept route and not in POST /api/orders.
 */
export function requestEditRefusalReason(
  row: EditLockRow,
  params: { sessionId: string; nowMs: number },
): EditRefusalReason | null {
  const status = String(row.status ?? '').trim().toLowerCase()
  if (!isEditableRequestStatus(status)) {
    if (status === 'accepting') return 'payment_in_flight'
    if (status === 'accepted') return 'request_accepted'
    if (status === 'declined') return 'request_declined'
    return 'not_editable_status'
  }
  if (isEditLockHeldByOther(row, params)) {
    return 'locked_by_other'
  }
  return null
}

/**
 * Whether an edit sends the order back to staff for re-acceptance.
 *
 * THE ONE SWITCH. The ruling reads: "An edit changing the TOTAL requires staff
 * re-acceptance ... Removing items or changing notes only — no re-acceptance." Those two
 * sentences do not both hold, because removing an item changes the total. What is
 * implemented is the first: ANY movement in the total returns the order to review, and a
 * notes-only edit does not. If the intent was that removals are exempt because the total
 * can only fall, this function is the only place that changes — return
 * `nextTotal > previousTotal` instead, and nothing else in the feature moves.
 *
 * Compared in integer cents, not with a float tolerance. `Math.abs(a - b) <= 0.01` is a
 * one-cent tolerance for some amounts and a zero tolerance for others purely by binary
 * representation (#180), and "did the total change" must not depend on that.
 */
export function editRequiresReacceptance(previousTotal: number, nextTotal: number): boolean {
  return toCents(previousTotal) !== toCents(nextTotal)
}

export function toCents(amount: unknown): number {
  const n = Number(amount)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

export function editLockExpiryFrom(nowMs: number): string {
  return new Date(nowMs + EDIT_LOCK_TTL_MS).toISOString()
}

/**
 * One entry appended to `edit_history` per committed edit. Append-only: this is the audit
 * trail of what the customer originally ordered, which the amendment columns replace for
 * display purposes.
 */
export type EditHistoryEntry = {
  edited_at: string
  previous_total: number
  new_total: number
  previous_items: unknown
  /** Present only when the edit invalidated a saved staff review. */
  discarded_staff_review?: unknown
  notes_changed: boolean
  items_changed: boolean
}

export function appendEditHistory(
  existing: unknown,
  entry: EditHistoryEntry,
): EditHistoryEntry[] {
  const prior = Array.isArray(existing) ? (existing as EditHistoryEntry[]) : []
  // Bounded so a customer cycling the editor cannot grow one row without limit. The oldest
  // entries are the ones dropped; the ORIGINAL items also survive in order_requests.items,
  // which is never mutated.
  return [...prior, entry].slice(-20)
}

/**
 * PENDING COPY — every customer-facing and staff-facing string this feature introduces.
 * Placeholders written to be intelligible if they ship, not to be shipped. Listed in the
 * handoff so they can be replaced in one pass; nothing else in the feature holds copy.
 */
export const EDIT_COPY_PENDING = {
  /** Customer: the button that opens the editor. */
  editCta: 'PENDING COPY — Change this order',
  /** Customer: shown while the lock is held, with the remaining time. */
  lockHeld: 'PENDING COPY — You have {seconds}s to finish changing this order',
  /** Customer: refusal, status has moved to preparing or beyond. */
  preparationStarted:
    'PENDING COPY — The kitchen has already started this order, so it can no longer be changed.',
  /** Customer: refusal, another phone at the table is editing. */
  lockedByOther:
    'PENDING COPY — Someone else at your table is changing this order right now. Try again in a moment.',
  /** Customer: refusal, the order is paid or the payment is settled. */
  paymentSettled:
    'PENDING COPY — This order has already been paid for, so it can no longer be changed.',
  /** Customer: refusal, a card checkout session is open for the old amount. */
  paymentInFlight:
    'PENDING COPY — Payment is being set up for this order, so it can no longer be changed.',
  /** Customer: refusal, the lock expired before they committed. */
  lockExpired:
    'PENDING COPY — Your changes took too long and were not saved. Open the order again to change it.',
  /** Customer: the edit landed and the total moved. */
  committedTotalChanged:
    'PENDING COPY — Your changes were sent to the restaurant. They will confirm the new total of {total}.',
  /** Customer: the edit landed with no change to the total. */
  committedNoTotalChange: 'PENDING COPY — Your changes were sent to the restaurant.',
  /** Customer: an edit that would empty the order. */
  cannotEmpty:
    'PENDING COPY — An order needs at least one item. Ask staff to cancel it instead.',
  /** Customer: the request was accepted while they were editing; it is a real order now. */
  requestAccepted:
    'PENDING COPY — The restaurant just accepted this order. Reopen it to make changes.',
  /** Customer: the request was declined. */
  requestDeclined: 'PENDING COPY — This order was declined by the restaurant.',
  /** Customer: the edit is closed for a status nobody expected. Deliberately vague. */
  notEditable: 'PENDING COPY — This order can no longer be changed.',
  /** Staff dashboard: a customer has the lock open right now. */
  staffEditInProgress: 'PENDING COPY — Customer is changing this order',
  /** Staff dashboard: the order was edited by the customer. */
  staffWasEdited: 'PENDING COPY — Customer changed this order',
  /** Staff dashboard: the total moved and the order is back for re-acceptance. */
  staffNeedsReacceptance: 'PENDING COPY — Re-accept: the total changed',
  /** Staff dashboard: a saved review was invalidated by a later customer edit. */
  staffReviewInvalidated: 'PENDING COPY — Your review was replaced by a customer change',
} as const
