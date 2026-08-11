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
      .select('id, restaurant_id, table_id, table_number, status, total, members, session_version')
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
    const { members: _rawMembers, ...safeColumns } = row
    void _rawMembers

    return NextResponse.json({
      success: true,
      tab: {
        ...safeColumns,
        members: await redactTabMembers(normalizedTabId, row.members),
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
