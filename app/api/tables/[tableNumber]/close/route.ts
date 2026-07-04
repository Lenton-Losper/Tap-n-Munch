import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { closeTableSession } from '@/lib/session-manager'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'

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

    await supabase
      .from('orders')
      .update({
        is_closed: true,
        table_closed: true,
        status: 'completed',
        payment_status: 'paid',
        paid_at: nowIso,
        completed_at: nowIso,
      })
      .eq('restaurant_id', restaurantUuid)
      .eq('table_number', parsedTableNumber)
      .eq('is_closed', false)

    return NextResponse.json({ success: true, ...(rpcResult as Record<string, unknown>) })
  } catch (err: unknown) {
    console.error('[TABLE-CLOSE]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to close table' },
      { status: 500 }
    )
  }
}
