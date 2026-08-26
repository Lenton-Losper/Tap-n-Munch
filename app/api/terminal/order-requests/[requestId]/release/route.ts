import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { releaseStrandedClaim } from '@/lib/order-requests/release-stranded-claim'

/**
 * #120's RESIDUAL — the TERMINAL's escape hatch for a claim stranded in `accepting`.
 *
 * THIS ROUTE OWNS AUTHENTICATION AND NOTHING ELSE. What may be released, what it becomes, and what
 * is refused all live in `lib/order-requests/release-stranded-claim.ts`, shared with the staff
 * dashboard's route. That split is deliberate and it is the lesson of #120 itself: the terminal and
 * the dashboard already had two close routes doing one job with the guard written into only one of
 * them, and the unguarded one went unnoticed for as long as it did precisely because the rule was
 * not in one place.
 *
 * WHY IT EXISTS. #120 made an undecided `order_requests` row block settle and close, correctly. But
 * the blocking set includes `accepting`, the transient claim `accept/route.ts` takes at :74 and
 * releases at :155. If the worker dies between those lines the row stays claimed — its own comment
 * says "stranded in 'accepting' forever" — and it now HOLDS A BILL OPEN. #215 records why there can
 * be no reaper: without a timestamp on the claim, nothing can tell a claim made two seconds ago
 * from one made yesterday.
 *
 * So this is a MANUAL escape hatch, not the reaper.
 *
 * THE KNOWN COST, accepted by the owner 2026-08-25: without #215's timestamp this can release a
 * claim still legitimately in flight. The accept route then fails its own conditional release and
 * logs it. That is recoverable and audited, and a stuck table is worse.
 */
export async function POST(req: Request, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { requestId } = await params
    const result = await releaseStrandedClaim(supabase, requestId, {
      restaurantId: terminal.restaurantId,
      actor: { terminalId: terminal.terminalId, surface: 'terminal' },
    })

    if (!result.ok) {
      const body: Record<string, unknown> = { error: result.error }
      if (result.code) body.code = result.code
      if (result.currentStatus) body.status = result.currentStatus
      return NextResponse.json(body, { status: result.status })
    }

    return NextResponse.json({ success: true, id: result.id, status: result.status })
  } catch (err) {
    /*
     * A THROWN `Response` IS RETURNED UNCHANGED, and this route was the only terminal caller that
     * did not do it. `requireTerminalAuth` and `validateTerminalRecord` throw a `Response` already
     * carrying the right status — 401 for a missing or invalid token, 403 for a terminal that is
     * not active. Without this line every one of those became a 500 whose body was the Response
     * object stringified, so even the ORDINARY missing-header case was mis-reported.
     *
     * The device reads 401 as "refresh the token and retry" and 500 as nothing it can act on, so
     * this is the difference between a terminal recovering from an expired token and a terminal
     * that cannot release a stranded claim until someone restarts the app.
     *
     * `err instanceof Error` does NOT catch a Response — it is not an Error subclass — which is
     * why the existing line below silently produced 'Failed to release request'.
     */
    if (err instanceof Response) return err
    const message = err instanceof Error ? err.message : 'Failed to release request'
    console.error('[terminal/order-requests/release] failed', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
