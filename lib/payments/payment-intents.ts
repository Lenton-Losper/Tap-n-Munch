import type { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  generateTerminalMerchantOrderNo,
  isPaycloudSafeMerchantOrderNo,
} from '@/lib/payments/terminal-merchant-order'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * ONE REFERENCE PER CARD CHARGE.
 *
 * ================================================================================================
 * WHAT THIS SOLVES
 * ================================================================================================
 *
 * `orders.paycloud_merchant_order_no` is one column per order, minted once and never rotated, so a
 * second card charge against the same order reuses the first charge's reference and the webhook —
 * which correlates byte-exact — cannot tell the two settlements apart. That is what made "card
 * only works on a whole order" true. The reader was never the obstacle: it is handed
 * `{businessOrderNo, paymentScenario, amt, notifyUrl, POSMode}` and will charge any amount asked.
 *
 * An intent carries its OWN merchant_order_no, so three people paying for their own items on one
 * order cannot collide by construction.
 *
 * ================================================================================================
 * THE WHOLE-ORDER PATH DOES NOT COME THROUGH HERE
 * ================================================================================================
 *
 * `ensureTerminalMerchantOrderNo` and `orders.paycloud_merchant_order_no` are untouched and still
 * serve every ordinary card payment at every venue. This module is the SPLIT path's sibling, not
 * its replacement. Owner's ruling, 2026-09-06: two mechanisms coexisting is the correct trade, and
 * a defect here must not be able to reach the path all venues already use.
 *
 * ================================================================================================
 * NOTHING HERE RESOLVES AN UNCERTAIN INTENT
 * ================================================================================================
 *
 * `markIntentUncertain` is terminal. There is deliberately no timeout, no sweep, and no function
 * that turns `uncertain` into `confirmed` or `failed` on its own: E04111 from this gateway means NO
 * RECORD, never NOT PAID. Auto-settling turns that into a free meal; auto-failing takes a real
 * charge twice. A webhook resolves it, or a human does.
 */

export type IntentScope = 'orders' | 'allocations'
export type IntentStatus = 'launched' | 'confirmed' | 'failed' | 'uncertain'

export type PaymentIntent = {
  id: string
  merchantOrderNo: string
  amountCents: number
  scope: IntentScope
  orderIds: string[]
  allocationIds: string[]
  status: IntentStatus
  /** Part of amountCents that is a gratuity. Zero for most charges. */
  tipCents: number
  tipStaffUserId: string | null
  restaurantId: string
  tabId: string | null
}

type IntentRow = {
  id: string
  merchant_order_no: string
  amount_cents: number
  scope: string
  order_ids: string[] | null
  allocation_ids: string[] | null
  status: string
  restaurant_id: string
  tab_id: string | null
  tip_cents: number | null
  tip_staff_user_id: string | null
}

/**
 * SELECTED, not merely written. A column the route writes and never reads back is inert -- the
 * gratuity has to come back out of this row for the settlement to split the charge into items and
 * tip, and a webhook-settled payment has no other source for it.
 */
const SELECT =
  'id, merchant_order_no, amount_cents, scope, order_ids, allocation_ids, status, restaurant_id, tab_id, tip_cents, tip_staff_user_id'

function toIntent(row: IntentRow): PaymentIntent {
  return {
    id: String(row.id),
    merchantOrderNo: String(row.merchant_order_no),
    amountCents: Number(row.amount_cents),
    scope: row.scope === 'allocations' ? 'allocations' : 'orders',
    orderIds: Array.isArray(row.order_ids) ? row.order_ids.map(String) : [],
    allocationIds: Array.isArray(row.allocation_ids) ? row.allocation_ids.map(String) : [],
    status: row.status as IntentStatus,
    restaurantId: String(row.restaurant_id),
    tabId: row.tab_id ? String(row.tab_id) : null,
    tipCents: Number(row.tip_cents ?? 0),
    tipStaffUserId: row.tip_staff_user_id ? String(row.tip_staff_user_id) : null,
  }
}

/**
 * Mints an intent and returns it, with the reference the device must send as businessOrderNo.
 *
 * A FRESH REFERENCE EVERY TIME, and that is the entire point — this must never reuse. The
 * no-rotation rule that governs the order column exists because that column is the ORDER's single
 * reference; an intent is one ATTEMPT's, and two attempts are two references.
 *
 * Retries on the unique index the way the order minter does: a collision is a coincidence of
 * millisecond and random suffix, not a state to resolve.
 */
export async function createPaymentIntent(
  supabase: Supabase,
  params: {
    restaurantId: string
    terminalId: string | null
    tabId: string | null
    amountCents: number
    scope: IntentScope
    orderIds?: string[]
    allocationIds?: string[]
    /**
     * How much of amountCents is a gratuity. amountCents is what the READER is asked for -- items
     * plus tip -- because that one figure is what a gateway echo is reconciled against. This is
     * what lets the settlement split it back apart afterwards.
     */
    tipCents?: number
    tipStaffUserId?: string | null
  },
): Promise<PaymentIntent> {
  const amountCents = Math.round(Number(params.amountCents))
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error('createPaymentIntent: amountCents must be a positive integer')
  }

  const orderIds = params.scope === 'orders' ? (params.orderIds ?? []) : []
  const allocationIds = params.scope === 'allocations' ? (params.allocationIds ?? []) : []
  if (params.scope === 'orders' && orderIds.length === 0) {
    throw new Error('createPaymentIntent: an orders intent needs at least one order id')
  }
  if (params.scope === 'allocations' && allocationIds.length === 0) {
    throw new Error('createPaymentIntent: an allocations intent needs at least one allocation id')
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const merchantOrderNo = generateTerminalMerchantOrderNo()
    // The same guard the order minter applies. A reference Finatic cannot carry is worse than a
    // collision: it produces a charge nothing can ever correlate.
    if (!isPaycloudSafeMerchantOrderNo(merchantOrderNo)) continue

    const { data, error } = await supabase
      .from('terminal_payment_intents')
      .insert({
        restaurant_id: params.restaurantId,
        terminal_id: params.terminalId,
        tab_id: params.tabId,
        merchant_order_no: merchantOrderNo,
        amount_cents: amountCents,
        scope: params.scope,
      tip_cents: Math.max(0, Math.round(Number(params.tipCents ?? 0))),
      tip_staff_user_id: params.tipStaffUserId ?? null,
        order_ids: params.scope === 'orders' ? orderIds : null,
        allocation_ids: params.scope === 'allocations' ? allocationIds : null,
        status: 'launched',
      })
      .select(SELECT)
      .single()

    if (!error && data) return toIntent(data as IntentRow)

    // 23505 is the unique index on merchant_order_no. Anything else is real.
    if (error && error.code !== '23505') {
      throw new Error(`createPaymentIntent: ${error.message}`)
    }
  }

  throw new Error('createPaymentIntent: could not mint a unique merchant_order_no in 5 attempts')
}

/**
 * ==================================================================================================
 * THE WHOLE-ORDER PATH, ON THE SAME MECHANISM (F4)
 * ==================================================================================================
 *
 * The module header above records the 2026-09-06 ruling that two reference mechanisms coexisting
 * was the correct trade, and why: a defect in the new split path must not be able to reach the path
 * every venue already used. That ruling is SUPERSEDED here, deliberately, and the reason it was
 * right at the time is the reason it is wrong now.
 *
 * It was right while the split path was new and the whole-order path was working. The whole-order
 * path was NOT working: it produced Riviera settlement 4158ff51 on 2026-09-18, which charged N$720
 * across orders #154 and #155 and paid only #155. Keeping the two apart no longer protects a sound
 * mechanism from a risky one -- it keeps a second, weaker definition of "what is being paid for"
 * alive alongside the strong one.
 *
 * WHAT AN INTENT ADDS THAT `pending_settlement_id` CANNOT. The settlement id groups rows; it does
 * not record what was ASKED of the reader. A settlement expanded from it can be compared with the
 * gateway's figure, but nothing can say whether that figure is what the customer agreed to pay --
 * which is exactly the stale-snapshot case. An intent carries `amount_cents`, written before the
 * reader was launched, and `settle_order_payment` refuses when the two disagree.
 *
 * ==================================================================================================
 * NOTHING IS REMOVED, AND THE DEPLOYMENT ORDER DEPENDS ON THAT
 * ==================================================================================================
 *
 * `orders.paycloud_merchant_order_no`, `pending_charge_cents` and `pending_settlement_id` are all
 * still written and still read. An intent is ADDITIVE:
 *
 *   a worker that predates this  ignores `resolved.intent` for scope 'orders' and expands through
 *                                pending_settlement_id, exactly as it does today
 *   a terminal that predates it  sends the same businessOrderNo it always did -- the intent is
 *                                keyed on that value, so the device has nothing new to learn
 *
 * So this ships before, after or without a terminal build, and rolling it back is a code revert
 * with no data migration. See docs/payment-hardening-remediation.md.
 */
export async function ensureOrdersIntent(
  supabase: Supabase,
  params: {
    restaurantId: string
    terminalId: string | null
    tabId: string | null
    /** The reference the device will send. Minted by ensureTerminalMerchantOrderNo, never rotated. */
    merchantOrderNo: string
    amountCents: number
    orderIds: string[]
    tipCents?: number
    tipStaffUserId?: string | null
  },
): Promise<PaymentIntent | null> {
  const mo = String(params.merchantOrderNo ?? '').trim()
  if (!mo || params.orderIds.length === 0) return null

  const amountCents = Math.round(Number(params.amountCents))
  if (!Number.isFinite(amountCents) || amountCents <= 0) return null

  /**
   * FIND FIRST. `ensureTerminalMerchantOrderNo` is idempotent by design -- a repeated prepare for
   * the same live attempt gets the same reference back with created:false -- so this function runs
   * again with the same merchant_order_no, which is UNIQUE. A second insert would be a 23505.
   */
  const existing = await findIntentByMerchantOrderNo(supabase, mo)
  if (existing) {
    /**
     * A RESOLVED INTENT IS NEITHER REUSED NOR REWRITTEN.
     *
     * If the reference has already been confirmed, failed or declared uncertain, this attempt is
     * not the one that intent describes. Returning null drops the caller back to the
     * `pending_settlement_id` basis -- today's behaviour -- rather than mutating the record of a
     * charge that has already happened.
     */
    if (existing.status !== 'launched') return null

    // The figure may legitimately move between two prepares for one attempt: a line is voided, a
    // gratuity is added. The intent must describe THIS attempt, so it is updated -- and only while
    // it is still unresolved and unconsumed.
    const { data, error } = await supabase
      .from('terminal_payment_intents')
      .update({
        amount_cents: amountCents,
        order_ids: params.orderIds,
        tip_cents: Math.max(0, Math.round(Number(params.tipCents ?? 0))),
        tip_staff_user_id: params.tipStaffUserId ?? null,
      })
      .eq('id', existing.id)
      .eq('status', 'launched')
      .is('consumed_at', null)
      .select(SELECT)
      .maybeSingle()

    if (error || !data) {
      console.error('[ensureOrdersIntent] could not refresh the intent', {
        merchantOrderNo: mo,
        error: error?.message,
      })
      return null
    }
    return toIntent(data as IntentRow)
  }

  const { data, error } = await supabase
    .from('terminal_payment_intents')
    .insert({
      restaurant_id: params.restaurantId,
      terminal_id: params.terminalId,
      tab_id: params.tabId,
      // THE DEVICE'S OWN REFERENCE, not a freshly minted one. A split charge mints its own because
      // two attempts on one order are two references; a whole-order charge already HAS a reference,
      // and minting a second would give the webhook two rows to correlate one payment against.
      merchant_order_no: mo,
      amount_cents: amountCents,
      scope: 'orders',
      order_ids: params.orderIds,
      allocation_ids: null,
      tip_cents: Math.max(0, Math.round(Number(params.tipCents ?? 0))),
      tip_staff_user_id: params.tipStaffUserId ?? null,
      status: 'launched',
    })
    .select(SELECT)
    .maybeSingle()

  if (error) {
    /**
     * NEVER FATAL. Everything downstream still works without an intent: the target is expanded
     * through `pending_settlement_id` and the gateway amount is still checked against it. Refusing
     * to prepare a payment because a STRENGTHENING record could not be written would turn an
     * improvement into an outage at the till.
     */
    console.error('[ensureOrdersIntent] could not record the intent', {
      merchantOrderNo: mo,
      error: error.message,
    })
    return null
  }
  return data ? toIntent(data as IntentRow) : null
}

/** The webhook's lookup. Returns null for a reference that is not an intent — every OLD one. */
export async function findIntentByMerchantOrderNo(
  supabase: Supabase,
  merchantOrderNo: string,
): Promise<PaymentIntent | null> {
  const mo = String(merchantOrderNo ?? '').trim()
  if (!mo) return null

  /**
   * `.eq()`, never `.or()`. This value arrives from the webhook BODY and is reached on the path
   * where signature verification FAILED, so it is unauthenticated — the same exposure that made
   * #242 a cross-tenant filter injection. A column filter has no parser and therefore nothing to
   * inject into. See resolve-order-by-merchant-order.ts for the full account.
   */
  const { data, error } = await supabase
    .from('terminal_payment_intents')
    .select(SELECT)
    .eq('merchant_order_no', mo)
    .maybeSingle()

  if (error) throw new Error(`findIntentByMerchantOrderNo: ${error.message}`)
  return data ? toIntent(data as IntentRow) : null
}

/**
 * HOW LONG ONE CARD INTENT MAY BLOCK ITS ITEMS.
 *
 * ==================================================================================================
 * THIS DOES NOT RESOLVE ANYTHING, AND THAT IS THE POINT
 * ==================================================================================================
 *
 * The ruling at the top of this file stands and is NOT weakened here: `uncertain` is terminal,
 * nothing sweeps it, and no code turns it into `confirmed` or `failed` on its own. E04111 means NO
 * RECORD, never NOT PAID -- auto-settling is a free meal and auto-failing takes a real charge
 * twice. A webhook resolves an intent, or a human does. Still true after this change.
 *
 * What is bounded is a DIFFERENT question: not "was this paid?" but "may this row keep the till
 * shut?". Those were the same question only because the hold had no clock at all.
 *
 * ==================================================================================================
 * WHY ONE HOUR
 * ==================================================================================================
 *
 * Production, 2026-09-07: intent 538981e8 at Digi Cofee sat `uncertain` with `resolved_at` SET,
 * holding all four of order #47's allocations. Five and a half hours later it was still answering
 * "Someone is already paying for these by card" to a waiter at a table where nobody was paying.
 * Nothing releases it, ever -- terminal_payment_intents has no sweep and no expiry.
 *
 * One hour is chosen against three fixed points, not picked for feel:
 *
 *   - CARD_IN_FLIGHT_TIMEOUT_SECONDS is 90. An hour is forty times that, so this can never release
 *     during, or just after, a real interaction at a reader.
 *   - The stale-order cron re-asks the gateway about unresolved payments every hour
 *     (SKIP_REPROBE_INTERVAL_MS). By the time a hold expires, the gateway has been re-asked about
 *     it at least once, so releasing is never the FIRST thing that happens to an unknown payment.
 *   - Every intent on production that resolved did so within forty seconds. An hour is not a
 *     borderline call against observed behaviour; it is three orders of magnitude clear of it.
 *
 * It is deliberately far shorter than E04111_PERSISTENCE_CANCEL_MS (72h). That figure governs
 * CANCELLING an order -- destroying a claim on money -- and deserves to be slow. This one governs
 * whether a waiter may take payment for a plate of food, and a service does not last 72 hours.
 */
export const INTENT_HOLD_MAX_AGE_MS = 60 * 60 * 1000

type IntentHoldRow = {
  status?: unknown
  created_at?: unknown
  resolved_at?: unknown
}

/**
 * Is this intent still entitled to block its allocations?
 *
 * A pure function of one row so the rule can be tested directly, rather than inferred from what a
 * query returned. FAILS CLOSED at every unknown: a status it cannot read, or a timestamp it cannot
 * parse, keeps holding. Not being able to age a hold is not permission to take the money again.
 *
 * The clock runs from `resolved_at` when the device came back and said it did not know, and from
 * `created_at` when it never came back at all. Using the LATER of the two is the safe direction:
 * an intent the device reported on gets its full window from the moment of that report.
 */
export function intentHoldIsStillLive(row: IntentHoldRow, now: number = Date.now()): boolean {
  const status = String(row?.status ?? '')
  if (status !== 'launched' && status !== 'uncertain') return false

  const stamp = row?.resolved_at ?? row?.created_at
  if (stamp == null || stamp === '') return true

  const at = Date.parse(String(stamp))
  if (!Number.isFinite(at)) return true

  return now - at < INTENT_HOLD_MAX_AGE_MS
}

/**
 * Allocation ids currently held by a card that has not resolved.
 *
 * `launched` AND `uncertain` both hold, unchanged. An uncertain intent still holds hardest of all:
 * the gateway may yet answer yes, and releasing those items would let a second customer pay for the
 * first customer's food while the first customer's card was settling.
 *
 * What is new is that the hold is BOUNDED -- see intentHoldIsStillLive. `confirmed` and `failed`
 * never held and still never do.
 */
export async function allocationIdsHeldByLiveCard(
  supabase: Supabase,
  params: { restaurantId: string; allocationIds: string[] },
): Promise<string[]> {
  if (params.allocationIds.length === 0) return []

  const { data, error } = await supabase
    .from('terminal_payment_intents')
    /**
     * The timestamps come back and the age rule is applied HERE rather than in the filter.
     *
     * Expressing "the later of resolved_at and created_at is within the window" in PostgREST needs
     * .or(), whose value is parsed rather than bound -- the shape behind #242/#254. The candidate
     * set is already narrowed to this venue's unresolved intents overlapping these few allocation
     * ids, so it is tiny, and a pure function over it is both safer and directly testable.
     */
    .select('allocation_ids, status, created_at, resolved_at')
    .eq('restaurant_id', params.restaurantId)
    .eq('scope', 'allocations')
    .in('status', ['launched', 'uncertain'])
    .overlaps('allocation_ids', params.allocationIds)

  // FAILS CLOSED. Not being able to read the hold is not permission to take the money again.
  if (error) throw new Error(`allocationIdsHeldByLiveCard: ${error.message}`)

  const asked = new Set(params.allocationIds)
  const held = new Set<string>()
  for (const row of data ?? []) {
    // A hold that has outlived its window stops blocking. The row itself is untouched: still
    // `uncertain`, still unresolved, still there for the webhook or a human to settle.
    if (!intentHoldIsStillLive(row as IntentHoldRow)) continue
    for (const id of (row as { allocation_ids: string[] | null }).allocation_ids ?? []) {
      if (asked.has(String(id))) held.add(String(id))
    }
  }
  return [...held]
}

/**
 * Does THIS intent account for every one of these held allocations?
 *
 * The exemption that lets an intent settle its own items. It is deliberately narrow: the answer is
 * true only when the intent covers ALL of them, so an intent holding a1 cannot be used to settle a1
 * AND a2 while a different intent holds a2. Anything less than complete containment is a refusal,
 * because a partial exemption is how one payment settles another payment's items.
 *
 * A failed read is `false` — refuse — rather than a throw, because the caller has already decided
 * to refuse by the time it asks; this only says whether to lift that refusal.
 */
export async function intentHoldsExactly(
  supabase: Supabase,
  intentId: string,
  allocationIds: string[],
): Promise<boolean> {
  if (!intentId || allocationIds.length === 0) return false

  const { data, error } = await supabase
    .from('terminal_payment_intents')
    .select('allocation_ids, status')
    .eq('id', intentId)
    .maybeSingle()

  if (error || !data) return false

  const row = data as { allocation_ids: string[] | null; status: string }
  // A resolved intent holds nothing, so it cannot exempt anything either.
  if (row.status !== 'launched' && row.status !== 'uncertain') return false

  const mine = new Set((row.allocation_ids ?? []).map(String))
  return allocationIds.every((id) => mine.has(String(id)))
}

/** Terminal states. Each stamps resolved_at; none of them is reachable from a timer. */
export async function markIntentConfirmed(supabase: Supabase, intentId: string): Promise<void> {
  await setStatus(supabase, intentId, 'confirmed')
}

export async function markIntentFailed(supabase: Supabase, intentId: string): Promise<void> {
  await setStatus(supabase, intentId, 'failed')
}

/**
 * WE DO NOT KNOW. The intent keeps holding whatever it covers, and nothing in this codebase may
 * move it out of here on its own — see the module header.
 */
export async function markIntentUncertain(supabase: Supabase, intentId: string): Promise<void> {
  await setStatus(supabase, intentId, 'uncertain')
}

async function setStatus(supabase: Supabase, intentId: string, status: IntentStatus): Promise<void> {
  const { error } = await supabase
    .from('terminal_payment_intents')
    .update({ status, resolved_at: new Date().toISOString() })
    /**
     * A CONFIRMED INTENT IS NEVER MOVED AGAIN. A late ambiguous device outcome arriving after a
     * webhook already settled would otherwise walk a proven payment back to `uncertain` and hold
     * items that are paid for.
     */
    .eq('id', intentId)
    .neq('status', 'confirmed')

  if (error) throw new Error(`setIntentStatus(${status}): ${error.message}`)
}
