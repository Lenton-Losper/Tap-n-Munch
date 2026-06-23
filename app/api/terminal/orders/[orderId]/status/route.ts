import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

export const dynamic = 'force-dynamic'

const ALLOWED_STATUSES = new Set([
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'completed',
  'cancelled',
])

function isValidTransition(currentStatus: string, nextStatus: string): boolean {
  if (nextStatus === 'cancelled') {
    return currentStatus !== 'completed' && currentStatus !== 'cancelled'
  }

  const transitions: Record<string, string> = {
    pending: 'confirmed',
    confirmed: 'preparing',
    accepted: 'preparing',
    preparing: 'ready',
    ready: 'completed',
  }

  return transitions[currentStatus] === nextStatus
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json(
        { error: 'Missing permission: orders:update' },
        { status: 403 }
      )
    }

    const { orderId } = await params
    const body = await req.json().catch(() => ({}))
    const newStatus = String(body?.status || '').trim()

    console.log('[TERMINAL ORDER STATUS DEBUG]', {
      orderId,
      jwtTerminalId: terminal.terminalId,
      jwtRestaurantId: terminal.restaurantId,
      requestedStatus: body?.status,
    })

    if (!newStatus || !ALLOWED_STATUSES.has(newStatus)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
    }

    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    console.log('[TERMINAL ORDER LOOKUP]', {
      found: !!order,
      order,
      error,
    })

    const { data: orderNoFilter } = await supabase
      .from('orders')
      .select('id, restaurant_id, status')
      .eq('id', orderId)
      .single()

    console.log('[ORDER WITHOUT RESTAURANT FILTER]', orderNoFilter)

    if (error) {
      return NextResponse.json({ error: 'Failed to load order' }, { status: 500 })
    }

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    const currentStatus = String(order.status || '')

    if (!isValidTransition(currentStatus, newStatus)) {
      return NextResponse.json(
        { error: `Invalid transition: ${currentStatus} → ${newStatus}` },
        { status: 400 }
      )
    }

    const { data, error: updateError } = await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', orderId)
      .select()

    console.error('[STATUS UPDATE ERROR FULL]', JSON.stringify(updateError))
    console.log('[STATUS UPDATE DATA]', JSON.stringify(data))

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message, details: updateError },
        { status: 500 }
      )
    }

    const updatedOrder = data?.[0]
    if (!updatedOrder) {
      console.error('[STATUS UPDATE ERROR FULL]', JSON.stringify({ message: 'Update returned no rows', orderId, newStatus }))
      return NextResponse.json({ error: 'Failed to update order — no rows returned' }, { status: 500 })
    }

    return NextResponse.json({ success: true, order: updatedOrder })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
