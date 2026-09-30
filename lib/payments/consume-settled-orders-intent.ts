import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { findIntentByMerchantOrderNo } from '@/lib/payments/payment-intents'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * A SETTLED CARD CHARGE RESOLVES THE INTENT IT WAS LAUNCHED UNDER (Sprint 2026-09-30).
 *
 * prepare-payment records an orders-scope `terminal_payment_intents` row for every card charge.
 * settle_order_payment consumes it -- status 'confirmed', consumed_at, the gateway's figures -- but
 * only when a caller passes p_intent_id, which the webhook and verify-payment do. The two DEVICE
 * success paths do not go through that function:
 *
 *   POST /api/terminal/tabs/[tabId]/settle        (card)  a direct orders claim
 *   POST /api/terminal/orders/[orderId]/payment   (card)  markOrderPaidConfirmed
 *
 * so a charge the device reported as approved left its intent 'launched' forever: a paid tab that
 * still reads as a charge in flight (the tab reconciliation's payments_in_flight_on_paid_orders).
 * Each now calls this AFTER its claim succeeded.
 *
 * NEVER ANOTHER CHARGE'S INTENT. Consumed only when the intent is found by THIS charge's
 * merchant order number, belongs to this venue, is orders-scope, is still launched/uncertain and
 * not consumed, and EVERY order it names was settled by this claim. Anything else is left exactly
 * as it was and reported as 'ineligible'. The update itself re-asserts the status and consumed_at
 * conditions, so a webhook consuming it first is not overwritten.
 *
 * THE ATTEMPT ON THE ORDERS, TOO. settle_order_payment clears pending_charge_cents and its
 * companions when the charge lands ("F18: pending_* describes an ATTEMPT, and this one has
 * landed"); neither device path did, so a paid order kept a live-looking charge expectation
 * (reconciliation: paid_orders_still_marked_in_flight). They are cleared here on the settled
 * orders only, and only once they are 'paid' -- a separate UPDATE after the claim, so the FTCHG
 * backstop (orders_refuse_paid_on_changed_charge) has already judged the paid transition against
 * the prepared basis.
 *
 * Never throws: the money has already been settled; a failure here is logged and reported.
 */
export type ConsumeIntentOutcome = 'consumed' | 'no_intent' | 'ineligible' | 'failed'

export async function consumeSettledOrdersIntent(
  supabase: Supabase,
  params: {
    restaurantId: string
    merchantOrderNo: string | null
    settledOrderIds: readonly string[]
    chargedCents: number
    transactionId: string | null
    paymentMethod: string
    source: string
  },
): Promise<ConsumeIntentOutcome> {
  if (params.settledOrderIds.length > 0) {
    try {
      const { error: clearError } = await supabase
        .from('orders')
        .update({ pending_charge_cents: null, pending_tip_cents: 0, pending_tip_staff_user_id: null, pending_settlement_id: null })
        .in('id', [...params.settledOrderIds])
        .eq('restaurant_id', params.restaurantId)
        .eq('payment_status', 'paid')
        .not('pending_charge_cents', 'is', null)
      if (clearError) throw new Error(clearError.message)
    } catch (clearError) {
      console.error(`[consumeSettledOrdersIntent:${params.source}] could not clear the landed attempt`, {
        orderIds: params.settledOrderIds,
        error: clearError instanceof Error ? clearError.message : String(clearError),
      })
    }
  }
  const mo = String(params.merchantOrderNo ?? '').trim()
  if (!mo) return 'no_intent'
  try {
    const intent = await findIntentByMerchantOrderNo(supabase, mo)
    if (!intent) return 'no_intent'
    const settled = new Set(params.settledOrderIds.map(String))
    const eligible =
      intent.restaurantId === params.restaurantId &&
      intent.scope === 'orders' &&
      (intent.status === 'launched' || intent.status === 'uncertain') &&
      intent.orderIds.length > 0 &&
      intent.orderIds.every((id) => settled.has(String(id)))
    if (!eligible) return 'ineligible'

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('terminal_payment_intents')
      .update({
        status: 'confirmed',
        resolved_at: now,
        consumed_at: now,
        gateway_amount_cents: Math.round(params.chargedCents),
        gateway_transaction_id: params.transactionId,
        gateway_payment_method: params.paymentMethod,
        settled_order_ids: intent.orderIds,
      })
      .eq('id', intent.id)
      .in('status', ['launched', 'uncertain'])
      .is('consumed_at', null)
      .select('id')
    if (error) throw new Error(error.message)
    return (data ?? []).length === 1 ? 'consumed' : 'ineligible'
  } catch (error) {
    console.error(`[consumeSettledOrdersIntent:${params.source}] could not resolve the intent`, {
      merchantOrderNo: mo,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'failed'
  }
}
