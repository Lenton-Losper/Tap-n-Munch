import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import {
  isValidStaffStatusTransition,
  STAFF_SETTABLE_STATUSES,
} from '@/lib/orders/status-transitions'
import { safeIssueReceiptForOrder } from '@/lib/receipts/safeIssueReceipt'

export const dynamic = 'force-dynamic'

/**
 * Cap on the free-text cancellation reason (#103). It was written unbounded to two places at
 * once -- orders.cancellation_reason and the order.cancelled audit row's metadata -- so a
 * 10,000-character reason was stored twice in full.
 *
 * 280 matches MAX_INSTRUCTIONS_LENGTH, the cap this codebase already settled on for order
 * free-text: long enough for a real explanation ("customer left before the food was up, comped by
 * the duty manager") and short enough to stay readable on a staff order card and a 32-column
 * thermal print, which is where both of these fields end up being read.
 */
const MAX_CANCELLATION_REASON_LENGTH = 280

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
    .select('id, restaurant_id, status')
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
  //
  // A non-string reason is normalised away rather than rejected. String(...) used to coerce
  // whatever arrived: `{a:1}` was stored as the literal "[object Object]", `['a','b']` as "a,b",
  // `42` as "42". None of those is a reason, and the first actively misleads whoever reads the
  // order history later. Returning 400 instead would change this route's effect on order state --
  // a request that cancels the order today would stop cancelling it -- so an unusable reason
  // falls back to the same default an absent one already used, and reason_supplied_by_caller
  // (below) records honestly that nothing usable came from the caller.
  const rawReason = body?.cancellation_reason ?? body?.cancellationReason ?? body?.reason
  const callerReason =
    typeof rawReason === 'string'
      ? rawReason.trim().slice(0, MAX_CANCELLATION_REASON_LENGTH).trim()
      : ''
  const cancellationReason = callerReason || 'staff_cancelled'

  const patch: Record<string, string | boolean> = {}
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

  // Atomic claim when changing kitchen workflow status (R-7 Accept-vs-Decline/Cancel).
  // payment_status-only patches (e.g. Mark as Paid) do not use this status claim —
  // that path is a separate concern (receipt issuance is already idempotent; terminal /
  // webhook paid writes use their own guards).
  let updateQuery = supabase
    .from('orders')
    .update(patch)
    .eq('id', orderId)
    .eq('restaurant_id', existingOrder.restaurant_id)

  if (status) {
    updateQuery = updateQuery.eq('status', expectedCurrentStatus)
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
