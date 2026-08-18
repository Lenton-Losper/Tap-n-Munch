/**
 * ONE customer-facing status vocabulary, for every QR customer screen.
 *
 * Redesign spec section 19 asked for FOUR words: Waiting for restaurant · Being prepared ·
 * Ready · Paid — and asked, before implementing, that every backend state be enumerated and
 * checked against them.
 *
 * IT WAS ENUMERATED, AND FOUR IS NOT ENOUGH. Building four would have meant either hiding three
 * states from the customer or merging one wrongly, so this ships SIX and the deviation is
 * recorded rather than papered over. Per state:
 *
 *   waiting_review     Waiting for the restaurant   ✅
 *   accepting          Waiting for the restaurant   ✅ (normalizeOrderStatusForDisplay maps it)
 *   pending            Waiting for the restaurant   ✅ — and this is where a RE-ACCEPTANCE lands
 *   accepted           Accepted                     ⚠️ NOT "being prepared". `accepted` means
 *                                                      staff took the order; the kitchen may not
 *                                                      have started. Merging them tells a
 *                                                      customer their food is being cooked when
 *                                                      it is sitting in a queue, and it is also
 *                                                      the boundary EDITING closes at, so the
 *                                                      two states differ in what the customer
 *                                                      can still DO.
 *   confirmed          Accepted                     ✅ (the terminal's word for `accepted`)
 *   preparing          Being prepared               ✅
 *   ready              Ready                        ✅
 *   ready_for_terminal Needs you                    ❌ in a four-word model. The customer ASKED
 *                                                      for the terminal; something is expected of
 *                                                      them.
 *   completed + paid   Paid                         ✅
 *   cancelled          Needs you                    ❌ omitted entirely by four words
 *   declined           Needs you                    ❌ same — and #219 exists precisely so a
 *                                                      declined request stays visible
 *   payment failed     Needs you                    ❌ the customer must retry with staff
 *
 * THE FALLBACK IS THE OTHER HALF OF THIS MODULE, and it is why the old maps were dangerous.
 * `my-orders/page.tsx` did `return configs[status] || configs.pending`, where `configs.pending`
 * is `{🎉, 'New'}` — so ANY unmapped status rendered as "🎉 New". A `ready_for_terminal` order,
 * or any status added later, read as a brand new order. Spec section 34 says remove the NEW
 * badge; removing it without replacing the fallback would only move the lie. Here an unknown
 * status returns `unknown`, whose copy says the restaurant is handling it and promises nothing.
 *
 * Everything goes through `normalizeOrderStatusForDisplay` first — imported, never restated. The
 * terminal writes `confirmed` where the dashboard writes `accepted`, and a render site that
 * misses that draws an order as LESS far along than it is.
 */
import { normalizeOrderStatusForDisplay } from '@/lib/orders/active-order-visibility'

/**
 * THE TEN WORDS a QR customer may be shown, the last being the honest catch-all.
 *
 * `needs_you` ("See staff") WAS REMOVED 2026-08-18 and split into four. It collapsed a refusal,
 * a called-off order, an order sitting at the terminal and a failed card into one sentence, so
 * the badge told the customer to go and ask what had actually happened — which is the app
 * declining to answer a question it knows the answer to.
 *
 * NOT MERGED, deliberately: `declined` and `cancelled` are DIFFERENT CONVERSATIONS with staff.
 * A refusal is the restaurant saying no; a cancellation is the order being called off. Collapsing
 * them would be the same mistake one level down.
 */
export const CUSTOMER_ORDER_STATES = [
  'waiting',
  'accepted',
  'preparing',
  'ready',
  'paid',
  'declined',
  'cancelled',
  'awaiting_payment',
  'payment_failed',
  'unknown',
] as const

export type CustomerOrderState = (typeof CUSTOMER_ORDER_STATES)[number]

/**
 * All ten signed off. Wording is the human's; this module owns the KEYS and the mapping.
 *
 * WHY "Waiting for payment" AND NOT "Ready to pay". `stripHeadlineReadyToPay` on the tab strip
 * already reads "Ready for payment", and two near-identical phrases meaning different things on
 * one customer's screen is worse than either phrasing alone. They are different facts:
 *
 *   the STRIP    the TABLE asking to settle — a thing the customer initiated
 *   this BADGE   one ORDER waiting at the terminal — a thing the customer is waiting on
 */
export const CUSTOMER_STATUS_COPY: Record<CustomerOrderState, string> = {
  waiting: 'Waiting for restaurant',
  accepted: 'Accepted',
  preparing: 'Being prepared',
  ready: 'Ready',
  paid: 'Paid',
  declined: 'Not accepted',
  cancelled: 'Cancelled',
  awaiting_payment: 'Waiting for payment',
  payment_failed: 'Payment failed',
  unknown: 'Order update',
}

const WAITING = new Set(['waiting_review', 'pending'])
const ACCEPTED = new Set(['accepted'])
const PREPARING = new Set(['preparing'])
const READY = new Set(['ready'])
/**
 * The four sets that replaced NEEDS_YOU. Each is exactly one raw status today; they are Sets so
 * a synonym can be added to ONE of them without widening the others, which is what
 * `new Set(['ready_for_terminal','cancelled','declined','failed'])` made impossible.
 */
const DECLINED = new Set(['declined'])
const CANCELLED = new Set(['cancelled'])
const AWAITING_PAYMENT = new Set(['ready_for_terminal'])
const PAYMENT_FAILED = new Set(['failed'])
const COMPLETED = new Set(['completed'])

export type CustomerStatusInput = {
  status: unknown
  paymentStatus?: unknown
}

/**
 * PAID WINS, and it is checked first.
 *
 * `markOrderPaidConfirmed` writes `status: 'completed'` from ANY status, and the terminal can
 * settle an order the kitchen is still working on. Reading `status` first would show "Being
 * prepared" on an order the customer has already paid for, which is the more alarming of the two
 * possible wrong answers.
 */
export function customerOrderState(input: CustomerStatusInput): CustomerOrderState {
  const payment = String(input.paymentStatus ?? '').toLowerCase()
  if (payment === 'paid') return 'paid'
  if (payment === 'failed') return 'payment_failed'

  const status = normalizeOrderStatusForDisplay(input.status)
  if (!status) return 'unknown'
  if (WAITING.has(status)) return 'waiting'
  if (ACCEPTED.has(status)) return 'accepted'
  if (PREPARING.has(status)) return 'preparing'
  if (READY.has(status)) return 'ready'
  if (DECLINED.has(status)) return 'declined'
  if (CANCELLED.has(status)) return 'cancelled'
  if (AWAITING_PAYMENT.has(status)) return 'awaiting_payment'
  if (PAYMENT_FAILED.has(status)) return 'payment_failed'
  /**
   * `completed` without `payment_status = 'paid'`. Deliberately NOT "Paid": staff reconcile can
   * complete an order without a payment (#234), and telling a customer they have paid when the
   * money record says otherwise is the one error in this table that costs somebody money.
   */
  if (COMPLETED.has(status)) return 'ready'
  return 'unknown'
}

/** The word to render. One call site's worth of convenience over the pair above. */
export function customerStatusLabel(status: unknown, paymentStatus?: unknown): string {
  return CUSTOMER_STATUS_COPY[customerOrderState({ status, paymentStatus })]
}

/**
 * Whether the state calls for the customer to do something, so a render site can emphasise it
 * apart from one that does not.
 *
 * ONLY `payment_failed` qualifies. The other three ex-`needs_you` states are STATEMENTS, not
 * requests: a refusal, a cancellation and an order sitting at the terminal are all things that
 * have happened TO the order, and none of them is an instruction. Treating them as demands is
 * what made "See staff" read like a control the customer was supposed to operate.
 */
export function customerStateNeedsAttention(state: CustomerOrderState): boolean {
  return state === 'payment_failed'
}

/**
 * IS THIS ORDER OVER, with nothing left for the customer to do or expect?
 *
 * FOUND ON PRODUCTION 2026-08-18: three declined orders from ten hours earlier were stacked above
 * today's food on My Orders. Measured cause — `lib/guest-orders/queries.ts` bounds the list by
 * restaurant, session and `tab_settlement_for_tab_id IS NULL` and by nothing else on the orders
 * side, and by `status IN ('waiting_review','accepting','declined')` on the requests side. No time
 * bound and no limit on either. So every order a session ever placed accumulates forever.
 *
 * DELIBERATELY NARROWER THAN `needs_you`. That state also covers `ready_for_terminal` and a failed
 * payment, both of which the customer genuinely must act on — demoting those would hide something
 * that needs attention, which is a worse defect than the one being fixed. Dead means dead:
 *
 *   declined   staff refused it. There is nothing coming and no number will ever be allocated.
 *   cancelled  it was called off. Same.
 *
 * `paid` and `completed` are NOT dead here. A paid order from twenty minutes ago is still part of
 * "what is happening with my food"; it is the record of the meal in progress.
 */
export function isDeadOrder(input: CustomerStatusInput): boolean {
  const status = normalizeOrderStatusForDisplay(input.status)
  return status === 'declined' || status === 'cancelled'
}

/**
 * How long a dead order stays in the LIVE list before moving to the collapsed section.
 *
 * A customer declined a minute ago must SEE it — hiding a fresh decline is worse than showing a
 * stale one, and it is the whole reason this is a window rather than a blanket filter. 90 minutes
 * covers a meal with room to spare, and is short enough that yesterday's refusals are gone by the
 * time the same phone scans again.
 *
 * Chosen, not measured: there is no data on how long a customer takes to notice a decline. It is
 * one named constant so it can be moved on evidence rather than hunted through render code.
 */
export const DEAD_ORDER_LIVE_WINDOW_MS = 90 * 60 * 1000

/**
 * Whether a dead order has aged out of the live list. Live orders never age out, whatever their
 * age — a submission the restaurant has not answered is still the customer's open question.
 */
export function isStaleDeadOrder(
  input: CustomerStatusInput & { placedAt?: unknown },
  nowMs: number = Date.now(),
): boolean {
  if (!isDeadOrder(input)) return false
  const raw = input.placedAt
  const t = raw instanceof Date ? raw.getTime() : Date.parse(String(raw ?? ''))
  // An unparseable timestamp is treated as OLD. A dead order with no readable date is exactly the
  // debris this is meant to clear, and keeping it live forever is the failure being fixed.
  if (!Number.isFinite(t)) return true
  return nowMs - t > DEAD_ORDER_LIVE_WINDOW_MS
}

/**
 * HOW LONG AN UNANSWERED REQUEST WAITS BEFORE STAFF ARE TOLD IT IS OVERDUE.
 *
 * THE DEFECT THIS SERVES, measured 2026-08-18. Every writer of `order_requests.status` is a human
 * action (staff accept / decline / review, and the customer's own insert); the every-2-minutes
 * cron sweeps `orders` only. So an unanswered request has no timeout, no escalation, and no
 * surface that ranks it — it is indistinguishable from one placed thirty seconds ago until
 * somebody scrolls. Production had one open for 477 HOURS. That is not staff ignoring a customer.
 * Nothing told them.
 *
 * WHY FIFTEEN MINUTES, and the honest state of the evidence.
 *
 *   WHAT WAS MEASURED. Time-to-accept on production, via `orders.placed_at` minus
 *   `order_requests.placed_at` joined on `source_request_id`: **1.1 minutes**, and the whole
 *   sample was n=1 — `source_request_id` is a recent column and is barely populated yet. The open
 *   rows at the same moment were 3.2h and 477h. There is nothing in between.
 *
 *   SO THIS IS A JUDGEMENT ON THIN EVIDENCE, and it is stated as one rather than dressed up as a
 *   percentile. What the data does support is the SHAPE: an answer that happens happens in about a
 *   minute, and the ones that do not happen are hours to weeks away. Any threshold in that gap
 *   separates the two populations.
 *
 *   FIFTEEN MINUTES sits in that gap, roughly 13x the one observed accept, so ordinary service —
 *   including a genuinely busy pass — does not trip it. It is short enough to matter inside one
 *   sitting: a customer who has waited a quarter of an hour with no answer is still at the table
 *   and can still be served, which is exactly the window where telling staff changes the outcome.
 *
 *   REVISABLE, and deliberately one named constant so it moves on evidence rather than being
 *   hunted through render code. Re-run
 *   scripts/probe-waiting-review-age-production-readonly.ts once `source_request_id` has a real
 *   sample and set it from the p95.
 *
 * THIS IS A READ. Nothing here or at its call sites changes a request's status. Auto-declining
 * food for a customer who may still be sitting at the table is a separate ruling and is not this.
 */
export const STALE_REQUEST_THRESHOLD_MS = 15 * 60 * 1000

/**
 * Has this submission been waiting longer than staff should ever leave one?
 *
 * An unparseable timestamp reads as NOT stale, the opposite of `isStaleDeadOrder`. The two
 * defaults differ because the consequences do: there, treating undated debris as old CLEARS a
 * dead row off a customer's screen; here, treating an undated row as overdue would put a false
 * alarm at the top of a working queue, and a staff signal that cries wolf is ignored — which is
 * the failure this exists to fix.
 */
export function isRequestOverdue(placedAt: unknown, nowMs: number = Date.now()): boolean {
  const t = placedAt instanceof Date ? placedAt.getTime() : Date.parse(String(placedAt ?? ''))
  if (!Number.isFinite(t)) return false
  return nowMs - t > STALE_REQUEST_THRESHOLD_MS
}

/** Whole minutes a submission has been waiting. For the staff label; never shown to a customer. */
export function requestWaitingMinutes(placedAt: unknown, nowMs: number = Date.now()): number {
  const t = placedAt instanceof Date ? placedAt.getTime() : Date.parse(String(placedAt ?? ''))
  if (!Number.isFinite(t)) return 0
  return Math.max(0, Math.floor((nowMs - t) / 60000))
}
