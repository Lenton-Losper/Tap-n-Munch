import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  orderRestaurantOrFilter,
  resolveOrderRestaurantScope,
  resolveRestaurantUuid,
} from '@/lib/supabase/restaurants'

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
  const orderScope = await resolveOrderRestaurantScope(String(restaurantId || ''))

  console.log('[TABLE-CLOSE] closing table', {
    restaurantUuid,
    firebaseRestaurantId: orderScope.firebaseRestaurantId,
    parsedTableNumber,
  })

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
      payment_status: 'paid',
      paid_at: nowIso,
      completed_at: nowIso,
    })
    .or(orderRestaurantOrFilter(orderScope))
    .eq('table_number', parsedTableNumber)
    .eq('is_closed', false)
    .not('status', 'in', '("completed","cancelled")')

  if (ordersError) {
    return NextResponse.json({ error: ordersError.message }, { status: 400 })
  }

  const ACTIVE_TAB_STATUSES = ['open', 'ready_to_pay', 'active']

  let findTabsQuery = supabase
    .from('tabs')
    .select('id, status, table_id, table_number')
    .eq('restaurant_id', restaurantUuid)
    .in('status', ACTIVE_TAB_STATUSES)

  if (tableId && parsedTableNumber > 0) {
    findTabsQuery = findTabsQuery.or(`table_id.eq.${tableId},table_number.eq.${parsedTableNumber}`)
  } else if (tableId) {
    findTabsQuery = findTabsQuery.eq('table_id', tableId)
  } else {
    findTabsQuery = findTabsQuery.eq('table_number', parsedTableNumber)
  }

  let { data: activeTabs, error: findTabsError } = await findTabsQuery

  if (!findTabsError && (!activeTabs || activeTabs.length === 0)) {
    let fallbackQuery = supabase
      .from('tabs')
      .select('id, status, table_id, table_number')
      .eq('restaurant_id', restaurantUuid)
      .not('status', 'in', '("settled","closed","completed")')

    if (parsedTableNumber > 0) {
      fallbackQuery = fallbackQuery.eq('table_number', parsedTableNumber)
    } else if (tableId) {
      fallbackQuery = fallbackQuery.eq('table_id', tableId)
    }

    const fallbackResult = await fallbackQuery
    if (fallbackResult.error) {
      console.error('[TABLE-CLOSE] fallback tab lookup failed:', fallbackResult.error)
    } else if (fallbackResult.data?.length) {
      activeTabs = fallbackResult.data
      console.log('[TABLE-CLOSE] fallback tab lookup found', activeTabs.length)
    }
  }

  if (findTabsError) {
    console.error('[TABLE-CLOSE] failed to find active tabs:', findTabsError)
    return NextResponse.json({ error: findTabsError.message }, { status: 400 })
  }

  const tabIds = (activeTabs || []).map((tab) => String(tab.id)).filter(Boolean)
  console.log('[TABLE-CLOSE] active tabs to close', {
    tableNumber: parsedTableNumber,
    tableId,
    tabIds,
    count: tabIds.length,
  })

  if (tabIds.length > 0) {
    const { error: tabsError } = await supabase
      .from('tabs')
      .update({
        status: 'settled',
        settled_at: nowIso,
        settled_type: 'manual_close',
      })
      .in('id', tabIds)

    if (tabsError) {
      console.error('[TABLE-CLOSE] tabs update failed:', tabsError)
      return NextResponse.json({ error: tabsError.message }, { status: 400 })
    }
  } else {
    const { error: settleByTableError } = await supabase
      .from('tabs')
      .update({
        status: 'settled',
        settled_at: nowIso,
        settled_type: 'manual_close',
      })
      .eq('restaurant_id', restaurantUuid)
      .eq('table_number', parsedTableNumber)
      .not('status', 'in', '("settled","closed","completed")')

    if (settleByTableError) {
      console.error('[TABLE-CLOSE] settle tabs by table failed:', settleByTableError)
      return NextResponse.json({ error: settleByTableError.message }, { status: 400 })
    }
  }

  if (tableId) {
    await supabase.from('restaurant_tables').update({ status: 'available' }).eq('id', tableId)
  }

  const { error: remainingOrdersError } = await supabase
    .from('orders')
    .update({
      is_closed: true,
      table_closed: true,
      payment_status: 'paid',
      paid_at: nowIso,
      completed_at: nowIso,
    })
    .or(orderRestaurantOrFilter(orderScope))
    .eq('table_number', parsedTableNumber)
    .eq('is_closed', false)

  if (remainingOrdersError) {
    console.warn('[TABLE-CLOSE] remaining orders close failed:', remainingOrdersError)
  }

  return NextResponse.json({
    success: true,
    settled_type: 'manual_close',
    tabs_closed: tabIds.length,
  })
}
