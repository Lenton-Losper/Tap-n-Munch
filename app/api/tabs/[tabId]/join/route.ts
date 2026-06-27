import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { issueTokenForOpenTab } from '@/lib/session-token'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> }
) {
  const { tabId } = await params
  const normalizedTabId = String(tabId || '').trim()

  if (!normalizedTabId) {
    return NextResponse.json({ error: 'Missing tab id' }, { status: 400 })
  }

  try {
    const body = await req.json()
    const restaurantIdRaw = body.restaurantId ?? body.restaurant_id
    const sessionId = String(body.sessionId ?? body.session_id ?? '').trim()
    const displayName = String(body.displayName ?? body.display_name ?? '').trim()
    const tableNumberRaw = body.tableNumber ?? body.table_number

    const restaurantId = String(restaurantIdRaw || '').trim()
    if (!restaurantId) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }

    const restaurantUuid = await resolveRestaurantUuid(restaurantId)
    const supabase = createServerSupabaseClient()

    const { data: tabData, error: tabError } = await supabase
      .from('tabs')
      .select('*')
      .eq('id', normalizedTabId)
      .eq('restaurant_id', restaurantUuid)
      .single()

    if (tabError || !tabData) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    if (String(tabData.status || '') !== 'open') {
      if (String(tabData.status || '') === 'ready_to_pay') {
        return NextResponse.json(
          {
            error: 'Payment is currently being processed for this table.',
            code: 'TAB_PAYMENT_IN_PROGRESS',
          },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: 'This tab is not available right now.' }, { status: 400 })
    }

    const tableId = String(tabData.table_id || '').trim()
    if (!tableId) {
      return NextResponse.json({ error: 'Tab is missing table_id' }, { status: 400 })
    }

    if (sessionId) {
      const members = Array.isArray(tabData.members) ? [...tabData.members] : []
      if (!members.some((m: { session_id?: string }) => String(m?.session_id) === sessionId)) {
        const nextN = members.length + 1
        const member = {
          session_id: sessionId,
          joined_at: new Date().toISOString(),
          display_name: displayName || `Person ${nextN}`,
        }
        const { error: updateError } = await supabase
          .from('tabs')
          .update({ members: [...members, member] })
          .eq('id', normalizedTabId)
        if (updateError) {
          return NextResponse.json({ error: updateError.message }, { status: 500 })
        }
      }
    }

    console.log('[JOIN-TOKEN-1] calling issueTokenForOpenTab', { tabId: normalizedTabId, tableId, restaurantUuid })
    const sessionToken = await issueTokenForOpenTab(
      supabase,
      normalizedTabId,
      tableId,
      restaurantUuid
    )
    console.log('[JOIN-TOKEN-2] sessionToken result', sessionToken, typeof sessionToken)

    return NextResponse.json({
      success: true,
      tabId: normalizedTabId,
      tableId,
      tableNumber: tabData.table_number ?? tableNumberRaw ?? null,
      sessionToken,
    })
  } catch (err) {
    console.error('[TABS] join error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
