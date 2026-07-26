import { NextResponse } from 'next/server'
import { invalidateMenuCache } from '@/lib/cache/menu-cache'
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

    await invalidateMenuCache(restaurantId)
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[MENU CACHE] Invalidate endpoint failed:', error)
    return NextResponse.json({ error: 'Failed to invalidate menu cache' }, { status: 500 })
  }
}
