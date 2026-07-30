import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { closeTableSession } from '@/lib/session-manager'
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
    if (paidIds.length > 0) {
      const { error: paidErr } = await supabase
        .from('orders')
        .update({
          is_closed: true,
          table_closed: true,
          status: 'completed',
          completed_at: nowIso,
        })
        .in('id', paidIds)

      if (paidErr) {
        console.error('[TABLE-CLOSE] failed to complete paid orders', paidErr)
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
