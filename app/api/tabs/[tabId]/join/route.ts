import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { issueTokenForOpenTab } from '@/lib/session-token'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { generateTabPin } from '@/lib/tabs/generate-tab-pin'

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
 *
 * #265: `resetToken` is the alternative to the PIN, for a customer who has lost theirs.
 * Staff mint it via POST /api/tabs/[tabId]/reset-pin and display it only as a QR the
 * recovering customer's own device scans — see that route for why a token rather than
 * "next scan wins", and why staff never see the PIN itself. Redeeming it here mints a NEW
 * tab_pin and clears both reset columns in the SAME update, so a token is usable exactly
 * once: the clearing update is what makes a second request with the same token fail the
 * match and fall through to "PIN required", not a check performed before the write.
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
    const resetToken = String(body.resetToken ?? body.reset_token ?? '').trim()

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

    let newPin: string | null = null

    if (resetToken) {
      // #265. A token was presented -- this request is a recovery attempt, not an ordinary
      // join, so it either succeeds via the token or fails outright. Falling through to
      // "PIN required" on a bad token would ask a customer who came here specifically
      // because they do not know the PIN to enter... the PIN.
      const tokenMatches =
        Boolean(tabData.pin_reset_token) && tabData.pin_reset_token === resetToken
      const tokenLive =
        tokenMatches &&
        Boolean(tabData.pin_reset_token_expires_at) &&
        new Date(String(tabData.pin_reset_token_expires_at)).getTime() > Date.now()

      if (!tokenLive) {
        return NextResponse.json(
          { error: 'This recovery link has expired or already been used. Ask staff to generate a new one.' },
          { status: 403 },
        )
      }

      newPin = generateTabPin()

      // Single-use by construction, including under a race: the WHERE clause re-asserts
      // pin_reset_token = resetToken at the moment of the write, so two concurrent requests
      // for the same token can only both match SQL's view of "the row still has this token"
      // once -- the loser's UPDATE matches zero rows. Checking the returned row (not just
      // absence of an error) is what catches that; an unchecked update would let the loser
      // proceed with a newPin that was never actually written.
      const { data: resetRow, error: resetError } = await supabase
        .from('tabs')
        .update({ tab_pin: newPin, pin_reset_token: null, pin_reset_token_expires_at: null })
        .eq('id', normalizedTabId)
        .eq('restaurant_id', restaurantUuid)
        .eq('pin_reset_token', resetToken)
        .select('id')
        .maybeSingle()

      if (resetError) {
        return NextResponse.json({ error: resetError.message }, { status: 500 })
      }
      if (!resetRow) {
        return NextResponse.json(
          { error: 'This recovery link has expired or already been used. Ask staff to generate a new one.' },
          { status: 403 },
        )
      }

      await supabase.from('audit_logs').insert({
        restaurant_id: restaurantUuid,
        action: 'tab.pin_reset_redeemed',
        entity_type: 'tab',
        entity_id: normalizedTabId,
        metadata: { sessionId: sessionId || null },
        // Neither the old nor the new PIN is logged here, for the same reason reset-pin's
        // request audit row omits the token: this row is read by more people than should
        // ever see a live PIN.
      })
    } else {
      const pinRequired = tabData.pin_required !== false && Boolean(tabData.tab_pin)
      if (pinRequired) {
        if (!pin) {
          return NextResponse.json({ error: 'PIN required to join this tab' }, { status: 403 })
        }
        if (String(tabData.tab_pin ?? '') !== pin) {
          return NextResponse.json({ error: 'Incorrect PIN' }, { status: 403 })
        }
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
      // #265. Present only when this request redeemed a reset token. Mirrors POST /api/tabs's
      // own tabPin field on creation -- the client stores it the same way, under the same key.
      ...(newPin ? { tabPin: newPin } : {}),
    })
  } catch (err) {
    console.error('[TABS] join error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
