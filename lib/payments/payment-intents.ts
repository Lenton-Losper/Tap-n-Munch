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
}

const SELECT =
  'id, merchant_order_no, amount_cents, scope, order_ids, allocation_ids, status, restaurant_id, tab_id'

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
 * Allocation ids currently held by a card that has not resolved.
 *
 * `launched` AND `uncertain` both hold. An uncertain intent holds hardest of all: the gateway may
 * still answer yes, so releasing those items would let a second customer pay for the first
 * customer's food while the first customer's card was settling.
 */
export async function allocationIdsHeldByLiveCard(
  supabase: Supabase,
  params: { restaurantId: string; allocationIds: string[] },
): Promise<string[]> {
  if (params.allocationIds.length === 0) return []

  const { data, error } = await supabase
    .from('terminal_payment_intents')
    .select('allocation_ids')
    .eq('restaurant_id', params.restaurantId)
    .eq('scope', 'allocations')
    .in('status', ['launched', 'uncertain'])
    .overlaps('allocation_ids', params.allocationIds)

  // FAILS CLOSED. Not being able to read the hold is not permission to take the money again.
  if (error) throw new Error(`allocationIdsHeldByLiveCard: ${error.message}`)

  const asked = new Set(params.allocationIds)
  const held = new Set<string>()
  for (const row of data ?? []) {
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
