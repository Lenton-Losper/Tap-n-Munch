import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  getUserFromRequest,
  requireCallerRestaurantId,
} from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

const ALLOWED_PROFILE_FIELDS = ['name', 'phone', 'logo_url'] as const

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = (await request.json()) as {
      restaurantId?: string
      updates?: Record<string, unknown>
    }
    const requestedRestaurantId = String(body?.restaurantId || '').trim()
    const updates = body?.updates || {}

    if (!requestedRestaurantId) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantCheck = await requireCallerRestaurantId(
      supabase,
      user.id,
      requestedRestaurantId,
    )
    if (restaurantCheck instanceof NextResponse) return restaurantCheck
    const restaurantId = restaurantCheck

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.SETTINGS_WRITE)
    if (denied) return denied

    const sanitized: Record<string, unknown> = {}
    for (const key of ALLOWED_PROFILE_FIELDS) {
      if (key in updates) sanitized[key] = updates[key]
    }
    if (Object.keys(sanitized).length === 0) {
      return NextResponse.json({ error: 'No valid updates provided' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('restaurants')
      .update({ ...sanitized, updated_at: new Date().toISOString() })
      .eq('id', restaurantId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ success: true, data })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update restaurant settings'
    const status =
      message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
