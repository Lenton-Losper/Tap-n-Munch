import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantAdmin,
  getUserFromRequest,
  resolveRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'

export const dynamic = 'force-dynamic'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ tableId: string }> }
) {
  try {
    const { tableId } = await params
    const body = await request.json().catch(() => ({}))
    const restaurantIdRaw = String(
      (body as { restaurantId?: string }).restaurantId || ''
    ).trim()

    if (!tableId?.trim()) {
      return NextResponse.json({ error: 'Missing tableId' }, { status: 400 })
    }
    if (!restaurantIdRaw) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }

    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await resolveRestaurantId(supabase, restaurantIdRaw)

    await assertRestaurantAdmin(supabase, user.id, restaurantId)

    const { data: tableRow, error: tableError } = await supabase
      .from('restaurant_tables')
      .select('id, restaurant_id, table_number')
      .eq('id', tableId)
      .maybeSingle()

    if (tableError) throw tableError
    if (!tableRow) {
      return NextResponse.json({ error: 'Table not found' }, { status: 404 })
    }
    if (String(tableRow.restaurant_id) !== restaurantId) {
      return NextResponse.json({ error: 'Table does not belong to this restaurant' }, { status: 403 })
    }

    const tableNumber = Number(tableRow.table_number) || 0

    let tabsQuery = supabase.from('tabs').select('id').eq('restaurant_id', restaurantId)
    if (tableNumber > 0) {
      tabsQuery = tabsQuery.or(`table_id.eq.${tableId},table_number.eq.${tableNumber}`)
    } else {
      tabsQuery = tabsQuery.eq('table_id', tableId)
    }
    const { data: tabRows } = await tabsQuery

    const tabIds = (tabRows || []).map((t) => String(t.id)).filter(Boolean)

    if (tabIds.length > 0) {
      const { error: tabOrdersError } = await supabase
        .from('orders')
        .delete()
        .in('tab_id', tabIds)
      if (tabOrdersError) {
        console.warn('[DELETE TABLE API] tab orders cleanup:', tabOrdersError.message)
      }

      const { error: tabsError } = await supabase.from('tabs').delete().in('id', tabIds)
      if (tabsError) {
        console.warn('[DELETE TABLE API] tabs cleanup:', tabsError.message)
      }
    }

    let ordersQuery = supabase.from('orders').delete().eq('restaurant_id', restaurantId)
    if (tableNumber > 0) {
      ordersQuery = ordersQuery.or(`table_id.eq.${tableId},table_number.eq.${tableNumber}`)
    } else {
      ordersQuery = ordersQuery.eq('table_id', tableId)
    }
    const { error: ordersError } = await ordersQuery
    if (ordersError) {
      console.warn('[DELETE TABLE API] orders cleanup:', ordersError.message)
    }

    const { error: sessionsError } = await supabase
      .from('table_sessions')
      .delete()
      .eq('table_id', tableId)
    if (sessionsError) {
      console.warn('[DELETE TABLE API] table_sessions cleanup:', sessionsError.message)
    }

    const { error: deleteError } = await supabase
      .from('restaurant_tables')
      .delete()
      .eq('id', tableId)
      .eq('restaurant_id', restaurantId)

    if (deleteError) throw deleteError

    console.log('[DELETE TABLE API] deleted', { tableId, restaurantId, tableNumber })

    return NextResponse.json({ success: true, tableId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to delete table'
    const status =
      message.includes('permission') ||
      message.includes('Forbidden') ||
      message.includes('authorization') ||
      message.includes('session')
        ? 403
        : 500
    console.error('[DELETE TABLE API]', error)
    return NextResponse.json({ error: message }, { status })
  }
}
