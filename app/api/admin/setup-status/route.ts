import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
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

/**
 * Non-throwing restaurant lookup (mirrors app/api/auth/role's resolveRestaurantId) --
 * a signed-in user with no restaurant (e.g. a platform-admin-only account) is a normal,
 * expected case here, not a server error.
 */
async function resolveRestaurantIdOrNull(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  userId: string,
): Promise<string | null> {
  const { data: membership, error: membershipError } = await supabase
    .from('restaurant_users')
    .select('restaurant_id')
    .eq('user_id', userId)
    .is('deleted_at', null)
    .maybeSingle()

  if (membershipError) throw membershipError
  if (membership?.restaurant_id) {
    return String(membership.restaurant_id)
  }

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .select('id')
    .eq('owner_id', userId)
    .limit(1)
    .maybeSingle()

  if (restaurantError) throw restaurantError
  return restaurant?.id ? String(restaurant.id) : null
}

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await resolveRestaurantIdOrNull(supabase, user.id)
    if (!restaurantId) {
      return NextResponse.json({ hasRestaurant: false })
    }

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.SETTINGS_WRITE)
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
      hasRestaurant: true,
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
    const restaurantId = await resolveRestaurantIdOrNull(supabase, user.id)
    if (!restaurantId) {
      return NextResponse.json({ hasRestaurant: false })
    }

    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.SETTINGS_WRITE)
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
