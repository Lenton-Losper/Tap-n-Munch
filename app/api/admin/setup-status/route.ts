import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantIdForUser, getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { computeCompletionPercentage } from '@/lib/onboarding/setup-status'
import {
  ensureSetupStatusRow,
  markSetupStepComplete,
} from '@/lib/onboarding/setup-status-server'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'

export const dynamic = 'force-dynamic'

function errorStatus(message: string): number {
  if (message.includes('authorization') || message.includes('session')) return 401
  if (message.includes('permission')) return 403
  return 500
}

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.PAYMENTS_CONFIGURE)
    if (denied) return denied

    await ensureSetupStatusRow(supabase, restaurantId)

    const { data, error } = await supabase
      .from('restaurant_setup_status')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    if (error) throw error
    if (!data) {
      throw new Error('Failed to load setup status')
    }

    const completion_percentage =
      typeof data.completion_percentage === 'number'
        ? data.completion_percentage
        : computeCompletionPercentage(data)

    return NextResponse.json({
      ...data,
      completion_percentage,
      restaurant_id: restaurantId,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load setup status'
    return NextResponse.json({ error: message }, { status: errorStatus(message) })
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const body = await request.json()
    const flag = String(body?.flag || '').trim()

    if (!flag) {
      return NextResponse.json({ error: 'Missing flag' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.PAYMENTS_CONFIGURE)
    if (denied) return denied

    await markSetupStepComplete(supabase, restaurantId, flag as never)

    const { data } = await supabase
      .from('restaurant_setup_status')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .maybeSingle()

    return NextResponse.json({
      success: true,
      status: data,
      completion_percentage: data
        ? computeCompletionPercentage(data)
        : computeCompletionPercentage({ [flag]: true }),
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update setup status'
    return NextResponse.json({ error: message }, { status: errorStatus(message) })
  }
}
