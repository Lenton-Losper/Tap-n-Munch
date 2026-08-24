/**
 * #329 — ONE ACTION FOR EVERY payment_status TRANSITION THAT IS NOT ALREADY TRAILED ELSEWHERE.
 *
 * THE RULING, 2026-08-24: trail them all, even the ones where no money moves. The point of #329 is
 * not that N$201 went missing — it is that three orders could not be RECONSTRUCTED. `terminal_pending`,
 * `cash_pending` and `failed` move no money, but an order that ends up somewhere inexplicable
 * usually got there through one of them, and a gap in the middle of a sequence is as fatal to an
 * investigation as a gap at the end.
 *
 * WHY A HELPER RATHER THAN FOUR INSERTS. The terminal outcomes are trailed because
 * `cancelOrderWithTrail` and `markOrderPaidConfirmed` made it impossible to write the status without
 * writing the row. Four hand-rolled inserts would be four chances to forget a field, and the first
 * one to drift becomes the next unanswerable question. `from` and `to` are required arguments, so a
 * caller cannot record that something changed without saying what it changed from.
 *
 * DELIBERATELY SEPARATE FROM `order.cancelled`. That action means an order reached a terminal
 * outcome; this one means it moved between working states. Collapsing them would make
 * "was this order cancelled" a question about metadata again, which is what
 * ORDER_CANCELLED_ACTION exists to prevent.
 *
 * BEST EFFORT, ALWAYS. The status change has already been written by the time this runs. Throwing
 * here would report a failure for work that happened — the exact inversion that makes logs
 * untrustworthy. It returns whether it succeeded so a caller that wants to count gaps can.
 */

type Supabase = { from: (table: string) => any }

/** audit_logs.action for a non-terminal payment_status transition. */
export const PAYMENT_STATUS_CHANGED_ACTION = 'payment_status.changed'

export type PaymentStatusChangeSource =
  | 'payments/push-to-terminal'
  | 'payments/push-to-terminal:release'
  | 'payments/cancel-terminal'
  | 'orders:prepare-payment-failed'

export async function recordPaymentStatusChange(
  supabase: Supabase,
  params: {
    orderId: string
    restaurantId: string
    /** What it was. Required: "it changed" is not a trail. */
    from: string | null
    /** What it became. */
    to: string
    source: PaymentStatusChangeSource
    /** Why, in words, for whoever reads this months later with no context. */
    note: string
    metadata?: Record<string, unknown>
  },
): Promise<boolean> {
  // TRY/CATCH, NOT JUST THE RETURNED error. The first version only handled `{ error }` coming back,
  // which is not the same as being safe: if the insert THROWS -- a client that cannot reach the
  // database, or one whose shape does not have `.from('audit_logs').insert` -- the exception
  // propagates into the caller and fails the payment operation itself.
  //
  // That is exactly backwards. This function exists to RECORD what happened; it must never be able
  // to change what happens. A push to a card terminal must not 500 because an audit row could not
  // be written.
  //
  // Caught immediately: adding this call turned two partially-red suites fully red (1 of 5 failing
  // became 5 of 5, 2 of 6 became 6 of 6) because their fake client does not implement audit_logs.
  // A test double is a client whose shape differs from the real one, which is the same failure a
  // real client has when it is misconfigured.
  try {
    const { error } = await supabase.from('audit_logs').insert({
      restaurant_id: params.restaurantId,
      entity_type: 'order',
      entity_id: params.orderId,
      action: PAYMENT_STATUS_CHANGED_ACTION,
      metadata: {
        from: params.from,
        to: params.to,
        source: params.source,
        note: params.note,
        changedAt: new Date().toISOString(),
        ...(params.metadata ?? {}),
      },
    })

    if (error) {
      console.error(
        `[PAYMENT-STATUS-TRAIL] failed for order ${params.orderId} (${params.from} -> ${params.to}):`,
        error.message,
      )
      return false
    }
    return true
  } catch (thrown) {
    console.error(
      `[PAYMENT-STATUS-TRAIL] threw for order ${params.orderId} (${params.from} -> ${params.to}):`,
      thrown instanceof Error ? thrown.message : String(thrown),
    )
    return false
  }
}
