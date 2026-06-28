import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const VALID_ROLES = ['manager', 'cashier', 'waiter', 'kitchen']

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId: targetUserId } = await params
    const supabase = createServerSupabaseClient()
    const user = await getUserFromRequest(request)
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.STAFF_MANAGE)
    if (denied) return denied

    const body = await request.json()
    const newRole = String(body.role || '').toLowerCase()
    if (!VALID_ROLES.includes(newRole)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    }

    const { error } = await supabase
      .from('restaurant_users')
      .update({ role: newRole, updated_at: new Date().toISOString() })
      .eq('user_id', targetUserId)
      .eq('restaurant_id', restaurantId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[staff/patch] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId: targetUserId } = await params
    const supabase = createServerSupabaseClient()
    const user = await getUserFromRequest(request)
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.STAFF_MANAGE)
    if (denied) return denied

    // Soft delete
    const { error } = await supabase
      .from('restaurant_users')
      .update({ deleted_at: new Date().toISOString() })
      .eq('user_id', targetUserId)
      .eq('restaurant_id', restaurantId)
      .neq('role', 'owner') // cannot remove owner

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[staff/delete] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
