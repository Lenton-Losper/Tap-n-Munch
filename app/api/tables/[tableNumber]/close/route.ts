import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tableNumber: string }> }
) {
  const supabase = createServerSupabaseClient()
  const { restaurantId } = await req.json()
  const { tableNumber } = await params
  const parsedTableNumber = Number(tableNumber)
  const nowIso = new Date().toISOString()
  const restaurantUuid = await resolveRestaurantUuid(String(restaurantId || ''))

  console.log('[TABLE-CLOSE] closing table', {
    restaurantUuid,
    parsedTableNumber,
  })

  const { data: tableRow } = await supabase
    .from('restaurant_tables')
    .select('id')
    .eq('restaurant_id', restaurantUuid)
    .eq('table_number', parsedTableNumber)
    .maybeSingle()

  if (!tableRow?.id) {
    return NextResponse.json({ error: 'Table not found' }, { status: 404 })
  }

  const { data: rpcResult, error: rpcError } = await supabase.rpc('close_table_session', {
    p_table_id: tableRow.id,
    p_restaurant_id: restaurantUuid,
  })

  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 500 })
  }

  await supabase
    .from('orders')
    .update({
      is_closed: true,
      table_closed: true,
      status: 'completed',
      payment_status: 'paid',
      paid_at: nowIso,
      completed_at: nowIso,
    })
    .eq('restaurant_id', restaurantUuid)
    .eq('table_number', parsedTableNumber)
    .eq('is_closed', false)

  return NextResponse.json({ success: true, ...(rpcResult as Record<string, unknown>) })
}
