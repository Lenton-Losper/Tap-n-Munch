import { NextResponse } from 'next/server'
import { fetchGuestOrderById } from '@/lib/guest-orders/queries'
import { parseOptionalInt } from '@/lib/guest-orders/validation'

export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ orderId: string }> }

export async function GET(request: Request, { params }: RouteParams) {
  try {
    const { orderId } = await params
    const trimmedId = String(orderId || '').trim()
    if (!trimmedId) {
      return NextResponse.json({ error: 'orderId is required' }, { status: 400 })
    }

    const { searchParams } = new URL(request.url)
    const restaurantId =
      searchParams.get('restaurantId')?.trim() || searchParams.get('restaurant_id')?.trim() || ''
    const tableNumber = parseOptionalInt(searchParams.get('table_number'))
    const sessionId = searchParams.get('session_id')

    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }

    const { order, denied } = await fetchGuestOrderById(trimmedId, {
      restaurantId,
      tableNumber,
      sessionId,
    })

    if (!order) {
      return NextResponse.json(
        { error: denied ? 'Order not accessible' : 'Order not found' },
        { status: 404 },
      )
    }

    return NextResponse.json({ orders: [order] })
  } catch (err) {
    console.error('[guest/orders/:orderId] GET failed:', err)
    return NextResponse.json({ error: 'Failed to load order' }, { status: 500 })
  }
}
