import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireSessionToken } from '@/lib/session-guard'

const ALLOWED_FROM_STATUSES = new Set(['pending', 'accepted', 'preparing', 'ready'])

export async function POST(req: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params
  const trimmedOrderId = String(orderId || '').trim()
  if (!trimmedOrderId) {
    return NextResponse.json({ error: 'Missing orderId' }, { status: 400 })
  }

  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  const tableNumber = body.tableNumber ?? body.table_number
  const bodySessionId = String(body.session_id ?? body.sessionId ?? '').trim()

  if (tableNumber == null || tableNumber === '') {
    return NextResponse.json({ error: 'tableNumber is required' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()
  const { data: order, error: loadError } = await supabase
    .from('orders')
    .select('id, table_number, restaurant_id, status, session_id, tab_id')
    .eq('id', trimmedOrderId)
    .maybeSingle()

  if (loadError) {
    console.error('[ready-for-terminal] load failed', loadError)
    return NextResponse.json({ error: 'Failed to load order' }, { status: 500 })
  }
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 })
  }

  if (String(order.table_number) !== String(tableNumber)) {
    return NextResponse.json({ error: 'Table mismatch' }, { status: 403 })
  }

  // Prefer dining session token (tab flows). Fall back to body session_id matching the
  // order's session_id for kiosk / non-tab guests that use flashtap_session_v1 only.
  const guard = await requireSessionToken(req)
  if (!guard.error) {
    if (guard.restaurantId && String(order.restaurant_id) !== String(guard.restaurantId)) {
      return NextResponse.json({ error: 'Restaurant mismatch' }, { status: 403 })
    }
    if (order.tab_id && guard.tabId && String(order.tab_id) !== String(guard.tabId)) {
      return NextResponse.json({ error: 'Tab session mismatch' }, { status: 403 })
    }
  } else {
    const orderSession = String(order.session_id || '').trim()
    if (!bodySessionId || !orderSession || bodySessionId !== orderSession) {
      return NextResponse.json(
        { error: 'Session token or matching session_id required' },
        { status: 401 },
      )
    }
  }

  const currentStatus = String(order.status || '').toLowerCase()
  if (!ALLOWED_FROM_STATUSES.has(currentStatus)) {
    return NextResponse.json(
      { error: `Cannot mark ready for terminal from status ${currentStatus || 'unknown'}` },
      { status: 409 },
    )
  }

  const nowIso = new Date().toISOString()
  const { data: updated, error: updateError } = await supabase
    .from('orders')
    .update({
      status: 'ready_for_terminal',
      ready_for_terminal_at: nowIso,
    })
    .eq('id', trimmedOrderId)
    .in('status', [...ALLOWED_FROM_STATUSES])
    .select('id')
    .maybeSingle()

  if (updateError) {
    console.error('[ready-for-terminal] update failed', updateError)
    return NextResponse.json({ error: 'Failed to update order' }, { status: 500 })
  }
  if (!updated?.id) {
    return NextResponse.json(
      { error: 'Order status changed; refresh and try again' },
      { status: 409 },
    )
  }

  return NextResponse.json({
    success: true,
    orderId: trimmedOrderId,
    ready_for_terminal_at: nowIso,
  })
}
