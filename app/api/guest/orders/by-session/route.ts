import { NextResponse } from 'next/server'
import { fetchGuestOrdersBySession } from '@/lib/guest-orders/queries'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const restaurantId = searchParams.get('restaurantId')?.trim() || ''
    // The customer app holds two session ids in different namespaces (see
    // fetchGuestOrdersBySession); accept every one the client can supply, as repeated
    // params or comma-separated, so a lookup is not silently scoped to the wrong one.
    const sessionIds = [
      ...searchParams.getAll('session_id'),
      ...searchParams.getAll('sessionId'),
    ]
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean)
    const sessionId = sessionIds[0] || ''
    const tabId = searchParams.get('tabId')?.trim() || ''
    const countOnly = searchParams.get('countOnly') === '1'
    const excludeSettlement = searchParams.get('excludeSettlement') !== '0'

    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }
    if (!sessionId) {
      return NextResponse.json({ error: 'session_id is required' }, { status: 400 })
    }
    // tabId is optional refinement only — never sufficient alone for a dump.
    void tabId

    const { orders, count } = await fetchGuestOrdersBySession({
      restaurantId,
      sessionId: sessionId || null,
      sessionIds,
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
