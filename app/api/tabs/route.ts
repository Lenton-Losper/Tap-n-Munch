import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { issueTokenForOpenTab } from '@/lib/session-token'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  console.log('[TABS] POST /api/tabs — create tab request received')

  try {
    const body = await req.json()
    const restaurantIdRaw = body.restaurantId ?? body.restaurant_id
    const tableNumberRaw = body.tableNumber ?? body.table_number
    const sessionId = String(body.sessionId ?? body.session_id ?? '').trim()
    const displayName = String(body.displayName ?? body.display_name ?? 'Person 1').trim() || 'Person 1'

    const restaurantId = String(restaurantIdRaw || '').trim()
    const tableNumber = Number(tableNumberRaw)

    console.log('[TABS] parsed body', { restaurantId, tableNumber, hasSessionId: Boolean(sessionId) })

    if (!restaurantId) {
      console.log('[TABS] rejected — missing restaurantId')
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
      console.log('[TABS] rejected — invalid tableNumber', tableNumberRaw)
      return NextResponse.json({ error: 'Invalid table number' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()

    console.log('[TABS] resolving restaurant UUID', restaurantId)
    const restaurantUuid = await resolveRestaurantUuid(restaurantId)
    console.log('[TABS] restaurant UUID resolved', restaurantUuid)

    console.log('[TABS] looking up restaurant_tables row', { restaurantUuid, tableNumber })
    const { data: tableRow, error: tableError } = await supabase
      .from('restaurant_tables')
      .select('id, table_number, current_session_version')
      .eq('restaurant_id', restaurantUuid)
      .eq('table_number', tableNumber)
      .maybeSingle()

    if (tableError) {
      console.error('[TABS] restaurant_tables lookup error', tableError)
      return NextResponse.json({ error: tableError.message }, { status: 500 })
    }
    if (!tableRow?.id) {
      console.log('[TABS] no table found for restaurant/table_number')
      return NextResponse.json(
        { error: `Table ${tableNumber} is not set up for this restaurant. Ask staff to add it in FlashTap settings.` },
        { status: 404 }
      )
    }

    console.log('[TABS] table UUID found', tableRow.id)

    const members = sessionId
      ? [
          {
            session_id: sessionId,
            joined_at: new Date().toISOString(),
            display_name: displayName,
          },
        ]
      : []

    const insertPayload = {
      restaurant_id: restaurantUuid,
      table_id: tableRow.id,
      table_number: tableNumber,
      status: 'open',
      members,
      total: 0,
    }

    console.log('[TABS] inserting tab row', {
      restaurant_id: insertPayload.restaurant_id,
      table_id: insertPayload.table_id,
      table_number: insertPayload.table_number,
      memberCount: members.length,
    })

    const { data: newTab, error: insertError } = await supabase
      .from('tabs')
      .insert(insertPayload)
      .select('id, restaurant_id, table_id, table_number, status')
      .single()

    if (insertError) {
      console.error('[TABS] insert failed', insertError)
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    if (!newTab?.id) {
      console.error('[TABS] insert returned no row')
      return NextResponse.json({ error: 'Tab was not created' }, { status: 500 })
    }

    console.log('[TABS] tab created successfully', newTab)

    await supabase.from('restaurant_tables').update({ status: 'occupied' }).eq('id', tableRow.id)

    console.log('[TOKEN-4] calling issueTokenForOpenTab')
    const sessionToken = await issueTokenForOpenTab(
      supabase,
      newTab.id,
      tableRow.id,
      restaurantUuid
    )
    console.log('[TOKEN-4] sessionToken result', sessionToken, typeof sessionToken)

    return NextResponse.json({
      success: true,
      tabId: newTab.id,
      restaurantId: newTab.restaurant_id,
      tableId: newTab.table_id,
      tableNumber: newTab.table_number,
      sessionToken,
    })
  } catch (err) {
    console.error('[TABS] unexpected error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
