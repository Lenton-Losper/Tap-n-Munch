import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import {
  isValidStaffStatusTransition,
  STAFF_SETTABLE_STATUSES,
} from '@/lib/orders/status-transitions'
import { safeIssueReceiptForOrder } from '@/lib/receipts/safeIssueReceipt'
import { isEditableOrderStatus } from '@/lib/orders/edit-lock'
import {
  staffStatusRefusal,
  staffUnknownStatusRefusal,
} from '@/lib/orders/staff-status-refusal'
import { voidOutstandingOrderLines, type VoidOrderLinesResult } from '@/lib/orders/order-lines'
import { markOrderPaidManually } from '@/lib/payments/mark-order-paid-manually'
import { normalizePaymentStatus } from '@/lib/payments/payment-state-machine'

export const dynamic = 'force-dynamic'

const TIMESTAMP_FIELDS: Record<string, string> = {
  accepted: 'accepted_at',
  confirmed: 'confirmed_at',
  preparing: 'preparing_at',
  ready: 'ready_at',
  completed: 'completed_at',
  served: 'served_at',
  cancelled: 'cancelled_at',
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const supabase = createServerSupabaseClient()
  const body = await req.json().catch(() => ({}))
  const status = body?.status as string | undefined
  const paymentStatus = body?.payment_status as string | undefined
  const { orderId } = await params

  if (!status && !paymentStatus) {
    return NextResponse.json({ error: 'status or payment_status required' }, { status: 400 })
  }

  const { data: existingOrder, error: loadError } = await supabase
    .from('orders')
    // The payment columns are read so a manual payment that cannot be trailed is undone exactly.
    .select(
      'id, restaurant_id, status, payment_status, payment_method, payment_reference, paid_at, settled_charge_cents',
    )
    .eq('id', orderId)
    .maybeSingle()

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 })
  }

  if (!existingOrder?.restaurant_id) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  const auth = await requireStaffPermission(
    String(existingOrder.restaurant_id),
    PERMISSIONS.ORDERS_UPDATE,
    req,
  )
  if (isAuthError(auth)) return auth

  /**
   * payment_status IS NOT A FREE FIELD ON THIS ROUTE (Sprint 2026-09-28 brief, N1).
   *
   * It used to accept any value in the enum and write it: paid with no method, amount or trail
   * (then a receipt), paid -> pending (so the order would be charged again), cancelled -> paid.
   * Exactly two uses are legitimate, and they are the only two callers the dashboard has:
   *
   *   'cancelled' alongside status 'cancelled' -- redundant with the cancel below, kept so the
   *               hosted-checkout cancel button's body still works.
   *   'paid'      on its own -- a MANUAL PAYMENT: a method is required, the amount is the server's,
   *               and a payments row + audit row are written or the payment is undone. See
   *               lib/payments/mark-order-paid-manually.ts.
   *
   * Everything else is refused. There is no staff walk-back from paid: a refund is the reversal.
   */
  if (paymentStatus !== undefined && paymentStatus !== null && paymentStatus !== '') {
    const nextPayment = normalizePaymentStatus(paymentStatus)
    if (nextPayment === 'paid') {
      if (status) {
        return NextResponse.json(
          {
            error: 'Mark the order paid on its own, not together with a status change.',
            code: 'PAYMENT_STATUS_WITH_STATUS',
          },
          { status: 400 },
        )
      }
      const manual = await markOrderPaidManually(supabase, {
        orderId,
        restaurantId: String(existingOrder.restaurant_id),
        staffUserId: auth.userId ?? null,
        method: body?.payment_method ?? body?.paymentMethod ?? body?.method,
        currentPaymentStatus: existingOrder.payment_status,
        previous: existingOrder,
      })
      if (!manual.ok) {
        return NextResponse.json(
          { error: manual.error, code: manual.code },
          { status: manual.status },
        )
      }
      await safeIssueReceiptForOrder(orderId, 'orders/status')
      return NextResponse.json({
        success: true,
        order: manual.order,
        payment: {
          method: manual.method,
          amount_cents: manual.amountCents,
          payment_reference: manual.paymentReference,
          payment_record_written: manual.paymentRecordWritten,
        },
      })
    }
    if (nextPayment !== 'cancelled') {
      return NextResponse.json(
        {
          error: 'That payment status cannot be set by hand. A refund is the only way to reverse a payment.',
          code: 'PAYMENT_STATUS_NOT_STAFF_SETTABLE',
        },
        { status: 400 },
      )
    }
    if (status !== 'cancelled') {
      return NextResponse.json(
        {
          error: 'Cancel the order to cancel its payment.',
          code: 'PAYMENT_STATUS_NEEDS_CANCEL',
        },
        { status: 400 },
      )
    }
  }

  // Expected current status for the conditional claim — derived from the row we just
  // loaded (the same value isValidStaffStatusTransition validated against), not a
  // hardcoded from-status. Covers pending/ready_for_terminal → accepted, accepted →
  // preparing, etc., and Accept-vs-Cancel from any common non-terminal state.
  const expectedCurrentStatus = String(existingOrder.status || '')
  // Same idea for payment_status, which until now was written last-write-win (see the claim
  // block below). Kept as the raw value rather than a normalised string because the CAS has
  // to match what is actually stored, including NULL.
  const expectedCurrentPaymentStatus =
    existingOrder.payment_status == null ? null : String(existingOrder.payment_status)

  if (status) {
    const nextStatus = String(status).trim()
    if (!STAFF_SETTABLE_STATUSES.has(nextStatus)) {
      const refusal = staffUnknownStatusRefusal(nextStatus)
      return NextResponse.json({ error: refusal.message, code: refusal.code }, { status: 400 })
    }
    if (!isValidStaffStatusTransition(expectedCurrentStatus, nextStatus)) {
      // #275: the dashboard toasts `data?.error` verbatim, so this string IS the staff-facing
      // copy. It used to be two database identifiers and an arrow.
      const refusal = staffStatusRefusal(expectedCurrentStatus, nextStatus)
      return NextResponse.json({ error: refusal.message, code: refusal.code }, { status: 400 })
    }
  }

  // Same three spellings and the same "always write something" rule as the terminal status
  // route, so a cancel through either path is traceable without guessing (#103).
  const callerReason = String(
    body?.cancellation_reason ?? body?.cancellationReason ?? body?.reason ?? '',
  ).trim()
  const cancellationReason = callerReason || 'staff_cancelled'

  // `null` is in the union because clearing the edit-lock columns is a write of null, not an
  // omission — omitting them would leave a stale lock on an order the kitchen has taken.
  const patch: Record<string, string | boolean | null> = {}
  if (status) {
    patch.status = status
    const timestampField = TIMESTAMP_FIELDS[status]
    if (timestampField) {
      patch[timestampField] = new Date().toISOString()
    }
    if (status === 'cancelled') {
      patch.is_closed = true
      patch.payment_status = 'cancelled'
      patch.cancellation_reason = cancellationReason
    }
  }
  if (paymentStatus) {
    // Only 'cancelled' reaches here, alongside status 'cancelled' (see the gate above).
    patch.payment_status = paymentStatus
  }

  // STAFF WINS over an open customer edit, and this is the whole mechanism. Moving an order
  // out of the editable set nulls the edit-lock token, and the customer's commit is an UPDATE
  // conditioned on that token (app/api/guest/orders/[orderId]/edit/route.ts) — so an edit
  // already in flight matches zero rows and is refused with "the kitchen has started".
  //
  // Note the asymmetry, which is the ruling: nothing here CONSULTS the lock. A staff status
  // change is never blocked, delayed, or made to wait for a customer. The dashboard shows an
  // open edit so the staff member can choose to wait; the API does not choose for them.
  if (status && !isEditableOrderStatus(status)) {
    patch.edit_lock_token = null
    patch.edit_lock_session_id = null
    patch.edit_lock_expires_at = null
  }

  // Atomic claim when changing kitchen workflow status (R-7 Accept-vs-Decline/Cancel).
  let updateQuery = supabase
    .from('orders')
    .update(patch)
    .eq('id', orderId)
    .eq('restaurant_id', existingOrder.restaurant_id)

  if (status) {
    updateQuery = updateQuery.eq('status', expectedCurrentStatus)
  }

  // payment_status now takes the same conditional claim, closing the gap the comment that
  // used to sit here described as "a separate concern". It was last-write-win: two devices
  // reading `pending` and writing different values both succeeded, and a gateway write
  // landing between one device's read and its write was silently overwritten.
  //
  // Mark-as-Paid no longer reaches this claim -- it has its own, in markOrderPaidManually, and a
  // repeated Mark-as-Paid is now refused as ALREADY_PAID (Sprint 2026-09-28 brief, N1: a second
  // manual payment would write a second trail for money collected once). What reaches here is the
  // cancel's redundant payment_status. `.eq` never matches NULL, so a null payment_status has to
  // be claimed with `.is` — without that branch such an order could never be cancelled here.
  if (paymentStatus) {
    updateQuery =
      expectedCurrentPaymentStatus === null
        ? updateQuery.is('payment_status', null)
        : updateQuery.eq('payment_status', expectedCurrentPaymentStatus)
  }

  const { data, error } = await updateQuery
    .select('id, payment_status, paid_at, status, is_closed, cancelled_at')
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  if (!data) {
    if (status) {
      return NextResponse.json(
        { error: 'Order status changed; refresh and try again' },
        { status: 409 },
      )
    }
    if (paymentStatus) {
      return NextResponse.json(
        { error: 'Payment status changed; refresh and try again' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: 'Order not found or could not be updated' }, { status: 404 })
  }

  // Side effects only after a successful claim / update.
  let lineVoid: VoidOrderLinesResult | null = null
  if (status === 'cancelled') {
    // Mirrors the audit row handleTerminalPaymentFailed writes on cancel. Best effort: the
    // order is already cancelled, and failing the request now would tell the caller the
    // cancel did not happen when it did.
    const { error: auditError } = await supabase.from('audit_logs').insert({
      restaurant_id: existingOrder.restaurant_id,
      action: 'order.cancelled',
      entity_type: 'order',
      entity_id: orderId,
      metadata: {
        cancellation_reason: cancellationReason,
        reason_supplied_by_caller: Boolean(callerReason),
        previous_status: expectedCurrentStatus,
        staff_user_id: auth.userId,
        source: 'orders/status',
      },
    })
    if (auditError) {
      console.error('[orders/status] order.cancelled audit log failed:', auditError)
    }

    /**
     * THE KITCHEN STOPS TOO (Sprint 2026-09-28 brief). This route cancelled the ORDER and left
     * its lines outstanding, so the station boards kept showing -- and the kitchen kept cooking --
     * an order the dashboard called cancelled. The same helper every other cancel path uses,
     * with a 'system' cascade event attributed to the staff member who cancelled.
     *
     * Lines a station already finished (ready / collected) cannot be un-made and are NOT voided;
     * they are returned so the caller can say that food is still coming. Best effort, like
     * cancelOrderWithTrail's own call: the order is already cancelled, and a failed void must
     * not report the cancel as failed -- `lines_void_failed` says it instead.
     */
    try {
      lineVoid = await voidOutstandingOrderLines(supabase, {
        orderId,
        restaurantId: String(existingOrder.restaurant_id),
        actorKind: 'system',
        actorUserId: auth.userId,
      })
    } catch (voidError) {
      console.error('[orders/status] order cancelled but voiding its lines failed', voidError)
    }
  }

  if (status === 'cancelled') {
    return NextResponse.json({
      success: true,
      order: data,
      lines_voided: lineVoid ? lineVoid.voidedLineCount : null,
      // Food a station already finished: it is coming (or came) regardless of the cancel.
      lines_not_voided: lineVoid
        ? lineVoid.notVoided.map((l) => ({
            line_id: l.id,
            name: l.name,
            quantity: l.quantity,
            kitchen_state: l.kitchen_state,
            bar_state: l.bar_state,
          }))
        : null,
      lines_void_failed: lineVoid === null,
    })
  }

  return NextResponse.json({ success: true, order: data })
}
