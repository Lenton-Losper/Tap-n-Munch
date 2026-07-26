import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { calculateOrderPricing, UnmatchedMenuItemError } from '@/lib/orders/calculate-order-pricing'

export const dynamic = 'force-dynamic'

/**
 * Saves staff edits to a waiting-review request as items_reviewed/*_reviewed, recalculated
 * via the same calculateOrderPricing used everywhere else -- never hand-entered totals.
 * The original items/subtotal/total columns are never touched (audit trail of what the
 * customer actually submitted).
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params
  const body = await req.json().catch(() => ({}))
  const items = body?.items

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items is required and must be non-empty' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()

  const { data: request, error: loadError } = await supabase
    .from('order_requests')
    .select('id, restaurant_id, status')
    .eq('id', requestId)
    .maybeSingle()

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 })
  }
  if (!request) {
    return NextResponse.json({ error: 'Order request not found' }, { status: 404 })
  }

  const auth = await requireStaffPermission(String(request.restaurant_id), PERMISSIONS.ORDERS_UPDATE, req)
  if (isAuthError(auth)) return auth

  if (request.status !== 'waiting_review') {
    return NextResponse.json(
      { error: `Cannot edit a request with status "${request.status}"` },
      { status: 400 },
    )
  }

  let pricing
  try {
    pricing = await calculateOrderPricing(supabase, request.restaurant_id, items)
  } catch (err) {
    if (err instanceof UnmatchedMenuItemError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    throw err
  }

  const { data: updated, error: updateError } = await supabase
    .from('order_requests')
    .update({
      items_reviewed: pricing.items,
      subtotal_reviewed: pricing.subtotal,
      tax_reviewed: pricing.tax,
      total_reviewed: pricing.total,
    })
    .eq('id', requestId)
    .select('id, items_reviewed, subtotal_reviewed, tax_reviewed, total_reviewed')
    .single()

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, request: updated })
}
