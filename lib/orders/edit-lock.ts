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
 * Was the lock the caller is presenting SPENT BY A COMMIT, rather than lost to an expiry? (#306)
 *
 * The two were indistinguishable to the customer and to the server: both arrived as `lock_lost`
 * and both were answered *"That took too long, so nothing was saved"* — a lie in the first case.
 * A customer who believed it re-applied the change and was charged twice, with a fresh staff
 * review each time, because an addition raises the total.
 *
 * THE DISCRIMINATOR IS THE TOKEN ITSELF, not a timestamp alone. A commit NULLS
 * `edit_lock_token`; an expiry leaves the token on the row and simply lets
 * `edit_lock_expires_at` pass. A token still present therefore means nobody consumed it, and
 * that check comes first.
 *
 * The recency bound is `EDIT_LOCK_TTL_MS`, and it is not arbitrary: the token being presented was
 * issued at most one TTL ago, or it would have expired on its own. A customer edit older than
 * that cannot be the one that consumed THIS token, so claiming it would be a second false
 * statement in the opposite direction — telling someone their unsaved work landed.
 *
 * Deliberately conservative: every uncertain case returns false and the customer is told the lock
 * expired, which is the existing behaviour. This narrows a lie; it does not invent a promise.
 */
export function editAlreadyCommitted(
  row: {
    edit_lock_token?: unknown
    customer_edit_count?: unknown
    customer_edited_at?: unknown
  },
  presentedToken: string,
  nowMs: number,
): boolean {
  if (!String(presentedToken ?? '').trim()) return false
  // A token still on the row was not consumed — an expiry or another holder, not a commit.
  if (String(row?.edit_lock_token ?? '').trim()) return false
  if ((Number(row?.customer_edit_count) || 0) < 1) return false

  const editedAtMs = Date.parse(String(row?.customer_edited_at ?? ''))
  if (!Number.isFinite(editedAtMs)) return false

  const age = nowMs - editedAtMs
  return age >= 0 && age <= EDIT_LOCK_TTL_MS
}

/**
 * True when someone ELSE holds a live lock. A customer re-acquiring their own lock is a
 * renewal, not a conflict — reloading the page mid-edit must not lock them out of their own
 * order for three minutes.
 */
export function isEditLockHeldByOther(row: EditLockRow, params: EditLockAsker): boolean {
  if (!isEditLockActive(row, params.nowMs)) return false
  const holder = String(row.edit_lock_session_id ?? '').trim()
  // A live lock with no recorded holder belongs to nobody identifiable, so it is treated as
  // somebody else's. Failing open here would hand the lock to whoever asked next.
  if (!holder) return true
  return !normalizeSessionIds(params.sessionIds).includes(holder)
}

/**
 * WHO IS ASKING — and it is a LIST, not one id.
 *
 * The customer app mints TWO session ids, in different storages and different formats, and
 * nothing syncs them:
 *
 *   lib/session.ts        flashtap_session_v1  localStorage    `sess_<uuid>`
 *   lib/tab-storage.ts    tab_session_id       (mirrored)      `session_<ts>_<rand>`
 *
 * An order carries whichever the placing screen held — the cart submits the TAB one as both
 * `session_id` and `member_session_id` — so a single-id check silently rejects the customer's own
 * order. Measured against the deployed worker 2026-08-13: POST .../edit with a `sess_`-style id
 * on a request whose `session_id` was `session_1786615850151_8kbbfwp6jne` returned
 * `404 Order not found`. The edit button was dead for every tab-flow QR order.
 *
 * This is the same shape as lib/guest-orders/queries.ts's `sessionIds` parameter, and the same
 * root cause as the My Orders empty-state bug. Third time: any code asking "is this the
 * customer's own order" must take every id the client holds.
 */
export type EditLockAsker = {
  sessionIds: Array<string | null | undefined>
  nowMs: number
}

export function normalizeSessionIds(ids: Array<string | null | undefined>): string[] {
  return [...new Set((ids ?? []).map((id) => String(id ?? '').trim()).filter(Boolean))]
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
  params: EditLockAsker,
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
  params: EditLockAsker,
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
 * Whether an edit sends the order back to staff for RE-ACCEPTANCE.
 *
 * ============================================================================================
 * RULED 2026-08-16 — THIS REVERSES THE 2026-08-13 RULING. Both are the same human's, and the
 * reversal is quoted in full below so nobody has to reconstruct it from a diff.
 * ============================================================================================
 *
 * 2026-08-16, the overnight redesign brief, verbatim:
 *
 *   > "An edit that raises the total still requires staff re-acceptance — that ruling stands.
 *   >  An edit that only removes items, lowers quantities or changes notes does not."
 *
 * 2026-08-13, what this function used to say, verbatim, and which the line above supersedes:
 *
 *   > "ANY movement in the total returns the order to review. Only a notes-only edit is exempt.
 *   >  Removals are NOT exempt. … a removal changes what the kitchen makes and what the customer
 *   >  pays, so staff see it before cooking. … the tempting change here — `return nextTotal >
 *   >  previousTotal` — is the one thing this function must not do. It was considered and
 *   >  rejected. Escalate rather than implement it."
 *
 * WHY THE OLD COMMENT WAS OBEYED AND THEN OVERRULED, AND WHY THAT IS NOT A CONTRADICTION. The
 * operating contract's "a recorded decision is a ruling that has already been made" exists to
 * stop an AGENT overruling an absent human. Here the human overruled themselves, in writing, in
 * the instruction being executed, naming the exact three exempt cases. That is the person who
 * made the decision changing it, which is the one thing that was always allowed to.
 *
 * WHAT THE OLD RULING WAS PROTECTING, AND HOW IT SURVIVES ANYWAY. Its concern was that staff
 * would cook the old item list. Re-acceptance was the mechanism, not the goal. A reduction still
 * writes `customer_edited_at`, bumps `customer_edit_count`, appends to `edit_history` and now
 * sets `total_before_edit` on ANY movement including a fall — so the dashboard card can show
 * that the order changed and by how much. What no longer happens is the order being pushed back
 * to `pending` and requiring a second Accept before the kitchen may start.
 *
 * Compared in integer cents, not with a float tolerance. `Math.abs(a - b) <= 0.01` is a one-cent
 * tolerance for some amounts and a zero tolerance for others purely by binary representation
 * (#180), and "did the total rise" must not depend on that.
 */
export function editRequiresReacceptance(previousTotal: number, nextTotal: number): boolean {
  return toCents(nextTotal) > toCents(previousTotal)
}

/**
 * Whether the total moved AT ALL, in either direction.
 *
 * Split out from `editRequiresReacceptance` when the two stopped being the same question
 * (2026-08-16). A fall no longer gates on staff, but it is still a change to what the customer
 * pays, so it must still be RECORDED — `total_before_edit` is written from this, not from the
 * re-acceptance decision, or a reduction would leave staff no way to see the order moved.
 */
export function editChangedTheTotal(previousTotal: number, nextTotal: number): boolean {
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
  /**
   * WHICH clause sent this edit back to staff, or `none`. Added 2026-08-18 with the widened
   * predicate: once an equal-price swap can require re-acceptance, `new_total > previous_total` no
   * longer explains why an order returned to `pending`, and a reader would otherwise have to
   * re-derive it from two line lists. Optional because entries written before that date have none.
   */
  reacceptance_reason?: 'total_rose' | 'introduced_content' | 'none'
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
 * Every customer-facing and staff-facing string this feature introduces. Signed off by the human
 * 2026-08-15, so no PENDING COPY marker and no "PENDING" in the name: nothing here is a
 * placeholder any more. Nothing else in the feature holds copy.
 *
 * `{seconds}` and `{total}` are substituted at the render site by plain `.replace()`
 * (components/order-edit-panel.tsx), so they must stay literal in the strings below.
 *
 * A KEY WITH NO CALL SITE WAS DELETED RATHER THAN GIVEN COPY. `staffReviewInvalidated`
 * ("Your review was replaced by a customer change") was defined here and rendered by nothing —
 * `git grep` found only this file. It is gone: a string that cannot render is a lie waiting to
 * happen, because the next reader takes its presence as evidence the case is handled. If a saved
 * staff review really can be invalidated by a later customer edit, add the key back together
 * with the call site that shows it. `discarded_staff_review` on EditHistoryEntry above is the
 * signal that case exists in the data; it has no UI.
 */
export const EDIT_COPY = {
  /** Customer: the button that opens the editor. */
  editCta: 'Change this order',
  /**
   * SUPERSEDED 2026-08-16, no longer rendered anywhere. Kept exported so the string is findable
   * rather than silently gone, and so the reason survives with it.
   *
   * Redesign spec section 21: this was the ONLY time figure on the editor, and it read as the
   * deadline for changing the order. It is not. There are two different concepts and this is the
   * lesser one:
   *
   *   the DEADLINE  event-driven — you may change the order until the restaurant starts
   *                 preparing it. Could be seconds, could be twenty minutes. Nothing counts it
   *                 down because nothing knows when it will happen.
   *   the HOLD      timed — three minutes, so two phones at one table do not edit the same order
   *                 at once. It is an implementation detail of concurrency, not a promise about
   *                 the customer's food.
   *
   * A customer reading "164s left to make changes" believes the first and is being shown the
   * second. Replaced by `editDeadline` (primary) and `holdSecondary` (secondary).
   */
  lockHeld: '{seconds}s left to make changes',
  /**
   * SIGNED OFF 2026-08-17. Customer: the PRIMARY line in the editor — the rule that actually governs
   * whether the order can still be changed.
   */
  editDeadline: 'You can change this order until the restaurant starts preparing it.',
  /**
   * SIGNED OFF 2026-08-17. Customer: SECONDARY, beneath the line above. The hold, stated as a hold.
   * `{seconds}` is substituted at the render site by plain `.replace()`, so it must stay literal.
   */
  holdSecondary: 'Editing held for you · {seconds}s, so no one else can change it at the same time.',
  /** SIGNED OFF 2026-08-17. Customer: the control that opens the menu to add something to this edit. */
  addSomething: 'Add from menu',
  /** SIGNED OFF 2026-08-17. Customer: one more of a line already on the order. */
  addOneMore: 'Add one more',
  /** Customer: refusal, status has moved to preparing or beyond. */
  preparationStarted: "The kitchen has started this order, so it can't be changed now.",
  /** Customer: refusal, another phone at the table is editing. */
  lockedByOther:
    'Someone else at your table is changing this order. Try again in a moment.',
  /** Customer: refusal, the order is paid or the payment is settled. */
  paymentSettled: "This order has been paid for, so it can't be changed.",
  /** Customer: refusal, a card checkout session is open for the old amount. */
  paymentInFlight: "Payment is being set up for this order, so it can't be changed.",
  /** Customer: refusal, the lock expired before they committed. */
  lockExpired:
    'That took too long, so nothing was saved. Open the order again to change it.',
  /**
   * SIGNED OFF 2026-08-17. Customer: their change DID land and they are retrying after a lost response —
   * a dropped request on mobile data is the ordinary way to reach this. It must not reuse
   * `lockExpired`: telling someone nothing was saved when it was is what made them re-apply the
   * change and pay for it twice (#306). Shown with the current order beside it.
   */
  alreadySaved:
    'Your changes were already saved. This is your current order.',
  /** Customer: the edit landed and the total moved. */
  committedTotalChanged:
    "Sent to the restaurant. They'll confirm the new total of {total}.",
  /** Customer: the edit landed with no change to the total. */
  committedNoTotalChange: 'Sent to the restaurant.',
  /** Customer: an edit that would empty the order. */
  cannotEmpty: 'An order needs at least one item. Ask staff to cancel it instead.',
  /** Customer: the request was accepted while they were editing; it is a real order now. */
  requestAccepted: 'The restaurant just accepted this order. Open it again to make changes.',
  /** Customer: the request was declined. */
  requestDeclined: 'The restaurant declined this order.',
  /** Customer: the edit is closed for a status nobody expected. Deliberately vague. */
  notEditable: "This order can't be changed.",
  /** Staff dashboard: a customer has the lock open right now. */
  staffEditInProgress: 'Customer editing now',
  /** Staff dashboard: the order was edited by the customer. */
  staffWasEdited: 'Customer edited',
  /** Staff dashboard: the total moved and the order is back for re-acceptance. */
  staffNeedsReacceptance: 'Total changed — re-accept',
} as const
