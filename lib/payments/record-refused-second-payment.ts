import type { createServerSupabaseClient } from '@/lib/supabase/server'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * THE ONE MOMENT WE LEARN A CARD MAY HAVE BEEN CHARGED TWICE — and until 2026-08-24 it wrote nothing.
 *
 * `markOrderPaidConfirmed` is an atomic conditional claim, so a second success callback for an
 * already-paid order cannot double-mark it: the caller gets `claimed: false, reason: 'already_paid'`
 * and the route answers 409. That protects the BOOKKEEPING.
 *
 * It does not protect the card. The reader transacts on the DEVICE, before our server is involved at
 * all, so by the time that 409 is written the money has already moved. And the branch returned
 * immediately — no audit row, no payment_event, nothing. The single instant at which the server is
 * told "a payment succeeded for an order that is already paid" produced no record of any kind.
 *
 * THE SIGNAL IS THE REFERENCE PAIR, WHICH IS WHY BOTH GO IN THE ROW.
 *
 *   same reference      a retried or duplicated callback for ONE gateway transaction. Harmless:
 *                       the device or the network repeated itself, one charge exists.
 *   DIFFERENT reference a SECOND gateway transaction against an order that was already paid.
 *                       That is a probable double charge and it is the thing worth finding.
 *
 * Putting both on the row means the distinction is readable from the audit entry alone, without
 * joining back to the order as it stood at the time — which is the join that is impossible later,
 * because the order's reference is whatever the FIRST payment wrote and never changes.
 *
 * BEST EFFORT AND NON-THROWING. The refusal is the correct outcome and must be returned to the
 * terminal whatever happens here. A logging failure must never turn a correct 409 into a 500 — that
 * would be the same inversion #329 corrected, where recording an event changed the event.
 */

/** audit_logs.action for a payment refused because the order was already paid. */
export const SECOND_PAYMENT_REFUSED_ACTION = 'payment.refused_already_paid'

export type RefusedSecondPaymentParams = {
  orderId: string
  restaurantId: string
  /** Why the claim failed. 'already_paid' is the double-charge shape; 'claim_conflict' is a race. */
  reason: 'already_paid' | 'claim_conflict'
  /** The gateway reference THIS attempt presented. */
  attemptedReference: string | null
  attemptedBusinessOrderNo: string | null
  attemptedVoucherNo?: string | null
  /** What the order already carried, written by the payment that actually landed. */
  existingReference: string | null
  existingBusinessOrderNo: string | null
  orderTotal: number | null
  amountClaimed: number | null
  terminalId: string | null
  appVersion?: string | null
  source: string
}

export async function recordRefusedSecondPayment(
  supabase: Supabase,
  params: RefusedSecondPaymentParams,
): Promise<boolean> {
  // Derived here rather than left to whoever reads the row later, so the expensive question --
  // "is this a repeat of one charge, or a second charge?" -- is answered at the moment the only
  // two references are both in hand.
  const attempted = String(params.attemptedBusinessOrderNo ?? params.attemptedReference ?? '').trim()
  const existing = String(params.existingBusinessOrderNo ?? params.existingReference ?? '').trim()
  const distinctGatewayTransaction = Boolean(attempted) && Boolean(existing) && attempted !== existing

  try {
    const { error } = await supabase.from('audit_logs').insert({
      restaurant_id: params.restaurantId,
      entity_type: 'order',
      entity_id: params.orderId,
      action: SECOND_PAYMENT_REFUSED_ACTION,
      metadata: {
        source: params.source,
        reason: params.reason,
        /**
         * THE FLAG THAT MATTERS. True means a second, DIFFERENT gateway transaction was presented
         * for an order that was already paid — a probable double charge on the customer's card,
         * which nothing in this system can undo and which a refund has to resolve.
         */
        distinctGatewayTransaction,
        attemptedReference: params.attemptedReference,
        attemptedBusinessOrderNo: params.attemptedBusinessOrderNo,
        attemptedVoucherNo: params.attemptedVoucherNo ?? null,
        existingReference: params.existingReference,
        existingBusinessOrderNo: params.existingBusinessOrderNo,
        orderTotal: params.orderTotal,
        amountClaimed: params.amountClaimed,
        terminalId: params.terminalId,
        appVersion: params.appVersion ?? null,
        note: distinctGatewayTransaction
          ? 'A SECOND gateway transaction was presented for an order already paid. The refusal is ' +
            'correct and changes no money here, but the card was very likely charged twice — the ' +
            'reader transacts on the device before this server is involved. Check the gateway and ' +
            'refund if confirmed.'
          : 'A repeated callback for the SAME gateway transaction. One charge exists; nothing to do.',
        recordedAt: new Date().toISOString(),
      },
    })
    if (error) {
      console.error(`[SECOND-PAYMENT-REFUSED] audit insert failed for order ${params.orderId}:`, error.message)
      return false
    }
  } catch (thrown) {
    console.error(
      `[SECOND-PAYMENT-REFUSED] audit insert threw for order ${params.orderId}:`,
      thrown instanceof Error ? thrown.message : String(thrown),
    )
    return false
  }

  // console.error, not log, when it is the dangerous shape: this is the only synchronous warning
  // anyone gets, and it names the order so it is actionable without a second lookup.
  if (distinctGatewayTransaction) {
    console.error(
      `[SECOND-PAYMENT-REFUSED] PROBABLE DOUBLE CHARGE order=${params.orderId} ` +
        `attempted=${attempted} existing=${existing} terminal=${params.terminalId ?? '-'} ` +
        `app=${params.appVersion ?? '-'}`,
    )
  }
  return true
}
