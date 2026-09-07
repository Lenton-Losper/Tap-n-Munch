import type { createServerSupabaseClient } from '@/lib/supabase/server'
import type { PaymentIntent } from '@/lib/payments/payment-intents'
import { recordTip } from '@/lib/payments/tips'

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
  | {
      ok: true
      settledAllocationIds: string[]
      ordersClosed: string[]
      alreadySettled: boolean
      /** 'none' when the charge carried no gratuity; 'recorded', or why it was not. */
      tipRecorded: 'none' | 'recorded' | string
    }
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
    return {
      ok: true,
      settledAllocationIds,
      ordersClosed: [],
      alreadySettled: allAlreadySettled,
      // Only the closing sweep is affected; the tip is reported as not attempted rather than
      // silently 'none', so a lost gratuity cannot hide behind a re-read failure.
      tipRecorded: intent.tipCents > 0 ? 'skipped_read_failed' : 'none',
    }
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

  /**
   * ================================================================================================
   * THE GRATUITY, SPLIT BACK OUT OF THE CHARGE
   * ================================================================================================
   *
   * intent.amountCents is ONE number -- what the reader was asked for -- because that is what a
   * gateway echo is reconciled against. The allocations settled at their own amounts just above;
   * whatever was charged on top of them is the tip, and it goes to payment_tips attributed to the
   * person named before the charge.
   *
   * RECORDED HERE, IN THE SHARED WRITER, so the webhook path records it too. The device is not the
   * only caller: when a charge is proven by the gateway instead, this is the only code that runs --
   * and a tip recorded only on the device path would be silently lost exactly when nobody is
   * watching.
   *
   * A FAILED TIP DOES NOT FAIL THE SETTLEMENT. The items are paid for either way, and refusing here
   * would leave a charged customer with unsettled items over a gratuity. It is reported instead.
   */
  let tipRecorded: 'none' | 'recorded' | string = 'none'
  if (intent.tipCents > 0 && intent.tipStaffUserId) {
    try {
      const tip = await recordTip(supabase, {
        restaurantId: intent.restaurantId,
        tipCents: intent.tipCents,
        // Taken by the same instrument as the bill it rode on.
        method: 'card',
        staffUserId: intent.tipStaffUserId,
        tabId: intent.tabId,
        paymentReference,
      })
      tipRecorded = tip.recorded ? 'recorded' : tip.reason
    } catch (tipError) {
      tipRecorded = 'failed'
      console.error(`[settleAllocationsForIntent:${source}] tip write failed`, {
        intentId: intent.id,
        error: tipError instanceof Error ? tipError.message : String(tipError),
      })
    }
    if (tipRecorded !== 'recorded') {
      console.error(`[settleAllocationsForIntent:${source}] gratuity NOT recorded`, {
        intentId: intent.id,
        tipCents: intent.tipCents,
        outcome: tipRecorded,
      })
    }
  }

  return {
    ok: true,
    settledAllocationIds,
    ordersClosed,
    alreadySettled: allAlreadySettled,
    tipRecorded,
  }
}
