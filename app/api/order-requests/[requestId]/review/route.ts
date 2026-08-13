import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { calculateOrderPricing, UnmatchedMenuItemError } from '@/lib/orders/calculate-order-pricing'

export const dynamic = 'force-dynamic'

/**
 * Why an edit was refused, in words a staff member can act on.
 *
 * 'accepting' is the transient state Accept claims before it creates the order and the
 * Finatic checkout session, so an edit arriving then would be repricing a payment that is
 * already being set up. Refuse it outright rather than folding the change in.
 */
function statusRejectionMessage(status: string): string {
  switch (status) {
    case 'accepting':
      return 'Payment is in progress for this order — it can\'t be modified right now. Wait for it to finish, then amend the order if you still need to.'
    case 'accepted':
      return 'This order has already been accepted and can no longer be edited here.'
    case 'declined':
      return 'This order was declined and can no longer be edited.'
    default:
      return `This order can no longer be edited (status: ${status}).`
  }
}

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
      { error: statusRejectionMessage(String(request.status)) },
      { status: request.status === 'accepting' ? 409 : 400 },
    )
  }

  let pricing
  try {
    pricing = await calculateOrderPricing(supabase, request.restaurant_id, items)
  } catch (err) {
    if (err instanceof UnmatchedMenuItemError) {
      return NextResponse.json(
        { error: err.message, code: err.code, unavailableItems: err.items },
        { status: 400 },
      )
    }
    throw err
  }

  // Re-assert waiting_review in the UPDATE itself. The check above is a read; Accept claims
  // the row into 'accepting' and then builds the Finatic checkout session from the reviewed
  // total, so between that read and this write an edit could change the amount while the
  // payment for it was already being set up. Conditioning the write on the status closes the
  // window: a losing edit changes nothing at all, rather than silently repricing a
  // transaction in flight.
  const { data: updated, error: updateError } = await supabase
    .from('order_requests')
    .update({
      items_reviewed: pricing.items,
      subtotal_reviewed: pricing.subtotal,
      tax_reviewed: pricing.tax,
      total_reviewed: pricing.total,
    })
    .eq('id', requestId)
    .eq('status', 'waiting_review')
    .select('id, items_reviewed, subtotal_reviewed, tax_reviewed, total_reviewed')
    .maybeSingle()

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  if (!updated) {
    // The row moved out of waiting_review after our check -- almost always a concurrent
    // Accept. Re-read so the staff member is told what actually happened.
    const { data: current } = await supabase
      .from('order_requests')
      .select('status')
      .eq('id', requestId)
      .maybeSingle()
    const status = String(current?.status ?? 'unknown')
    return NextResponse.json(
      { error: statusRejectionMessage(status), status },
      { status: status === 'accepting' ? 409 : 400 },
    )
  }

  return NextResponse.json({ success: true, request: updated })
}
