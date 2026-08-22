import { NextResponse } from 'next/server'
import { fetchGuestActiveTableOrders } from '@/lib/guest-orders/queries'
import { parseOptionalInt } from '@/lib/guest-orders/validation'
import { projectTablemateOrder } from '@/lib/guest-orders/tablemate-projection'

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

    /**
     * #279, ruled 2026-08-22. The table number is NECESSARY, not SUFFICIENT: it scopes the query,
     * it never authorises it. Refused here, before any query runs, so `countOnly` cannot report
     * existence either -- that was the live leak.
     */
    const heldIds = [
      ...new Set(
        [sessionId, ...searchParams.getAll('session_id'), ...searchParams.getAll('sessionId')]
          .map((v) => String(v ?? '').trim())
          .filter(Boolean),
      ),
    ]
    if (heldIds.length === 0) {
      return NextResponse.json(
        { error: 'A session is required to read the orders at this table.', code: 'SESSION_REQUIRED' },
        { status: 403 },
      )
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

    // Hard redaction: an explicit allowlist, not select('*') minus one field. A column added to
    // `orders` later is private here by default.
    return NextResponse.json({ orders: orders.map((o) => projectTablemateOrder(o)), count })
  } catch (err) {
    console.error('[guest/orders/active-table] GET failed:', err)
    return NextResponse.json({ error: 'Failed to load table orders' }, { status: 500 })
  }
}
