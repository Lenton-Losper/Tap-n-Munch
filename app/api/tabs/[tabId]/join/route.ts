import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { issueTokenForOpenTab } from '@/lib/session-token'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'

export const dynamic = 'force-dynamic'

/**
 * Rejoin / no-PIN join by tab UUID.
 *
 * Hardened against join-by-UUID alone:
 * - tableNumber is required and must match the tab
 * - if pin_required → require matching PIN, member or not
 *
 * #262: the member exemption was a full authentication bypass. `alreadyMember` is computed from
 * a CLIENT-SUPPLIED sessionId against tabs.members[], and tabs.members is SELECTable by the
 * public anon key with no restaurant scope (migration 20260726200000 grants anon SELECT on the
 * column), so the exact value that satisfied the check was published to anyone holding the anon
 * key. Presenting a harvested session_id skipped the PIN and was issued a real session token.
 * `alreadyMember` is kept — it is still what stops a rejoin appending a duplicate members[]
 * entry — but it no longer gates the PIN.
 */
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
    const pin = String(body.pin ?? '').trim()

    const restaurantId = String(restaurantIdRaw || '').trim()
    if (!restaurantId) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }

    const tableNumber = Number(tableNumberRaw)
    if (!Number.isFinite(tableNumber) || tableNumber <= 0) {
      return NextResponse.json({ error: 'tableNumber is required' }, { status: 400 })
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

    if (Number(tabData.table_number) !== tableNumber) {
      return NextResponse.json({ error: 'Table mismatch for this tab' }, { status: 403 })
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

    const members = Array.isArray(tabData.members) ? [...tabData.members] : []
    const alreadyMember =
      Boolean(sessionId) &&
      members.some((m: { session_id?: string }) => String(m?.session_id) === sessionId)

    const pinRequired = tabData.pin_required !== false && Boolean(tabData.tab_pin)
    if (pinRequired) {
      if (!pin) {
        return NextResponse.json({ error: 'PIN required to join this tab' }, { status: 403 })
      }
      if (String(tabData.tab_pin ?? '') !== pin) {
        return NextResponse.json({ error: 'Incorrect PIN' }, { status: 403 })
      }
    }

    if (sessionId && !alreadyMember) {
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
        .eq('restaurant_id', restaurantUuid)
      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 })
      }
    }

    const sessionToken = await issueTokenForOpenTab(
      supabase,
      normalizedTabId,
      tableId,
      restaurantUuid
    )

    return NextResponse.json({
      success: true,
      tabId: normalizedTabId,
      tableId,
      tableNumber: tabData.table_number ?? tableNumber,
      sessionToken,
    })
  } catch (err) {
    console.error('[TABS] join error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
