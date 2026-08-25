import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { releaseStrandedClaim } from '@/lib/order-requests/release-stranded-claim'

export const dynamic = 'force-dynamic'

/**
 * #120's RESIDUAL — the STAFF DASHBOARD's escape hatch for a claim stranded in `accepting`.
 *
 * The sibling of `app/api/terminal/order-requests/[requestId]/release`. Same operation, different
 * caller: this one authenticates with `requireStaffPermission(TABLES_MANAGE)` — the same permission
 * that gates the dashboard's Close Table action, because this is the button that unblocks it.
 *
 * THE RULE LIVES IN ONE PLACE, `lib/order-requests/release-stranded-claim.ts`, and both routes call
 * it. This route owns authentication and nothing else.
 *
 * That is not tidiness, it is the point of the whole change. #120 existed because the terminal and
 * the dashboard had two close routes doing one job with the guard written into only one of them,
 * and the dashboard's went unguarded long enough to become the "silently missing from the bill,
 * then re-inflates a closed tab" case. Writing the release rule twice would set the same trap for
 * whoever tightens one of them next.
 *
 * SHIPPED WITH THE DASHBOARD'S GUARD, NEVER BEFORE IT. Guarding the dashboard's close without this
 * would leave staff with a table they cannot close and no way to clear it — the terminal has been
 * in exactly that state since #120 shipped, which is what made this urgent.
 */
export async function POST(req: Request, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const rawRestaurantId = String((body as { restaurantId?: unknown }).restaurantId || '').trim()
    /**
     * VALIDATED BEFORE THE RESOLVE, not after. `resolveRestaurantUuid` THROWS on an empty input —
     * `throw new Error('Restaurant id is required')` at restaurants.ts:79 — so a `!restaurantUuid`
     * check placed after the call can never run: the throw reaches the outer catch and answers 500.
     * Measured against production after deploying it: an empty body returned
     * `500 {"error":"Restaurant id is required"}`, which is the resolver's message wearing the
     * wrong status code, not this route's guard.
     *
     * Dead code shaped like a guard is worse than no guard: it reads as covered.
     */
    if (!rawRestaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }

    let restaurantUuid: string
    try {
      restaurantUuid = await resolveRestaurantUuid(rawRestaurantId)
    } catch {
      // The resolver also throws `Restaurant not found for id=...`, which is a 404, not a 500.
      return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
    }

    const auth = await requireStaffPermission(restaurantUuid, PERMISSIONS.TABLES_MANAGE, req)
    if (isAuthError(auth)) return auth

    const supabase = createServerSupabaseClient()
    const { requestId } = await params

    const result = await releaseStrandedClaim(supabase, requestId, {
      restaurantId: restaurantUuid,
      actor: { surface: 'dashboard' },
    })

    if (!result.ok) {
      const payload: Record<string, unknown> = { error: result.error }
      if (result.code) payload.code = result.code
      if (result.currentStatus) payload.status = result.currentStatus
      return NextResponse.json(payload, { status: result.status })
    }

    return NextResponse.json({ success: true, id: result.id, status: result.status })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to release request'
    console.error('[order-requests/release] failed', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
