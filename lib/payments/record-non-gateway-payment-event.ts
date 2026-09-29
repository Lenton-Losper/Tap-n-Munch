/**
 * THE NON-GATEWAY LEDGER ROW (Sprint 2026-09-29 brief, 20260929100000).
 *
 * One immutable `non_gateway_payment_events` row per successful payment FlashTap did not see a
 * gateway confirm: cash or PayToday on the terminal, a standalone card machine, a staff member's
 * Mark-as-Paid. The complement of `payment_events`, which stays gateway-only so that none of its
 * readers (receipts, reconciliation, duplicate-charge detection, the missing-sale-row report, the
 * refund projection) can mistake a cash payment for a gateway transaction. See the migration header
 * for the reader-by-reader reasoning.
 *
 * Mark-as-Paid writes its row inside record_manual_order_payment(); this is the writer for the
 * terminal routes, which claim through PostgREST.
 *
 * NEVER THROWS. Callers decide what a failure means -- the whole-tab settle undoes its claim; a
 * split settle, whose allocation ledger rows are already committed, reports it -- so the outcome is
 * returned rather than thrown into a route's outer catch.
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import type { SettlementPaymentMethod } from '@/lib/payments/payment-integrity'

type Supabase = ReturnType<typeof createServerSupabaseClient>

export type NonGatewayOrigin =
  | 'staff_mark_paid'
  | 'terminal_tab_settle'
  | 'terminal_allocation_settle'
  | 'terminal_order_payment'

export type NonGatewayActorAttribution = 'staff_session' | 'staff_authorized' | 'terminal_only'

export type RecordNonGatewayResult =
  | { recorded: true; eventId: string | null; duplicate: boolean }
  | { recorded: false; error: string }

export async function recordNonGatewayPaymentEvent(
  supabase: Supabase,
  params: {
    restaurantId: string
    origin: NonGatewayOrigin
    method: SettlementPaymentMethod
    /** THE SERVER'S bill for what was paid, integer cents, gratuity excluded. */
    billCents: number
    /** The gratuity collected with it, integer cents. 0 for none. */
    tipCents?: number
    orderIds: string[]
    tabId?: string | null
    allocationIds?: string[] | null
    paymentReference: string
    /** Unique per restaurant: one collection event, one row. */
    idempotencyKey: string
    recordedBy: string | null
    actorAttribution: NonGatewayActorAttribution
    terminalId?: string | null
    source: string
  },
): Promise<RecordNonGatewayResult> {
  const billCents = Math.round(Number(params.billCents))
  const tipCents = Math.max(0, Math.round(Number(params.tipCents ?? 0)))
  const orderIds = [...new Set(params.orderIds.map((id) => String(id).trim()).filter(Boolean))]
  if (!Number.isFinite(billCents) || billCents <= 0) {
    return { recorded: false, error: 'bill must be a positive number of cents' }
  }
  if (orderIds.length === 0) return { recorded: false, error: 'no orders named' }

  let error: { code?: string; message?: string } | null = null
  let eventId: string | null = null
  try {
    const res = await supabase
      .from('non_gateway_payment_events')
      .insert({
        restaurant_id: params.restaurantId,
        origin: params.origin,
        method: params.method,
        // What was collected, gratuity included -- the meaning payment_events.amount has too.
        amount_cents: billCents + tipCents,
        tip_cents: tipCents,
        currency: 'NAD',
        order_ids: orderIds,
        tab_id: params.tabId ?? null,
        allocation_ids: params.allocationIds && params.allocationIds.length > 0 ? params.allocationIds : null,
        payment_reference: params.paymentReference,
        idempotency_key: params.idempotencyKey,
        recorded_by: params.recordedBy,
        actor_attribution: params.actorAttribution,
        terminal_id: params.terminalId ?? null,
        source: params.source,
      })
      .select('id')
      .maybeSingle()
    error = res.error
    eventId = res.data?.id ? String(res.data.id) : null
  } catch (thrown) {
    error = { message: thrown instanceof Error ? thrown.message : String(thrown) }
  }

  if (!error) return { recorded: true, eventId, duplicate: false }
  // The key already holds this event: a retry of the same collection, recorded once.
  if (error.code === '23505') return { recorded: true, eventId: null, duplicate: true }
  console.error(`[recordNonGatewayPaymentEvent:${params.source}] ledger insert failed`, {
    restaurantId: params.restaurantId,
    orderIds,
    paymentReference: params.paymentReference,
    error: error.message,
  })
  return { recorded: false, error: String(error.message ?? 'insert failed') }
}
