/**
 * GET /api/admin/setup-status
 *
 * docs/design-venue-setup-flow.md -- a computed view over four facts that already live
 * elsewhere, so a manager bringing up a new venue (Riviera, Sunday) does not need this
 * session's own knowledge of where each control is. Nothing here is stored; every field is
 * read fresh from the table that already owns it. This route is a dashboard and a router, not
 * a fifth place that owns setup state.
 *
 * station_screens_enabled is read-only here even for an owner -- that switch stays
 * super_admin-only (see app/admin/restaurants/[id]/constants.ts's own note on why), so this
 * route reports its state without offering a way to change it from the restaurant-admin side.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { getRestaurantFeatures } from '@/lib/features/get-restaurant-features'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.SETTINGS_READ)
    if (denied) return denied

    const [features, categoriesResult, terminalsResult, staffResult] = await Promise.all([
      getRestaurantFeatures(restaurantId),
      supabase.from('menu_categories').select('route_to').eq('restaurant_id', restaurantId),
      supabase
        .from('restaurant_terminals')
        .select('station_kind')
        .eq('restaurant_id', restaurantId)
        .neq('status', 'revoked'),
      supabase
        .from('staff_members')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', restaurantId)
        .eq('active', true),
    ])

    if (categoriesResult.error) throw categoriesResult.error
    if (terminalsResult.error) throw terminalsResult.error
    if (staffResult.error) throw staffResult.error

    const categories = (categoriesResult.data ?? []) as Array<{ route_to: string | null }>
    const routingSplit = { kitchen: 0, bar: 0, both: 0 }
    for (const category of categories) {
      const route = category.route_to || 'kitchen'
      if (route === 'kitchen' || route === 'bar' || route === 'both') {
        routingSplit[route] += 1
      }
    }
    // The exact shape tonight's incident was: categories exist, and not one of them routes
    // anywhere but the kitchen. A venue with genuinely no drinks would look identical to one
    // where nobody has touched routing yet -- both are worth a manager's five-second look, so
    // this flags rather than tries to guess which case it is.
    const routingNeedsAttention =
      categories.length > 0 && routingSplit.bar === 0 && routingSplit.both === 0

    const terminals = (terminalsResult.data ?? []) as Array<{ station_kind: string | null }>
    const pairedCount = terminals.filter((t) => t.station_kind != null).length

    const staffCount = staffResult.count ?? 0

    return NextResponse.json({
      station_screens_enabled: features?.station_screens_enabled === true,
      category_routing: {
        total: categories.length,
        kitchen: routingSplit.kitchen,
        bar: routingSplit.bar,
        both: routingSplit.both,
        needs_attention: routingNeedsAttention,
      },
      screen_pairing: {
        paired: pairedCount,
        total: terminals.length,
      },
      staff: {
        active_count: staffCount,
      },
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load setup status'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    console.error('[setup-status] failed:', error)
    return NextResponse.json({ error: message }, { status })
  }
}
