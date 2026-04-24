import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export async function POST(req: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params
  const trimmedOrderId = String(orderId || '').trim()
  if (!trimmedOrderId) {
    return NextResponse.json({ error: 'orderId is required' }, { status: 400 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const tableNumber = String(body.tableNumber ?? '').trim()
  if (!tableNumber) {
    return NextResponse.json({ error: 'tableNumber is required' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()
  const { data: order } = await supabase
    .from('orders')
    .select('*')
    .eq('id', trimmedOrderId)
    .single()

  if (!order) {
    return NextResponse.json(
      { error: 'Order not found' }, { status: 404 }
    )
  }

  if (String(order.table_number) !== String(tableNumber)) {
    return NextResponse.json(
      { error: 'Order does not match this table' },
      { status: 403 }
    )
  }

  const nowIso = new Date().toISOString()
  await supabase
    .from('orders')
    .update({
      status: 'ready_for_terminal',
      ready_for_terminal_at: nowIso
    })
    .eq('id', trimmedOrderId)

  return NextResponse.json({ success: true, orderId: trimmedOrderId, ready_for_terminal_at: nowIso })
}
