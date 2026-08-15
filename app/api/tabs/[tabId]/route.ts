import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireSessionToken } from '@/lib/session-guard'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { redactTabMembers } from '@/lib/tab-member-key'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> }
) {
  const { tabId } = await params
  const normalizedTabId = String(tabId || '').trim()

  if (!normalizedTabId) {
    return NextResponse.json({ error: 'Missing tab id' }, { status: 400 })
  }

  const guard = await requireSessionToken(req)
  if (guard.error) return guard.error

  if (guard.tabId && guard.tabId !== normalizedTabId) {
    return NextResponse.json({ error: 'Session token does not match this tab' }, { status: 403 })
  }

  try {
    const supabase = createServerSupabaseClient()
    const { data: tab, error } = await supabase
      .from('tabs')
      .select(
        'id, restaurant_id, table_id, table_number, status, total, members, session_version, pin_required, tab_pin',
      )
      .eq('id', normalizedTabId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!tab) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    // #262. This route had NO callers, and it returned the service_role row VERBATIM -- so
    // `members` went out with every diner's raw `session_id` in it, to any holder of a session
    // token for this tab. A session_id is a credential (lib/guest-orders/queries.ts
    // fetchGuestOrdersBySession reads a diner's orders by it), so one member of a shared tab
    // could have read every other member's orders. Nothing consumed the field, which is the
    // only reason it was never exploited; it would have gone live the moment anything was
    // wired to this route. Members are projected through the same redaction the guest seam
    // uses (GET /api/tabs/[tabId]/view), so both reads agree on the opaque key.
    //
    // Rebuilt field by field rather than spread-and-delete: a column added to the row later
    // must not travel out of here by default.
    const row = tab as Record<string, unknown>
    const { members: _rawMembers, tab_pin: _rawPin, ...safeColumns } = row
    void _rawMembers
    void _rawPin

    // The tab PIN, to a holder of a session token FOR THIS TAB and nobody else.
    //
    // WHY DISCLOSING IT HERE IS NOT NEW EXPOSURE. The session token is strictly stronger than
    // the PIN: the PIN's only power is to mint a token (POST /api/tabs/[tabId]/join), and the
    // caller already holds one -- it is what lets them add orders to this tab
    // (app/api/orders/route.ts). Handing them the PIN gives them nothing they cannot already
    // do. It is a downgrade of a credential they hold, not a new one.
    //
    // WHY NOT ON /view. That route is deliberately unauthenticated (see its docblock) because
    // loadTab runs on every /menu route before a token may exist. A live PIN there would be
    // readable by anyone holding the tab UUID, which is the whole thing the PIN guards against.
    //
    // WHY ITS OWN, STRICTER PREDICATE than the route's 403 above. That check is the shared
    // idiom (assertSessionMatchesResource) and passes a token whose tabId is absent. That
    // cannot happen today -- validateSessionToken joins `tabs!inner`, so a valid token always
    // carries a tab -- but "cannot happen today" is not the standard a credential should be
    // released under. An absent tabId denies here.
    //
    // Never logged: reset-pin's and join's audit rows both deliberately omit the PIN, on the
    // grounds that those rows are read by more people than should see a live one. Same here.
    const tokenTabId = String(guard.tabId || '').trim()
    const pinRequired = row.pin_required !== false && Boolean(row.tab_pin)
    const disclosePin = Boolean(tokenTabId) && tokenTabId === normalizedTabId && pinRequired

    return NextResponse.json({
      success: true,
      tab: {
        ...safeColumns,
        members: await redactTabMembers(normalizedTabId, row.members),
        ...(disclosePin ? { tab_pin: String(row.tab_pin) } : {}),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
