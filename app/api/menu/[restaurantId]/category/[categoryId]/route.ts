import { NextResponse } from 'next/server'
import { getCachedMenu, setCachedMenu } from '@/lib/cache/menu-cache'
import { getSupabaseMenuItemsByCategory } from '@/lib/supabase/menu'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ restaurantId: string; categoryId: string }> }
) {
  const { restaurantId, categoryId } = await context.params

  if (!restaurantId || !categoryId) {
    return NextResponse.json({ error: 'Missing restaurantId/categoryId' }, { status: 400 })
  }

  try {
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
