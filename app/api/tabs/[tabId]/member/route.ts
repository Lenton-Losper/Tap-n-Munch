import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { assertSessionMatchesResource, requireSessionToken } from '@/lib/session-guard'

export const dynamic = 'force-dynamic'

/**
 * Rename the caller's own member entry on a tab.
 *
 * WHAT THIS ROUTE USED TO BE. No session token, no restaurant scope, a service-role client and a
 * full-array overwrite of `tabs.members` — filtered on `.eq('id', tabId)` alone. The tab UUID is
 * handed out unauthenticated by GET /api/tabs/active (restaurantId + tableNumber, both public),
 * so possession of a printed table number was enough to rewrite any tab's member list in any
 * restaurant on the platform. It was the only customer write in the system with no tenant
 * boundary at all. Reproduced against a staging dev server: 200, and the display name changed.
 *
 * THREE THINGS CHANGED, and each closes a different hole:
 *
 *   1. `requireSessionToken` + `assertSessionMatchesResource` — the same pair
 *      /api/tabs/[tabId]/ready-to-pay already uses. The token is bound to a tab, a table and a
 *      restaurant at issue time (lib/session-token.ts) and is revoked by tab settlement, by
 *      `close_table_session`'s session-version bump, and by its own 24h expiry. It is the only
 *      credential in the QR system that anything can revoke.
 *
 *   2. A restaurant scope on BOTH statements. `assertSessionMatchesResource` compares the token's
 *      restaurant against the one the caller claims; the `.eq('restaurant_id', …)` below makes the
 *      database enforce it as well, so a token for the right tab id in the wrong tenant cannot
 *      reach the row. Belt and braces deliberately: the helper skips its check when either side is
 *      absent, and a defence that silently no-ops on a missing field is #124's shape.
 *
 *   3. The write is now scoped to the CALLER'S OWN member entry, and is conditional. A token
 *      holder may rename themselves and nobody else — previously any `sessionId` in the body was
 *      renameable by anyone. The caller must also already be a member: this route renames, it does
 *      not join. Joining is POST /api/tabs/[tabId]/join and it is PIN-gated.
 *
 * WHAT IS NOT FIXED HERE, deliberately. This is still a read-modify-write of the whole `members`
 * array, so a rename concurrent with a join can still lose the joiner (QRA-09 — the same shape
 * `add_tab_member` was written to fix for the join path, and which two other writers still carry).
 * Fixing that means an RPC that mutates one entry, which is a migration and a separate change;
 * doing it inside an authorization fix would put a schema change on the critical path of a
 * production exposure. The window is now much smaller because only a token holder can reach it.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> }
) {
  const { tabId } = await params
  const normalizedTabId = String(tabId || '').trim()

  if (!normalizedTabId) {
    return NextResponse.json({ error: 'Missing tab id' }, { status: 400 })
  }

  const body = await req.json().catch(() => ({}))
  const sessionId = String(body?.sessionId ?? body?.session_id ?? '').trim()
  const displayName = String(body?.displayName ?? body?.display_name ?? '').trim()
  const restaurantIdInput = String(body?.restaurantId ?? body?.restaurant_id ?? '').trim()

  if (!sessionId || !displayName) {
    return NextResponse.json({ error: 'Missing sessionId or displayName' }, { status: 400 })
  }

  // Before anything is read. A 410 here is what fetchWithSession turns into "your dining session
  // has ended", which is the correct outcome for a token that has expired or been revoked.
  const guard = await requireSessionToken(req)
  if (guard.error) return guard.error

  if (!guard.tabId || guard.tabId !== normalizedTabId) {
    return NextResponse.json(
      { error: 'Session token does not match this tab' },
      { status: 403 },
    )
  }

  try {
    const supabase = createServerSupabaseClient()

    // The restaurant the caller claims, resolved the same way every sibling route resolves it so
    // a slug and a uuid behave identically. Optional in the body for backward compatibility with
    // the current client (app/menu/[restaurantId]/tab/page.tsx sends it); when it is absent the
    // token's own restaurant is used, which is server-issued and cannot be forged.
    const restaurantUuid = restaurantIdInput
      ? await resolveRestaurantUuid(restaurantIdInput)
      : String(guard.restaurantId || '')

    if (!restaurantUuid) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }

    const mismatch = assertSessionMatchesResource(guard, {
      restaurantId: restaurantUuid,
      tabId: normalizedTabId,
    })
    if (mismatch) return mismatch

    const { data: tab, error: loadError } = await supabase
      .from('tabs')
      .select('id, members')
      .eq('id', normalizedTabId)
      .eq('restaurant_id', restaurantUuid)
      .maybeSingle()

    if (loadError) {
      console.error('[TABS] member rename load failed', loadError)
      return NextResponse.json({ error: loadError.message }, { status: 500 })
    }
    if (!tab) return NextResponse.json({ error: 'Tab not found' }, { status: 404 })

    const members = Array.isArray(tab.members) ? tab.members : []

    // Rename YOUR OWN entry. The old route renamed whichever entry matched the sessionId in the
    // body, so a caller could rename any member whose session id they had seen — and a session id
    // is readable by other members (GET /api/orders?tabId= returns it per order). A token proves
    // membership of the tab, not of a particular member row, so the row still has to be matched.
    const isSelf = members.some(
      (m: { session_id?: string }) => String(m?.session_id ?? '') === sessionId,
    )
    if (!isSelf) {
      // Same answer as "no such tab": a caller who is not this member must not learn whether the
      // member exists. Joining is not this route's job.
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    const updatedMembers = members.map((m: { session_id?: string }) =>
      String(m?.session_id ?? '') === sessionId ? { ...m, display_name: displayName } : m,
    )

    const { data: updated, error: updateError } = await supabase
      .from('tabs')
      .update({ members: updatedMembers })
      .eq('id', normalizedTabId)
      .eq('restaurant_id', restaurantUuid)
      .select('id')
      .maybeSingle()

    if (updateError) {
      console.error('[TABS] member rename failed', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }
    if (!updated) {
      return NextResponse.json({ error: 'Tab not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[TABS] member rename unexpected error', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
