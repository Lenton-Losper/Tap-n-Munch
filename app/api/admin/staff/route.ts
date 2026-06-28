import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseClient()
    const user = await getUserFromRequest(request)
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.STAFF_MANAGE)
    if (denied) return denied

    const { data, error } = await supabase
      .from('restaurant_users')
      .select('id, user_id, role, invite_accepted, created_at, users(email, name)')
      .eq('restaurant_id', restaurantId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })

    if (error) throw error
    return NextResponse.json({ staff: data ?? [] })
  } catch (err) {
    console.error('[staff] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
