import { NextResponse } from 'next/server'
import {
  getUserFromRequest,
  requireCallerRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

// GET — fetch all schedules for this restaurant
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getUserFromRequest(request)
    const { id } = await params
    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, id)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.SETTINGS_READ)
    if (denied) return denied

    const { data, error } = await supabase
      .from('report_schedules')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return NextResponse.json({ schedules: data ?? [] })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to fetch schedules'
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

// POST — create a new schedule for this restaurant
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getUserFromRequest(request)
    const { id } = await params
    const body = await request.json()
    const { email, format, send_time, timezone, enabled } = body

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'email is required' }, { status: 400 })
    }
    if (!['pdf', 'csv'].includes(format)) {
      return NextResponse.json({ error: 'format must be pdf or csv' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(supabase, user.id, id)
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.SETTINGS_WRITE)
    if (denied) return denied

    const { data, error } = await supabase
      .from('report_schedules')
      .insert({
        restaurant_id: restaurantId,
        email,
        format,
        send_time: send_time ?? '20:00',
        timezone: timezone ?? 'Africa/Windhoek',
        enabled: enabled ?? true,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ schedule: data })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to create schedule'
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
