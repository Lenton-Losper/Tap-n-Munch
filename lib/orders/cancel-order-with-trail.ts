type Supabase = {
  from: (table: string) => any
}

/**
 * audit_logs.action for a cancelled order.
 *
 * ONE action for every cancel path — the dashboard, the terminal, the stale-order cron and the
 * one-off operator scripts all write this. Measured 2026-08-22: 95 of 272 cancelled orders on
 * production carry no audit row at all, and the reason the gap went unnoticed for so long is that
 * "has this order been cancelled, and by what" required knowing which of several writers to ask.
 * One action means one query.
 */
export const ORDER_CANCELLED_ACTION = 'order.cancelled'

/** Which writer decided. Recorded in the audit row; never written to the order. */
export type CancelBasis =
  | 'no_gateway_reference'
  | 'finatic_verified_not_paid'
  | 'terminal_pre_gateway'
  | 'operator_duplicate_ruling'
  | 'e04111_no_attempt_reached_gateway'

export const CANCEL_BASIS_NOTE: Record<CancelBasis, string> = {
  no_gateway_reference:
    'No paycloud_merchant_order_no was ever allocated, so prepare-payment never ran and no charge ' +
    'is possible. Cancelled without a gateway call, which is why none was recorded.',
  finatic_verified_not_paid:
    'Finatic was queried directly and returned a RECOGNISED not-paid status before this cancel. ' +
    'An unrecognised status does not reach here -- it is skipped, per the 2026-08-05 ruling.',
  terminal_pre_gateway:
    'The operator cancelled at the terminal before any gateway attempt existed for this order, so ' +
    'there was nothing to query and no charge is possible.',
  operator_duplicate_ruling:
    'A HUMAN RULED THIS A DUPLICATE. Not an automated decision and not a gateway finding -- the ' +
    'venue reported that one payment was taken and rung up twice, and the owner ruled on that ' +
    'report. The money WAS collected; what is being corrected is a second record of it. ' +
    'Deliberately distinct from `no_gateway_reference`, which asserts NO CHARGE IS POSSIBLE -- ' +
    'true of a card that never reached prepare-payment, and false here, where cash changed hands. ' +
    'Recording this cancel under that basis would put a false statement in the audit trail.',
  e04111_no_attempt_reached_gateway:
    'NO PAYMENT EVER REACHED THE GATEWAY. Established by a CONJUNCTION, and the two halves are ' +
    'not interchangeable: (a) the order carries neither payment_reference nor payment_voucher_no, ' +
    'and (b) a live Finatic order.query on its own merchant order number answered E04111 ' +
    '"Merchant order number is invalid" in the same run as this cancel. ' +
    'WHY BOTH ARE REQUIRED, measured on production 2026-08-25: three FNB ChowNow orders ' +
    '(#456, #500, #546) are PAID and carry neither marker, and the gateway returns PAID for all ' +
    'three. So (a) alone would have cancelled N$201 of real charges; (b) is the load-bearing half. ' +
    'DISTINCT FROM `finatic_verified_not_paid`, which asserts a RECOGNISED not-paid status. ' +
    'E04111 is an error, not a status -- it means the gateway has no such order, which is the ' +
    'expected answer when staff cancelled on the reader before anything was sent. It is the ' +
    '#327 `left_pending_finatic_uncertain` reading, and on its own it never authorises a cancel.',
}

export type CancelWithTrailResult = {
  /** The updated row, or null when the UPDATE matched nothing (lost the race, or wrong scope). */
  order: Record<string, unknown> | null
  cancelled: boolean
}

/**
 * CANCEL AN ORDER AND RECORD THAT IT HAPPENED — as one call, so neither half can be forgotten.
 *
 * WHY THIS EXISTS RATHER THAN AN INSERT AT EACH CALL SITE. Every untracked cancellation measured on
 * production came from a writer that did the UPDATE and simply did not do the INSERT: the terminal
 * status route between 2026-06-23 and 2026-07-28 (which is how #456/#500/#546 lost their trail
 * entirely), the stale-order cron's `auto_timeout` (90 rows), and this route's pre-gateway branch
 * (Riviera #7). Not one of those was a decision -- each was an omission. An omission is not fixed by
 * adding another insert somewhere; it is fixed by making the omission unexpressible.
 *
 * THE UPDATE RE-ASSERTS `payment_status = 'pending'`, so a terminal callback that settles the order
 * concurrently WINS and this returns `cancelled: false` rather than blind-overwriting a payment.
 *
 * A FAILED AUDIT INSERT THROWS. The order is already cancelled by then and throwing cannot undo it,
 * but a cancellation that went unrecorded is exactly the defect this exists to prevent, so it must
 * not pass quietly.
 */
export async function cancelOrderWithTrail(
  supabase: Supabase,
  params: {
    orderId: string
    restaurantId: string
    cancellationReason: string
    basis: CancelBasis
    /**
     * REQUIRED, and deliberately not defaulted.
     *
     * 'require_pending' re-asserts payment_status='pending' in the UPDATE, so a terminal callback
     * that settles the order concurrently WINS and this returns cancelled:false instead of
     * blind-overwriting a payment. That is what the stale-order cron has always done.
     *
     * 'none' cancels whatever the current payment_status is. The terminal pre-gateway branch has
     * always behaved this way, and an order there can legitimately sit at 'cash_pending' rather
     * than 'pending' -- so silently defaulting to the stricter guard would stop cancelling orders
     * that cancel today. Tightening it is a behaviour change and needs its own ruling.
     *
     * No default, because picking one for a caller is how the omissions this module exists to
     * prevent get reintroduced one layer up.
     */
    guard: 'require_pending' | 'none'
    /** Merged into the audit row's metadata. Never written to the order. */
    metadata?: Record<string, unknown>
  },
): Promise<CancelWithTrailResult> {
  const cancelledAt = new Date().toISOString()

  let query = supabase
    .from('orders')
    .update({
      status: 'cancelled',
      payment_status: 'cancelled',
      cancelled_at: cancelledAt,
      cancellation_reason: params.cancellationReason,
    })
    .eq('id', params.orderId)
    .eq('restaurant_id', params.restaurantId)
  if (params.guard === 'require_pending') query = query.eq('payment_status', 'pending')
  const { data, error } = await query.select()

  if (error) throw error

  const rows = (data ?? []) as Record<string, unknown>[]
  // Nothing was cancelled, so there is nothing to record. Recording it anyway would put a
  // cancellation in the log that never happened, which is its own kind of wrong trail.
  if (rows.length === 0) return { order: null, cancelled: false }

  const order = rows[0]
  const { error: auditError } = await supabase.from('audit_logs').insert({
    restaurant_id: params.restaurantId,
    entity_type: 'order',
    entity_id: params.orderId,
    action: ORDER_CANCELLED_ACTION,
    metadata: {
      basis: params.basis,
      basisNote: CANCEL_BASIS_NOTE[params.basis],
      cancellationReason: params.cancellationReason,
      cancelledAt,
      orderTotal: order.total ?? null,
      businessOrderNo: order.paycloud_merchant_order_no ?? null,
      ...(params.metadata ?? {}),
    },
  })
  if (auditError) throw new Error(`cancelOrderWithTrail audit: ${auditError.message}`)

  return { order, cancelled: true }
}
