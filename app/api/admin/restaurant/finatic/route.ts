import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export async function PATCH(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = await request.json()
    const merchantNo = String(body?.merchantNo || '').trim()
    const storeNo = String(body?.storeNo || '').trim()

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.PAYMENTS_CONFIGURE)
    if (denied) return denied

    const { error } = await supabase
      .from('restaurants')
      .update({
        finatic_merchant_no: merchantNo || null,
        finatic_store_no: storeNo || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', restaurantId)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to save account details'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
