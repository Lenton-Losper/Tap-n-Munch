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
  if (paymentStatus === 'paid') {
    await safeIssueReceiptForOrder(orderId, 'orders/status')
  }

  return NextResponse.json({ success: true, order: data })
}
