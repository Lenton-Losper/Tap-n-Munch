import { NextResponse } from 'next/server'
import { fetchGuestOrdersBySession } from '@/lib/guest-orders/queries'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const restaurantId = searchParams.get('restaurantId')?.trim() || ''
    const sessionId = searchParams.get('session_id')?.trim() || searchParams.get('sessionId')?.trim() || ''
    const tabId = searchParams.get('tabId')?.trim() || ''
    const countOnly = searchParams.get('countOnly') === '1'
    const excludeSettlement = searchParams.get('excludeSettlement') !== '0'

    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }
    if (!sessionId && !tabId) {
      return NextResponse.json({ error: 'session_id or tabId is required' }, { status: 400 })
    }

    const { orders, count } = await fetchGuestOrdersBySession({
      restaurantId,
      sessionId: sessionId || null,
      tabId: tabId || null,
      excludeSettlement,
      countOnly,
    })

    if (countOnly) {
      return NextResponse.json({ orders: [], count })
    }

    return NextResponse.json({ orders, count })
  } catch (err) {
    console.error('[guest/orders/by-session] GET failed:', err)
    return NextResponse.json({ error: 'Failed to load session orders' }, { status: 500 })
  }
}
