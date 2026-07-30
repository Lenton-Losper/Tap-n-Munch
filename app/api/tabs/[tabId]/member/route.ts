import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { assertSessionMatchesResource, requireSessionToken } from '@/lib/session-guard'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> }
) {
  const { tabId } = await params

  // This route had NO authentication of any kind. It was the sole tab-scoped route without a
  // session guard -- every sibling (ready-to-pay, the tab GET) calls requireSessionToken --
  // and because it uses the service-role client, RLS did not compensate. Anyone who knew or
  // guessed a tab UUID could rewrite any member's display name on any tab, with no session,
  // no token, and no relationship to the restaurant.
  //
  // requireSessionToken rejects a caller with no token (410) or a revoked/expired one;
  // assertSessionMatchesResource then binds that token to THIS tab, so a valid token for
  // tab A cannot be replayed against tab B.
  const guard = await requireSessionToken(req)
  if (guard.error) return guard.error

  const mismatch = assertSessionMatchesResource(guard, { tabId })
  if (mismatch) return mismatch

  const { sessionId, displayName } = await req.json()

  if (!sessionId || !displayName?.trim()) {
    return NextResponse.json({ error: 'Missing sessionId or displayName' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()

  const { data: tab } = await supabase
    .from('tabs')
    .select('id, members')
    .eq('id', tabId)
    .single()

  if (!tab) return NextResponse.json({ error: 'Tab not found' }, { status: 404 })

  // Only rename a member that actually exists on this tab. Previously an unknown sessionId
  // mapped over every row unchanged and still returned success, so a caller could not tell a
  // no-op from a rename, and neither could anyone reading the logs.
  //
  // NOTE: this does NOT stop one member of a tab renaming ANOTHER member of the same tab.
  // The token carries no member identity -- requireSessionToken returns only
  // { tabId, tableId, restaurantId } and customer_sessions has no column linking a token to
  // the client-generated sessionId in tabs.members. That link is absent because it was never
  // persisted, not because it is hard: sessionId is already in scope at both token-issue
  // sites (app/api/tabs/route.ts and the join route) and is simply not passed to
  // issueTokenForOpenTab. Closing it is additive -- a nullable member_session_id column,
  // passed through and compared here.
  const members = (tab.members || []) as Array<Record<string, unknown>>
  const isMember = members.some((m) => m.session_id === sessionId)

  if (!isMember) {
    return NextResponse.json(
      { error: 'That session is not a member of this tab' },
      { status: 404 },
    )
  }

  const updatedMembers = members.map((m) =>
    m.session_id === sessionId ? { ...m, display_name: displayName.trim() } : m,
  )

  const { error: updateError } = await supabase
    .from('tabs')
    .update({ members: updatedMembers })
    .eq('id', tabId)

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
