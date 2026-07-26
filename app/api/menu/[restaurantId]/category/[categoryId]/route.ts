import { NextResponse } from 'next/server'
import { getCachedMenu, setCachedMenu } from '@/lib/cache/menu-cache'
import { getSupabaseMenuItemsByCategory } from '@/lib/supabase/menu'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'

export const dynamic = 'force-dynamic'

/**
 * Public guest-menu endpoint (QR /browse, kiosk). Intentionally unauthenticated —
 * restaurantId is in the URL by design for customer-facing menus.
 *
 * Tightening (vs prior open scrape): category must belong to the given restaurant
 * or we 404 before returning items. Items query already filters by both IDs.
 *
 * Terminal POS also calls this with a Bearer token; auth is optional and unused
 * so guest browse keeps working.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ restaurantId: string; categoryId: string }> }
) {
  const { restaurantId, categoryId } = await context.params

  if (!restaurantId || !categoryId) {
    return NextResponse.json({ error: 'Missing restaurantId/categoryId' }, { status: 400 })
  }

  try {
    const restaurantUuid = await resolveRestaurantUuid(restaurantId)
    const supabase = createServerSupabaseClient()
    const { data: category, error: categoryError } = await supabase
      .from('menu_categories')
      .select('id')
      .eq('id', categoryId)
      .eq('restaurant_id', restaurantUuid)
      .maybeSingle()

    if (categoryError) {
      console.error('[MENU API] category ownership check failed:', categoryError)
      return NextResponse.json({ error: 'Failed to load menu' }, { status: 500 })
    }
    if (!category) {
      return NextResponse.json({ error: 'Category not found' }, { status: 404 })
    }

    const cached = await getCachedMenu(restaurantId, categoryId)
    const cachedHasItems =
      cached &&
      typeof cached === 'object' &&
      Object.values(cached as Record<string, { items?: unknown[] }>).some(
        (group) => Array.isArray(group?.items) && group.items.length > 0
      )
    if (cachedHasItems) {
      return NextResponse.json(cached)
    }

    const payload = await getSupabaseMenuItemsByCategory(restaurantId, categoryId, true)
    const payloadHasItems = Object.values(payload).some((group) => group.items.length > 0)
    if (payloadHasItems) {
      await setCachedMenu(restaurantId, payload, categoryId)
    }
    return NextResponse.json(payload)
  } catch (error) {
    console.error('[MENU API] Failed to fetch category menu:', error)
    return NextResponse.json({ error: 'Failed to load menu' }, { status: 500 })
  }
}
