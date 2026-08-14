import { NextResponse } from 'next/server'
import { fetchGuestActiveTableOrders } from '@/lib/guest-orders/queries'
import { parseOptionalInt } from '@/lib/guest-orders/validation'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const restaurantId = searchParams.get('restaurantId')?.trim() || ''
    const tableNumber = parseOptionalInt(searchParams.get('table_number'))
    const sessionId = searchParams.get('session_id')?.trim() || searchParams.get('sessionId')?.trim() || ''
    const paymentStatus = searchParams.get('payment_status')?.trim() || null
    const paymentChannel = searchParams.get('payment_channel')?.trim() || null
    const placedAfter = searchParams.get('placed_after')?.trim() || null
    const placedBefore = searchParams.get('placed_before')?.trim() || null
    const countOnly = searchParams.get('countOnly') === '1'

    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }
    if (tableNumber == null || tableNumber <= 0) {
      return NextResponse.json({ error: 'table_number is required' }, { status: 400 })
    }

    const { orders, count } = await fetchGuestActiveTableOrders({
      restaurantId,
      tableNumber,
      sessionId: sessionId || null,
      sessionIds: searchParams.getAll('session_id'),
      paymentStatus,
      paymentChannel,
      placedAfter,
      placedBefore,
      countOnly,
    })

    if (countOnly) {
      return NextResponse.json({ orders: [], count })
    }

    return NextResponse.json({ orders, count })
  } catch (err) {
    console.error('[guest/orders/active-table] GET failed:', err)
    return NextResponse.json({ error: 'Failed to load table orders' }, { status: 500 })
  }
}
