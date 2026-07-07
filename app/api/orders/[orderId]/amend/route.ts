import { NextResponse } from 'next/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { amendOrder } from '@/lib/orders/amend-order'
import { PERMISSIONS } from '@/lib/permissions'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params
  const trimmedOrderId = String(orderId || '').trim()

  if (!trimmedOrderId) {
    return NextResponse.json({ error: 'orderId is required' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()
  const { data: existingOrder, error: loadError } = await supabase
    .from('orders')
    .select('id, restaurant_id')
    .eq('id', trimmedOrderId)
    .maybeSingle()

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 })
  }

  if (!existingOrder?.restaurant_id) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  const auth = await requireStaffPermission(
    String(existingOrder.restaurant_id),
    PERMISSIONS.ORDERS_AMEND,
    req,
  )
  if (isAuthError(auth)) return auth

  const body = await req.json().catch(() => null)
  const changes = body?.changes
  const reason = body?.reason

  if (!Array.isArray(changes) || changes.length === 0) {
    return NextResponse.json({ error: 'changes must be a non-empty array' }, { status: 400 })
  }

  try {
    const result = await amendOrder(auth.supabase, auth.userId, {
      orderId: trimmedOrderId,
      changes,
      reason,
    })

    return NextResponse.json({
      success: true,
      revision_id: result.revisionId,
      revision_number: result.revisionNumber,
      financial_delta: result.financialDelta,
      changes: result.changes,
      order: result.order,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to amend order'
    const status =
      message === 'Order not found'
        ? 404
        : message.includes('only allowed on paid orders') ||
            message.includes('Cannot amend') ||
            message.includes('not found') ||
            message.includes('required') ||
            message.includes('invalid')
          ? 400
          : 500

    return NextResponse.json({ error: message }, { status })
  }
}
