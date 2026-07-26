import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params
  const body = await req.json().catch(() => ({}))
  const declinedReason = typeof body?.reason === 'string' ? body.reason.trim() : null

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

  if (request.status === 'declined') {
    return NextResponse.json({ success: true })
  }
  if (request.status !== 'waiting_review') {
    return NextResponse.json(
      { error: `Cannot decline a request with status "${request.status}"` },
      { status: 400 },
    )
  }

  const { error: updateError } = await supabase
    .from('order_requests')
    .update({
      status: 'declined',
      declined_reason: declinedReason,
      decided_at: new Date().toISOString(),
      decided_by: auth.userId,
    })
    .eq('id', requestId)

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
