/**
 * AN UNRESOLVED CARD ATTEMPT THE GATEWAY HAS NOW ANSWERED "NOT PAID" (RC-RACES D4, 2026-09-30).
 *
 * 20260930110100 blocks every new card charge for an attempt reported uncertain (FTUNR), with no
 * timeout -- an E04111 is NO RECORD, never NOT PAID. What lifts the block is EVIDENCE:
 *
 *   * Finatic answers a RECOGNISED not-paid status for the attempt's reference (trans_status 1, or
 *     a failed/closed trade status -- the `statusRecognised && !paid` basis handleTerminalPaymentFailed
 *     already acts on for a decline). "Check payment status" releases the attempt here and answers
 *     `attemptResolution: 'resolved_not_paid'`.
 *   * A manager cancels the attempt from the dashboard and the gateway CLOSES the reference
 *     (payments/cancel-terminal) -- that route clears the expectation itself.
 *
 * An E04111, any number of them, at any age, releases nothing. The release is an expectation
 * release only, like the D1 decline rule for a tab: the order stays owed and is never cancelled.
 * Only orders still marked unresolved are touched, so a reader that is still open (not yet reported)
 * is never released from under the customer.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { findIntentByMerchantOrderNo, markIntentFailed } from '@/lib/payments/payment-intents'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/** The field verify-payment answers with. The terminal clears its block ONLY on 'resolved_not_paid'. */
export type AttemptResolution = 'paid' | 'resolved_not_paid' | 'unresolved'

export const UNRESOLVED_ATTEMPT_RELEASED_ACTION = 'payment.unresolved_attempt_released'

export async function releaseUnresolvedAttemptNotPaid(
  supabase: Supabase,
  params: {
    restaurantId: string
    orderId: string
    pendingSettlementId: string | null
    merchantOrderNo: string
    finaticStatus: string
    terminalId: string
  },
): Promise<{ released: string[] }> {
  const clear = {
    pending_charge_cents: null,
    pending_tip_cents: 0,
    pending_tip_staff_user_id: null,
    pending_settlement_id: null,
  }
  // Two `.eq()` statements rather than one `.or()`: parser-free, so no id can reshape the filter.
  const released = new Set<string>()
  const targets: Array<['id' | 'pending_settlement_id', string]> = [['id', params.orderId]]
  if (params.pendingSettlementId) targets.push(['pending_settlement_id', params.pendingSettlementId])
  for (const [column, value] of targets) {
    const { data, error } = await supabase
      .from('orders')
      .update(clear)
      .eq('restaurant_id', params.restaurantId)
      .eq(column, value)
      .not('pending_charge_unresolved_at', 'is', null)
      .neq('payment_status', 'paid')
      .select('id')
    if (error) throw new Error(`releaseUnresolvedAttemptNotPaid: ${error.message}`)
    for (const row of data ?? []) released.add(String((row as { id: unknown }).id))
  }
  if (released.size === 0) return { released: [] }

  const intent = await findIntentByMerchantOrderNo(supabase, params.merchantOrderNo)
  if (intent && (intent.status === 'launched' || intent.status === 'uncertain')) {
    await markIntentFailed(supabase, intent.id)
  }

  const { error: auditError } = await supabase.from('audit_logs').insert(
    [...released].map((id) => ({
      restaurant_id: params.restaurantId,
      action: UNRESOLVED_ATTEMPT_RELEASED_ACTION,
      entity_type: 'order',
      entity_id: id,
      metadata: {
        source: 'terminal/verify-payment',
        evidence: 'finatic_recognised_not_paid',
        finaticStatus: params.finaticStatus,
        businessOrderNo: params.merchantOrderNo,
        terminalId: params.terminalId,
        intentId: intent?.id ?? null,
        note:
          'A card attempt reported uncertain was answered NOT PAID by the gateway (a recognised ' +
          'status, not E04111). Its expectation was released; the order is still owed and may be ' +
          'charged again.',
      },
    })),
  )
  if (auditError) console.error('[releaseUnresolvedAttemptNotPaid] audit failed', auditError)
  return { released: [...released] }
}
