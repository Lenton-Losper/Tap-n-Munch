import { NextResponse } from 'next/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'

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

  const { data: orders, error } = await auth.supabase
    .from('orders')
    .select('*')
    .eq('restaurant_id', restaurantUuid)
    .eq('payment_status', 'paid')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ orders: orders ?? [] })
}
