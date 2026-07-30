import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { issueTokenForOpenTab } from '@/lib/session-token'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const restaurantIdRaw = body.restaurantId ?? body.restaurant_id
    const tableNumberRaw = body.tableNumber ?? body.table_number
    const pin = String(body.pin ?? '').trim()
    const sessionId = String(body.sessionId ?? body.session_id ?? '').trim()
    const displayName = String(body.displayName ?? body.display_name ?? '').trim()

    const restaurantId = String(restaurantIdRaw || '').trim()
    const tableNumber = Number(tableNumberRaw)

    if (!restaurantId) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
      return NextResponse.json({ error: 'Invalid table number' }, { status: 400 })
    }
    if (!pin) {
      return NextResponse.json({ error: 'Missing PIN' }, { status: 400 })
    }

    const restaurantUuid = await resolveRestaurantUuid(restaurantId)
    const supabase = createServerSupabaseClient()

    const { data: tab, error } = await supabase
      .from('tabs')
      .select('id, restaurant_id, table_id, table_number, status, tab_pin, members')
      .eq('restaurant_id', restaurantUuid)
      .eq('table_number', tableNumber)
      .eq('status', 'open')
      .single()

    if (error || !tab) {
      return NextResponse.json({ error: 'No open tab found for this table' }, { status: 404 })
    }

    if (String(tab.tab_pin ?? '') !== pin) {
      return NextResponse.json({ error: 'Incorrect PIN' }, { status: 403 })
    }

    const tableId = String(tab.table_id || '').trim()
    if (!tableId) {
      return NextResponse.json({ error: 'Tab is missing table_id' }, { status: 500 })
    }

    if (sessionId) {
      // Append via the DB so simultaneous joiners cannot clobber each other. Reading
      // members here and writing the whole array back lost every concurrent joiner but one
      // -- and returned HTTP 200 to all of them, so nobody found out. add_tab_member does
      // the append, the already-a-member check, and the "Person N" fallback inside one
      // UPDATE. See supabase/migrations/20260730210000_atomic_tab_member_append.sql.
      const { error: memberError } = await supabase.rpc('add_tab_member', {
        p_tab_id: tab.id,
        p_member: {
          session_id: sessionId,
          joined_at: new Date().toISOString(),
          display_name: displayName || '',
        },
      })

      if (memberError) {
        return NextResponse.json({ error: memberError.message }, { status: 500 })
      }
    }

    const sessionToken = await issueTokenForOpenTab(
      supabase,
      tab.id,
      tableId,
      restaurantUuid
    )

    return NextResponse.json({
      success: true,
      tabId: tab.id,
      sessionToken,
    })
  } catch (err) {
    console.error('[TABS] join by PIN error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
