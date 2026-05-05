import { NextResponse } from 'next/server'
import { invalidateMenuCache } from '@/lib/cache/menu-cache'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
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
