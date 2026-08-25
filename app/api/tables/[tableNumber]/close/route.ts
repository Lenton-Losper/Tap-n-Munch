import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { closeTableSession } from '@/lib/session-manager'
import { guardTableClose } from '@/lib/tabs/pending-order-requests'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { isPaidPaymentStatus } from '@/lib/payments/payment-integrity'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ tableNumber: string }> }
) {
  try {
    const { restaurantId } = await req.json()
    const { tableNumber } = await params
    const parsedTableNumber = Number(tableNumber)
    const restaurantUuid = await resolveRestaurantUuid(String(restaurantId || ''))

    const auth = await requireStaffPermission(restaurantUuid, PERMISSIONS.TABLES_MANAGE, req)
    if (isAuthError(auth)) return auth

    const supabase = createServerSupabaseClient()
    const nowIso = new Date().toISOString()

    console.log('[TABLE-CLOSE] closing table', {
      restaurantUuid,
      parsedTableNumber,
    })

    const { data: tableRow } = await supabase
      .from('restaurant_tables')
      .select('id')
      .eq('restaurant_id', restaurantUuid)
      .eq('table_number', parsedTableNumber)
      .maybeSingle()

    if (!tableRow?.id) {
      return NextResponse.json({ error: 'Table not found' }, { status: 404 })
    }

    /**
     * #120 — THE SAME GUARD THE TERMINAL CARRIES, and it should have been here from the start.
     *
     * #120 guarded `app/api/terminal/tables/[tableId]/close` and left THIS route alone, so the
     * staff dashboard went on closing tables over undecided `order_requests`. That is the original
     * defect, unfixed, on the surface staff use most: the round is missing from the bill, and when
     * it is finally accepted it re-inflates a tab that has already been paid and closed.
     *
     * The dashboard's Close button was also, accidentally, the only way out of a table the TERMINAL
     * had blocked — but it is the wrong way out, because it closes OVER the round rather than
     * releasing it. So this guard ships together with the dashboard's release button, never before
     * it.
     */
    const guard = await guardTableClose(supabase, {
      restaurantId: restaurantUuid,
      tableId: tableRow.id,
    })
    if (guard.blocked) {
      return NextResponse.json(guard.body, { status: guard.status })
    }

    const rpcResult = await closeTableSession({
      supabase,
      restaurantId: restaurantUuid,
      tableId: tableRow.id,
      closedBy: 'dashboard',
      source: 'dashboard',
    })

    // Closing a table is a HOUSEKEEPING action, not a payment action, so it must never
    // invent a payment. Orders that were genuinely paid are completed; everything else is
    // detached from the table with its real payment_status preserved, so money still owed
    // stays RECORDED rather than being silently written off as revenue.
    //
    // Deliberately not claiming "visible": setting is_closed=true removes the row from the
    // dashboard and guest views, which read through is_closed=false
    // (lib/supabase/orders.ts:75,:94,:193; app/api/orders/route.ts:595;
    // lib/dashboard/order-realtime.ts:25) and from the "Public can read open orders" RLS
    // policy (supabase/schema.sql:193). That is unchanged from the previous behaviour --
    // it also set is_closed=true -- but the debt is discoverable only by query, plus the
    // console.warn below. Surfacing an owed-money count to staff is follow-up work.
    //
    // lib/supabase/orders.ts:148-161 (closeSupabaseTableOrders) is the pre-existing correct
    // sibling this route had diverged from: it writes only is_closed/table_closed and
    // fabricates no payment.
    const { data: openOrders, error: readErr } = await supabase
      .from('orders')
      .select('id, payment_status')
      .eq('restaurant_id', restaurantUuid)
      .eq('table_number', parsedTableNumber)
      .eq('is_closed', false)

    if (readErr) {
      console.error('[TABLE-CLOSE] failed to read open orders', readErr)
      return NextResponse.json({ error: 'Failed to close table' }, { status: 500 })
    }

    // Partition in JS with the shared normaliser rather than a SQL .eq()/.neq():
    // PostgREST comparisons are byte-exact, so a stray 'Paid' or ' paid' would be
    // classified wrongly by the database.
    const paidIds: string[] = []
    const unpaidIds: string[] = []
    for (const order of openOrders ?? []) {
      const bucket = isPaidPaymentStatus(order.payment_status) ? paidIds : unpaidIds
      bucket.push(String(order.id))
    }

    // Genuinely paid -> close and complete.
    //
    // completed_at is set in a SEPARATE, guarded write rather than here. An order settled
    // earlier on the terminal already carries its real completion time; including
    // completed_at in this blanket update re-stamped it to the moment the table was closed,
    // destroying the true value and skewing any time-to-complete reporting.
    if (paidIds.length > 0) {
      const { error: paidErr } = await supabase
        .from('orders')
        .update({
          is_closed: true,
          table_closed: true,
          status: 'completed',
        })
        .in('id', paidIds)

      if (paidErr) {
        console.error('[TABLE-CLOSE] failed to complete paid orders', paidErr)
        return NextResponse.json({ error: 'Failed to close table' }, { status: 500 })
      }

      // Only stamp orders that have no completion time yet. `.is(null)` makes this a
      // per-row guard in the database, so an existing timestamp is never overwritten.
      const { error: completedAtErr } = await supabase
        .from('orders')
        .update({ completed_at: nowIso })
        .in('id', paidIds)
        .is('completed_at', null)

      if (completedAtErr) {
        console.error('[TABLE-CLOSE] failed to stamp completed_at', completedAtErr)
        return NextResponse.json({ error: 'Failed to close table' }, { status: 500 })
      }
    }

    // Not paid -> detach from the table ONLY. payment_status, paid_at, status and
    // completed_at are deliberately left untouched: an unpaid or cancelled order must
    // not become revenue just because someone closed a table.
    if (unpaidIds.length > 0) {
      const { error: unpaidErr } = await supabase
        .from('orders')
        .update({ is_closed: true, table_closed: true })
        .in('id', unpaidIds)

      if (unpaidErr) {
        console.error('[TABLE-CLOSE] failed to close unpaid orders', unpaidErr)
        return NextResponse.json({ error: 'Failed to close table' }, { status: 500 })
      }

      console.warn('[TABLE-CLOSE] closed with unpaid orders', {
        restaurantUuid,
        parsedTableNumber,
        unpaidCount: unpaidIds.length,
      })
    }

    return NextResponse.json({
      success: true,
      completed: paidIds.length,
      closedUnpaid: unpaidIds.length,
      ...(rpcResult as Record<string, unknown>),
    })
  } catch (err: unknown) {
    console.error('[TABLE-CLOSE]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to close table' },
      { status: 500 }
    )
  }
}
