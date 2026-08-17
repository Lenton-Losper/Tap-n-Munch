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

/** The six words a QR customer may be shown, plus the honest unknown. */
export const CUSTOMER_ORDER_STATES = [
  'waiting',
  'accepted',
  'preparing',
  'ready',
  'paid',
  'needs_you',
  'unknown',
] as const

export type CustomerOrderState = (typeof CUSTOMER_ORDER_STATES)[number]

/**
 * PLACEHOLDER WORDING. Signed-off copy replaces the values, never the keys.
 * `git grep "PENDING COPY" -- lib/orders/customer-status.ts`
 */
export const CUSTOMER_STATUS_COPY: Record<CustomerOrderState, string> = {
  waiting: 'Waiting for restaurant',
  accepted: 'Accepted',
  preparing: 'Being prepared',
  ready: 'Ready',
  paid: 'Paid',
  needs_you: 'See staff',
  unknown: 'Order update',
}

const WAITING = new Set(['waiting_review', 'pending'])
const ACCEPTED = new Set(['accepted'])
const PREPARING = new Set(['preparing'])
const READY = new Set(['ready'])
const NEEDS_YOU = new Set(['ready_for_terminal', 'cancelled', 'declined', 'failed'])
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
  if (payment === 'failed') return 'needs_you'

  const status = normalizeOrderStatusForDisplay(input.status)
  if (!status) return 'unknown'
  if (WAITING.has(status)) return 'waiting'
  if (ACCEPTED.has(status)) return 'accepted'
  if (PREPARING.has(status)) return 'preparing'
  if (READY.has(status)) return 'ready'
  if (NEEDS_YOU.has(status)) return 'needs_you'
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
 * Whether the state calls for the customer to do something. Drives emphasis at render sites, so
 * that "Needs you" is not styled like "Being prepared".
 */
export function customerStateNeedsAttention(state: CustomerOrderState): boolean {
  return state === 'needs_you'
}
