import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { clearHeldForReview } from '@/lib/orders/clear-held-for-review'

export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/orders/held-for-review/clear
 *
 * The "clear all" action behind the Held for review panel. One press, one run: every held order at
 * the caller's own venue is re-queried against Finatic in this same request and resolved on the
 * answer. The decision logic, the positive control and the audit trail are all in
 * `lib/orders/clear-held-for-review.ts`; this file is the gate and the scope.
 *
 * THE BODY CARRIES NO ORDER IDS AND NO RESTAURANT ID, AND BOTH OMISSIONS ARE THE POINT.
 *
 * No order ids: the owner's guard is "re-query every order immediately before any write, in the
 * same run — not from a list gathered earlier". A list posted by a browser IS a list gathered
 * earlier; it was assembled when the dashboard last polled, which may have been minutes ago and two
 * terminal callbacks back. Accepting one would make the freshest part of the guard depend on the
 * staleness of a client. The action enumerates the held set itself and then re-reads each row again
 * immediately before touching it.
 *
 * No restaurant id: the scope is the session's own restaurant, resolved server-side.
 * `getRestaurantIdForUser` goes through the stored, server-validated active restaurant (#321), so a
 * user with two memberships still gets exactly the venue their screen is showing — and a caller
 * cannot name someone else's. The permission is then checked against THAT id, so the gate and the
 * blast radius are the same value.
 *
 * BEHIND `orders:update`. It cancels orders and marks orders paid; those are the same writes the
 * terminal's own status and settle routes make, and they carry this permission. It is deliberately
 * not a new permission: a new one defaults to nobody holding it, which would ship the button
 * invisible and be read as the feature not working.
 *
 * IDEMPOTENT WITHOUT A TOKEN. Two presses produce two runs, and the second finds nothing to do:
 * every write in the action re-asserts the order's `payment_status` inside the UPDATE itself, so a
 * second writer matches zero rows. See the module header. There is deliberately no in-memory
 * in-flight lock — worker isolates do not share one, so it would give the appearance of a guarantee
 * without providing it, while being able to refuse a legitimate second press.
 *
 * ALWAYS 200 WHEN THE RUN RAN. A run in which every order was skipped is not an error — it is a
 * result, and it is the result the caller most needs to render in full. Only auth, permission and a
 * failure to run at all get a non-2xx.
 */
export async function POST(request: Request) {
  let user: Awaited<ReturnType<typeof getUserFromRequest>>
  try {
    user = await getUserFromRequest(request)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Sign in again.'
    return NextResponse.json({ error: message }, { status: 401 })
  }

  try {
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.ORDERS_UPDATE)
    if (denied) return denied

    const summary = await clearHeldForReview(supabase, {
      restaurantId,
      requestedBy: user.id,
    })

    return NextResponse.json({ success: true, summary })
  } catch (err: unknown) {
    /**
     * Reached only when the held set itself could not be read — the action does not throw for a
     * per-order failure, by construction, because an all-or-nothing run across six gateway calls
     * discards five correct answers when the sixth times out.
     *
     * The message is deliberately NOT passed through to the client. It is a database error string,
     * it is not staff-facing copy, and the panel has its own signed-off-pending line for a request
     * that did not run.
     */
    console.error('[held-for-review/clear]', err)
    return NextResponse.json({ error: 'clear_run_failed' }, { status: 500 })
  }
}
