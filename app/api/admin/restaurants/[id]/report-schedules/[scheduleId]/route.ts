import { NextResponse } from 'next/server'
import {
  getUserFromRequest,
  requireCallerRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

// PATCH — update a schedule (toggle enabled, change email/format/time)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; scheduleId: string }> }
) {
  try {
    const user = await getUserFromRequest(request)
    const { id, scheduleId } = await params
    const body = await request.json()

    const allowed = ['enabled', 'email', 'format', 'send_time', 'timezone']
    const updates: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in body) updates[key] = body[key]
    }
    if ('format' in updates && updates.format !== 'pdf' && updates.format !== 'csv') {
      return NextResponse.json({ error: 'format must be pdf or csv' }, { status: 400 })
    }
    updates.updated_at = new Date().toISOString()

    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, id)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.SETTINGS_WRITE)
    if (denied) return denied

    const { data, error } = await supabase
      .from('report_schedules')
      .update(updates)
      .eq('id', scheduleId)
      .eq('restaurant_id', restaurantId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ schedule: data })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to update schedule'
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

// DELETE — remove a schedule
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; scheduleId: string }> }
) {
  try {
    const user = await getUserFromRequest(request)
    const { id, scheduleId } = await params
    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, id)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.SETTINGS_WRITE)
    if (denied) return denied

    const { error } = await supabase
      .from('report_schedules')
      .delete()
      .eq('id', scheduleId)
      .eq('restaurant_id', restaurantId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to delete schedule'
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
