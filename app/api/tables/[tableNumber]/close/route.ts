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

  console.log('[TABLE-CLOSE] closing table', { restaurantUuid, parsedTableNumber })

  const { data: tableRow } = await supabase
    .from('restaurant_tables')
    .select('id')
    .eq('restaurant_id', restaurantUuid)
    .eq('table_number', parsedTableNumber)
    .maybeSingle()

  const tableId = tableRow?.id ? String(tableRow.id) : null

  const { error: ordersError } = await supabase
    .from('orders')
    .update({
      is_closed: true,
      table_closed: true,
      status: 'completed',
    })
    .eq('restaurant_id', restaurantUuid)
    .eq('table_number', parsedTableNumber)
    .eq('is_closed', false)

  if (ordersError) {
    return NextResponse.json({ error: ordersError.message }, { status: 400 })
  }

  let tabsQuery = supabase
    .from('tabs')
    .update({
      status: 'settled',
      settled_at: nowIso,
      settled_type: 'manual_close',
      updated_at: nowIso,
    })
    .eq('restaurant_id', restaurantUuid)
    .in('status', ['open', 'ready_to_pay'])

  if (tableId) {
    tabsQuery = tabsQuery.eq('table_id', tableId)
  } else {
    tabsQuery = tabsQuery.eq('table_number', parsedTableNumber)
  }

  const { error: tabsError } = await tabsQuery

  if (tabsError) {
    console.warn('[TABLE-CLOSE] tabs update failed:', tabsError)
  }

  const tableUpdate: Record<string, unknown> = {
    session_id: null,
    current_tab_id: null,
    status: 'available',
    updated_at: nowIso,
  }

  let tableSessionQuery = supabase.from('restaurant_tables').update(tableUpdate).eq('restaurant_id', restaurantUuid)

  if (tableId) {
    tableSessionQuery = tableSessionQuery.eq('id', tableId)
  } else {
    tableSessionQuery = tableSessionQuery.eq('table_number', parsedTableNumber)
  }

  const { error: tableSessionError } = await tableSessionQuery

  if (tableSessionError) {
    console.warn('[TABLE-CLOSE] restaurant_tables update failed:', tableSessionError)
  }

  return NextResponse.json({ success: true, settled_type: 'manual_close' })
}
