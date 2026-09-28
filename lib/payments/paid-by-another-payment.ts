/**
 * IS THIS ALREADY-PAID ORDER PAID BY *THIS* CHARGE, OR BY ANOTHER PAYMENT? (Sprint 2026-09-28, N3)
 *
 * Every gateway confirmation path treats an already-paid order as a harmless duplicate: the
 * settlement RPC CONTINUEs past it, and the webhook ACKs outright when every order it resolved is
 * paid. That is right for a replay of the same charge. It is silent and wrong for the race it
 * cannot tell apart from one:
 *
 *   terminal A prepares X+Y and launches the reader; terminal B takes cash for Y; A's card is
 *   charged X+Y. Y is now paid twice and nothing anywhere says so.
 *
 * THE RULE, stated once here and once in SQL (20260928160000_settle_refuses_order_paid_elsewhere,
 * block 6c) -- the two are asserted on the same cases (supabase/tests/settlement-rpc.test.sql
 * `_t_paid_elsewhere`, __tests__/paid-by-another-payment.test.ts). A paid row is paid ELSEWHERE when:
 *
 *   - it was paid by a different METHOD than this charge (cash / paytoday vs card), or
 *   - it carries a DIFFERENT gateway reference (paycloud_merchant_order_no), or
 *   - its payment_reference is neither this charge's reference nor the settlement reference of a
 *     paid row in the same set that carries this charge's merchant order number and was paid by
 *     this method. That last clause is the device's own tab-settle card claim: one generated
 *     reference across the tab, the merchant order number on the lead only.
 *
 * A row with none of those set (legacy: no method, no references) is NOT reported -- there is
 * nothing to prove it was another payment, and a false alarm on a money trail is its own defect.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { SECOND_PAYMENT_REFUSED_ACTION } from '@/lib/payments/record-refused-second-payment'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type PaidRowEvidence = {
  id: unknown
  payment_status: unknown
  payment_method?: unknown
  payment_reference?: unknown
  paycloud_merchant_order_no?: unknown
}

const text = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim()
  return s ? s : null
}
const isPaid = (row: PaidRowEvidence) => String(row.payment_status ?? '').trim().toLowerCase() === 'paid'

/**
 * The rows in `rows` that are paid by a payment OTHER than the charge `reference` / `method`.
 * `rows` should be the whole set the charge covered: the lead is what identifies a tab-settle
 * sibling as this charge.
 */
export function paidByAnotherPayment<T extends PaidRowEvidence>(
  rows: readonly T[],
  charge: { reference: string; method: 'card' | 'cash' | 'paytoday' },
): T[] {
  const reference = charge.reference.trim()
  const method = charge.method
  const ours = new Set<string>([reference])
  for (const row of rows) {
    if (!isPaid(row)) continue
    const rowMethod = text(row.payment_method)?.toLowerCase() ?? null
    const ref = text(row.payment_reference)
    if (text(row.paycloud_merchant_order_no) === reference && (rowMethod === null || rowMethod === method) && ref) {
      ours.add(ref)
    }
  }
  return rows.filter((row) => {
    if (!isPaid(row)) return false
    const rowMethod = text(row.payment_method)?.toLowerCase() ?? null
    const merchantNo = text(row.paycloud_merchant_order_no)
    const ref = text(row.payment_reference)
    return (
      (rowMethod !== null && rowMethod !== method) ||
      (merchantNo !== null && merchantNo !== reference) ||
      (ref !== null && !ours.has(ref))
    )
  })
}

/**
 * The webhook's "every order is already paid" acknowledgement, made to leave evidence.
 *
 * The ACK itself is unchanged -- a retry cannot un-pay anything -- but when the orders were paid by
 * ANOTHER payment the charge just confirmed is a probable double charge, and before this the only
 * record of it was the gateway's. One `payment.refused_already_paid` row per such order, keyed the
 * same way the settlement RPC writes them, and written once per (order, charge).
 *
 * NEVER THROWS. This runs on the path that answers the gateway; a logging failure must not turn an
 * ACK into a 500 and a retry storm.
 */
export async function recordOrdersPaidByAnotherPayment(
  supabase: Supabase,
  params: {
    orderIds: readonly string[]
    reference: string
    source: string
    /** False on the signature-failed leg, where nothing has yet confirmed the charge happened. */
    gatewayConfirmed: boolean
  },
): Promise<{ recorded: string[] }> {
  const recorded: string[] = []
  try {
    if (!params.orderIds.length || !params.reference.trim()) return { recorded }
    const { data, error } = await supabase
      .from('orders')
      .select(
        'id, restaurant_id, payment_status, payment_method, payment_reference, ' +
          'paycloud_merchant_order_no, total, pending_charge_cents',
      )
      .in('id', [...params.orderIds])
    if (error || !data) {
      console.error('[paid-by-another-payment] could not read the orders', error?.message)
      return { recorded }
    }
    const rows = data as unknown as Array<PaidRowEvidence & Record<string, unknown>>
    const elsewhere = paidByAnotherPayment(rows, { reference: params.reference, method: 'card' })
    for (const row of elsewhere) {
      const orderId = String(row.id)
      const { data: existing } = await supabase
        .from('audit_logs')
        .select('id')
        .eq('action', SECOND_PAYMENT_REFUSED_ACTION)
        .eq('entity_id', orderId)
        .eq('metadata->>attemptedReference', params.reference)
        .limit(1)
      if (Array.isArray(existing) && existing.length > 0) continue

      const { error: insertError } = await supabase.from('audit_logs').insert({
        restaurant_id: row.restaurant_id,
        action: SECOND_PAYMENT_REFUSED_ACTION,
        entity_type: 'order',
        entity_id: orderId,
        metadata: {
          source: params.source,
          reason: 'paid_by_other_payment',
          distinctGatewayTransaction: true,
          gatewayConfirmed: params.gatewayConfirmed,
          attemptedReference: params.reference,
          attemptedBusinessOrderNo: params.reference,
          attemptedMethod: 'card',
          existingReference: text(row.payment_reference),
          existingBusinessOrderNo: text(row.paycloud_merchant_order_no),
          existingMethod: text(row.payment_method),
          orderChargeCents:
            row.pending_charge_cents != null
              ? Number(row.pending_charge_cents)
              : Math.round(Number(row.total ?? 0) * 100),
          note:
            'A card charge was confirmed for an order that had already been paid by another ' +
            'payment. Nothing was applied. The customer was very likely charged twice for this ' +
            'order -- check the gateway and refund.',
          recordedAt: new Date().toISOString(),
        },
      })
      if (insertError) {
        console.error('[paid-by-another-payment] audit insert failed', orderId, insertError.message)
        continue
      }
      recorded.push(orderId)
      console.error(
        `[SECOND-PAYMENT-REFUSED] PROBABLE DOUBLE CHARGE order=${orderId} attempted=${params.reference} ` +
          `existing=${text(row.payment_reference) ?? '-'} method=${text(row.payment_method) ?? '-'}`,
      )
    }
  } catch (thrown) {
    console.error(
      '[paid-by-another-payment] threw',
      thrown instanceof Error ? thrown.message : String(thrown),
    )
  }
  return { recorded }
}
