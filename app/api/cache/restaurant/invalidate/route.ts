import { NextResponse } from 'next/server'
import { invalidateRestaurantCache } from '@/lib/cache/restaurant-cache'
import { requireStagingPlatformAdmin } from '@/lib/api/require-staging-platform-admin'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const denied = await requireStagingPlatformAdmin(request)
  if (denied) return denied

  try {
    const body = (await request.json()) as { restaurantId?: string }
    const restaurantId = body.restaurantId?.trim()
    if (!restaurantId) {
      return NextResponse.json({ error: 'Missing restaurantId' }, { status: 400 })
    }

    await invalidateRestaurantCache(restaurantId)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[RESTAURANT CACHE] Invalidate endpoint failed:', error)
    return NextResponse.json({ error: 'Failed to invalidate restaurant cache' }, { status: 500 })
  }
}
