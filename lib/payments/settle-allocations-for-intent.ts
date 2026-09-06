import type { createServerSupabaseClient } from '@/lib/supabase/server'
import type { PaymentIntent } from '@/lib/payments/payment-intents'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * SETTLE THE ITEMS A PROVEN CARD CHARGE PAID FOR.
 *
 * ================================================================================================
 * ONE WRITER, TWO CALLERS
 * ================================================================================================
 *
 * A part-order card charge can be proven in two places, and they race:
 *
 *   the device      POST .../record-split-payment, when the reader answers
 *   the gateway     POST /api/webhooks/paycloud, which may arrive first, later, or instead
 *
 * Both call THIS, so there is exactly one piece of code that marks a split-paid allocation paid.
 * Two implementations of "settle these items" would drift, and the one nobody watches — the
 * webhook — would be the one that drifted.
 *
 * ================================================================================================
 * IT IS SAFE TO CALL TWICE
 * ================================================================================================
 *
 * `settle_order_line_allocations` claims each allocation and REFUSES one already settled, so the
 * second caller applies nothing and reports what the first one did. That is what makes the race
 * harmless rather than a double settlement: the ledger row is written once, by whoever got there
 * first, and the loser is told so.
 *
 * ================================================================================================
 * WHAT IT DOES NOT DO
 * ================================================================================================
 *
 * IT DOES NOT TOUCH THE INTENT. Callers resolve their own intent, because what a failure MEANS
 * differs: the device leaves it unresolved so the webhook can still settle, while the webhook has
 * nothing after it. Moving the status here would force one answer on both.
 *
 * IT DOES NOT CHARGE ANYTHING. The money moved before this was called, in both paths.
 */

export type SettleForIntentResult =
  | { ok: true; settledAllocationIds: string[]; ordersClosed: string[]; alreadySettled: boolean }
  | { ok: false; reason: string }

export async function settleAllocationsForIntent(
  supabase: Supabase,
  params: {
    intent: PaymentIntent
    /** The gateway reference. Ties every ledger row of this settlement together. */
    paymentReference: string
    transactionId?: string | null
    source: string
  },
): Promise<SettleForIntentResult> {
  const { intent, paymentReference, source } = params

  if (intent.scope !== 'allocations' || intent.allocationIds.length === 0) {
    return { ok: false, reason: 'intent names no allocations' }
  }

  const { data: rpcData, error: rpcError } = await supabase.rpc('settle_order_line_allocations', {
    p_restaurant_id: intent.restaurantId,
    p_tab_id: intent.tabId,
    p_allocation_ids: intent.allocationIds,
    p_method: 'card',
    p_payment_reference: paymentReference,
    /**
     * NULL, and deliberately so. On the cash path this column names the person whose PIN was
     * verified. A card charge has no such person: the customer authorised it at the reader. Writing
     * the waiter here would put a name on an append-only ledger row that nobody can retract, saying
     * they took money they did not handle.
     */
    p_staff_user_id: null,
  })

  if (rpcError) {
    console.error(`[settleAllocationsForIntent:${source}] RPC failed`, {
      intentId: intent.id,
      error: rpcError.message,
    })
    return { ok: false, reason: `rpc: ${rpcError.message}` }
  }

  const result = (rpcData ?? { applied: [], refused: [] }) as {
    applied: Array<{ allocation_id: string; amount_cents: number }>
    refused: Array<{ allocation_id: string; reason: string }>
  }

  const settledAllocationIds = result.applied.map((a) => String(a.allocation_id))

  /**
   * NOTHING APPLIED IS NOT NECESSARILY A FAILURE.
   *
   * When both callers race, the loser applies nothing because every allocation was already
   * claimed. That is success — the items ARE paid — and reporting it as a failure would make the
   * device tell a waiter the charge did not land.
   *
   * It IS a failure when the allocations were refused for some other reason, which is why the
   * refusal reasons are inspected rather than assumed.
   */
  const allAlreadySettled =
    settledAllocationIds.length === 0 &&
    result.refused.length > 0 &&
    result.refused.every((r) => String(r.reason).includes('settled'))

  if (settledAllocationIds.length === 0 && !allAlreadySettled) {
    console.error(`[settleAllocationsForIntent:${source}] nothing settled`, {
      intentId: intent.id,
      refused: result.refused,
    })
    return { ok: false, reason: 'nothing settled' }
  }

  /**
   * CLOSE ONLY THE ORDERS THAT ARE NOW FULLY PAID.
   *
   * `order_is_fully_paid_by_allocations` is a SQL-level integer-cent predicate and is the sole
   * authority on this — the same one the cash path uses. It is what makes "customer four keeps
   * ordering after the first three have paid" work: the order simply never becomes fully paid, and
   * nothing tries to close it.
   *
   * A FAILED CHECK SKIPS THE ORDER RATHER THAN CLOSING IT. Not knowing whether an order is fully
   * paid is not permission to mark it paid.
   */
  const { data: appliedRows, error: appliedRowsError } = await supabase
    .from('order_line_allocations')
    .select('id, order_id')
    .in('id', intent.allocationIds)

  if (appliedRowsError) {
    // The money IS recorded — the ledger write succeeded. Only the closing sweep is affected, and
    // the next settlement on the tab performs it.
    console.error(`[settleAllocationsForIntent:${source}] could not re-read allocations to close orders`, {
      intentId: intent.id,
      error: appliedRowsError.message,
    })
    return { ok: true, settledAllocationIds, ordersClosed: [], alreadySettled: allAlreadySettled }
  }

  const orderIds = [...new Set((appliedRows ?? []).map((r) => String(r.order_id)))]
  const ordersClosed: string[] = []

  for (const orderId of orderIds) {
    const { data: fullyPaid, error: fullyPaidError } = await supabase.rpc(
      'order_is_fully_paid_by_allocations',
      { p_order_id: orderId },
    )
    if (fullyPaidError) {
      console.error(`[settleAllocationsForIntent:${source}] fully-paid check failed`, {
        orderId,
        error: fullyPaidError.message,
      })
      continue
    }
    if (fullyPaid !== true) continue

    const paidAt = new Date().toISOString()
    const { data: claimed, error: claimError } = await supabase
      .from('orders')
      .update({
        payment_status: 'paid',
        payment_method: 'card',
        payment_reference: paymentReference,
        status: 'completed',
        paid_at: paidAt,
        completed_at: paidAt,
      })
      .eq('id', orderId)
      .eq('restaurant_id', intent.restaurantId)
      // Guarded so a second settlement on an already-completed order is a no-op, not a re-write.
      .not('payment_status', 'eq', 'paid')
      .select('id')

    if (claimError) {
      console.error(`[settleAllocationsForIntent:${source}] order completion write failed`, {
        orderId,
        error: claimError.message,
      })
      continue
    }
    if ((claimed ?? []).length > 0) ordersClosed.push(orderId)
  }

  return { ok: true, settledAllocationIds, ordersClosed, alreadySettled: allAlreadySettled }
}
