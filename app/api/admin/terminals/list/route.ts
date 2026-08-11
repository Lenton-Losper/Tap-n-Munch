import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.PAYMENTS_VIEW)
    if (denied) return denied

    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select('id, terminal_name, device_serial, model, status, activation_code, activation_code_expires_at')
      .eq('restaurant_id', restaurantId)
      // 'pending' is what generate-code writes for a terminal that has a code but has not
      // activated yet (#193). Omitting it hid the row for the whole onboarding window.
      .in('status', ['active', 'inactive', 'pending'])
      .order('created_at', { ascending: false })

    if (error) throw error
    return NextResponse.json({ terminals: data || [] })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load terminals'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
