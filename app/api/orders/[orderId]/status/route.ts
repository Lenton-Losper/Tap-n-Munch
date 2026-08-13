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
    .select('id, restaurant_id, status, payment_status')
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
      return NextResponse.json({ error: `Invalid status: ${nextStatus}` }, { status: 400 })
    }
    if (!isValidStaffStatusTransition(expectedCurrentStatus, nextStatus)) {
      return NextResponse.json(
        { error: `Invalid transition: ${expectedCurrentStatus} → ${nextStatus}` },
        { status: 400 },
      )
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
    patch.payment_status = paymentStatus
    if (paymentStatus === 'paid') {
      patch.paid_at = new Date().toISOString()
    }
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
  // This does not make a repeated Mark-as-Paid fail. The claim matches on the value that was
  // READ, so setting paid over paid still matches its own row; only a payment_status that
  // moved to something DIFFERENT under the caller loses, which is exactly the case worth
  // catching. `.eq` never matches NULL, so a null payment_status has to be claimed with
  // `.is` — without that branch every order with no payment_status set would 409 forever.
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
  }

  if (paymentStatus === 'paid') {
    await safeIssueReceiptForOrder(orderId, 'orders/status')
  }

  return NextResponse.json({ success: true, order: data })
}
