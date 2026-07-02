import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  assertRestaurantAdmin,
  getUserFromRequest,
  resolveRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { buildMenuUrl } from '@/lib/base-url'

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ tableId: string }> }
) {
  try {
    const { tableId } = await params
    const body = await request.json().catch(() => ({}))
    const restaurantIdRaw = String(
      (body as { restaurantId?: string }).restaurantId || '',
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
      .select('id, restaurant_id, table_number, is_kiosk, qr_code_url')
      .eq('id', tableId)
      .maybeSingle()

    if (tableError) throw tableError
    if (!tableRow) {
      return NextResponse.json({ error: 'Table not found' }, { status: 404 })
    }
    if (String(tableRow.restaurant_id) !== restaurantId) {
      return NextResponse.json({ error: 'Table does not belong to this restaurant' }, { status: 403 })
    }

    const updates: Record<string, unknown> = {}

    if ('location' in (body as object)) {
      const location = (body as { location?: string | null }).location
      updates.location =
        typeof location === 'string' && location.trim() ? location.trim() : null
    }

    if ('capacity' in (body as object)) {
      const capacity = (body as { capacity?: number | string | null }).capacity
      if (capacity == null || capacity === '') {
        updates.capacity = null
      } else {
        const parsed = Number(capacity)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return NextResponse.json({ error: 'Seats must be a positive number' }, { status: 400 })
        }
        updates.capacity = Math.round(parsed)
      }
    }

    if ('table_name' in (body as object)) {
      const tableName = String((body as { table_name?: string }).table_name || '').trim()
      if (!tableName) {
        return NextResponse.json({ error: 'Name is required' }, { status: 400 })
      }
      updates.table_name = tableName
    }

    if ('active' in (body as object)) {
      updates.active = Boolean((body as { active?: boolean }).active)
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updates provided' }, { status: 400 })
    }

    if (tableRow.is_kiosk && 'table_name' in updates) {
      const tableNumber = Number(tableRow.table_number)
      updates.qr_code_url = buildMenuUrl(restaurantId, tableNumber, true)
    }

    const { data, error: updateError } = await supabase
      .from('restaurant_tables')
      .update(updates)
      .eq('id', tableId)
      .eq('restaurant_id', restaurantId)
      .select('*')
      .single()

    if (updateError) throw updateError

    return NextResponse.json({ table: data })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update table'
    const status =
      message.includes('permission') ||
      message.includes('Forbidden') ||
      message.includes('authorization') ||
      message.includes('session')
        ? 403
        : 500
    console.error('[PATCH TABLE API]', error)
    return NextResponse.json({ error: message }, { status })
  }
}

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
