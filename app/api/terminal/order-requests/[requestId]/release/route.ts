import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

/**
 * #120's RESIDUAL — THE ESCAPE HATCH FOR A STRANDED CLAIM.
 *
 * WHY THIS EXISTS. #120 made an undecided `order_requests` row block settle and close, correctly:
 * the alternative was a round silently missing from the bill and then re-inflating a tab that had
 * already been paid and closed. But the blocking set includes `accepting`, the TRANSIENT claim the
 * accept route takes at `accept/route.ts:74` and releases at `:155`. If the worker dies between
 * those two lines the row stays claimed, and its own comment says so — "stranded in 'accepting'
 * forever".
 *
 * Before #120 that was invisible: wrong, but quiet. Now it HOLDS A BILL OPEN — staff cannot settle
 * or close the table, and nothing anywhere clears it. #215 records why there is no reaper: without
 * a timestamp on the claim, nothing can distinguish a claim made two seconds ago from one made
 * yesterday.
 *
 * So this is a MANUAL escape hatch, not the reaper. It is what makes a stuck table recoverable
 * tonight rather than after #215 lands.
 *
 * WHAT IT DOES, AND THE THREE THINGS IT DELIBERATELY DOES NOT
 *
 *   RELEASES TO `waiting_review`, NEVER `accepted`. A dead worker proves nothing about whether the
 *   round was wanted. Releasing to `accepted` would create an order nobody decided on; releasing to
 *   `declined` would throw away a round the customer really placed. `waiting_review` puts it back
 *   in front of staff, which is where an undecided round belongs.
 *
 *   REFUSES ANYTHING THAT IS NOT `accepting`. The conditional `.eq('status', 'accepting')` is the
 *   guard, not the read above it — two staff pressing the button at once, or a worker finishing its
 *   release while the button is in flight, must not both take effect. Whoever loses matches no row
 *   and is told so. A `waiting_review` row is a REAL round awaiting a decision, and letting this
 *   dismiss one would be the #120 bug again from the other side.
 *
 *   TOUCHES NOTHING ELSE. No order, no tab, no amount, no settlement. One status column on one row.
 *
 * NO MIGRATION. `order_requests_status_check` already permits `waiting_review` — verified against
 * production: CHECK (status = ANY (ARRAY['waiting_review','accepting','accepted','declined'])).
 *
 * THE KNOWN COST, accepted by the owner 2026-08-25: without #215's claim timestamp this can release
 * a claim that is still legitimately in flight. The accept route would then fail its own conditional
 * release and log it. That is recoverable and audited, and a stuck table is worse.
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
    const normalizedId = String(requestId ?? '').trim()
    if (!normalizedId) {
      return NextResponse.json({ error: 'Missing request id' }, { status: 400 })
    }

    /**
     * Read first, so a refusal can say WHICH of the several reasons applies rather than answering
     * one opaque 409. The read does not authorise anything — the conditional update below does.
     */
    const { data: row, error: loadError } = await supabase
      .from('order_requests')
      .select('id, restaurant_id, tab_id, table_id, status')
      .eq('id', normalizedId)
      .maybeSingle()

    if (loadError) {
      console.error('[terminal/order-requests/release] load failed', loadError)
      return NextResponse.json({ error: 'Could not read this request. Try again.' }, { status: 503 })
    }
    if (!row) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    }
    /** Cross-tenant: a terminal may only touch its own restaurant's rows. */
    if (String(row.restaurant_id) !== String(terminal.restaurantId)) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 })
    }
    if (String(row.status) !== 'accepting') {
      return NextResponse.json(
        {
          error: `This request is not a stranded claim (it is ${String(row.status)}). Only a request stuck mid-accept can be released.`,
          code: 'NOT_A_STRANDED_CLAIM',
          status: row.status,
        },
        { status: 409 },
      )
    }

    /**
     * THE CONDITIONAL CLAIM, and it is the whole safety of this route. `.eq('status','accepting')`
     * is evaluated by the database at write time, so a worker that finishes its own release a
     * millisecond earlier wins and this matches zero rows.
     */
    const { data: released, error: updateError } = await supabase
      .from('order_requests')
      .update({ status: 'waiting_review' })
      .eq('id', normalizedId)
      .eq('status', 'accepting')
      .select('id, status')
      .maybeSingle()

    if (updateError) {
      console.error('[terminal/order-requests/release] update failed', updateError)
      return NextResponse.json({ error: 'Could not release this request. Try again.' }, { status: 503 })
    }
    if (!released) {
      /**
       * Someone else got there first — almost always the accept route's own release completing.
       * That is a GOOD outcome, not an error: the row is no longer stranded either way.
       */
      return NextResponse.json(
        {
          error: 'This request was resolved by something else while you were releasing it. Refresh the table.',
          code: 'ALREADY_RESOLVED',
        },
        { status: 409 },
      )
    }

    /**
     * Audited, and the trail write must never be able to fail the release it records — the same
     * rule the payment trails follow. A stuck table that was freed but not logged is strictly
     * better than one that stayed stuck because the log was down.
     */
    try {
      await supabase.from('audit_logs').insert({
        restaurant_id: terminal.restaurantId,
        action: 'order_request.claim_released',
        entity_type: 'order_request',
        entity_id: normalizedId,
        metadata: {
          terminalId: terminal.terminalId,
          from: 'accepting',
          to: 'waiting_review',
          tabId: row.tab_id ?? null,
          tableId: row.table_id ?? null,
          reason: 'staff released a stranded accept claim (#120 residual, manual escape hatch)',
        },
      })
    } catch (auditError) {
      console.error('[terminal/order-requests/release] audit write failed', auditError)
    }

    return NextResponse.json({ success: true, id: released.id, status: released.status })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to release request'
    console.error('[terminal/order-requests/release] failed', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
