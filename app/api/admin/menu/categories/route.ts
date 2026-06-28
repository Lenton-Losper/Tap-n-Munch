import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  getRestaurantIdForUser,
  getUserFromRequest,
  resolveRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = await request.json()
    const restaurantInput = String(body?.restaurantId || body?.restaurant_id || '').trim()
    const name = String(body?.name || '').trim()

    if (!restaurantInput || !name) {
      return NextResponse.json(
        { error: 'Missing restaurantId and category name' },
        { status: 400 }
      )
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await resolveRestaurantId(supabase, restaurantInput)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.MENU_WRITE)
    if (denied) return denied

    const { data: existing, error: findError } = await supabase
      .from('menu_categories')
      .select('id, name')
      .eq('restaurant_id', restaurantId)
      .ilike('name', name)
      .maybeSingle()

    if (findError) throw findError
    if (existing?.id) {
      return NextResponse.json({ success: true, id: existing.id, data: existing, created: false })
    }

    const { data, error } = await supabase
      .from('menu_categories')
      .insert({
        restaurant_id: restaurantId,
        name,
        active: true,
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ success: true, id: data.id, data, created: true })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create category'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    return NextResponse.json({ error: message }, { status })
  }
}
