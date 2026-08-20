import { NextResponse } from 'next/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const restaurantId = searchParams.get('restaurantId') || ''

  if (!restaurantId.trim()) {
    return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
  }

  const restaurantUuid = await resolveRestaurantUuid(restaurantId)

  const auth = await requireStaffPermission(restaurantUuid, PERMISSIONS.ANALYTICS_VIEW, req)
  if (isAuthError(auth)) return auth

  // #323: paid orders for a whole restaurant with NO date bound -- 740 for FNB ChowNow today.
  // The try/catch is not decoration: this handler had none, so once fetchAllRows can throw, an
  // unhandled failure would leave as a zero-length 500 -- the #322 shape all over again.
  try {
    const orders = await fetchAllRows<Record<string, unknown>>(
      auth.supabase
        .from('orders')
        .select('*')
        .eq('restaurant_id', restaurantUuid)
        .eq('payment_status', 'paid'),
      { label: 'orders-summary' },
    )
    return NextResponse.json({ orders })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[analytics/orders-summary] failed', { restaurantUuid, error: err })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
