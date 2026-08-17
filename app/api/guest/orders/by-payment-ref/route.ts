import { NextResponse } from 'next/server'
import { fetchGuestOrdersByPaymentRef } from '@/lib/guest-orders/queries'
import { parseOptionalInt } from '@/lib/guest-orders/validation'

export const dynamic = 'force-dynamic'

/**
 * Guest lookup of the orders behind a payment reference, used by /order-confirmation when the
 * gateway redirects back with ?tn=<merchant_order_no>.
 *
 * Same access contract as the sibling guest routes (app/api/guest/orders/[orderId]/receipt):
 * restaurantId is required, and each row is gated through guestCanAccessOrder — an open order
 * needs the table or session that placed it, a paid/closed one is reachable on restaurant scope
 * alone (the shareable receipt-link pattern). The gateway return URL carries rid and table
 * (payments/paycloud.js -> paycloudCheckoutReturnUrlWithTn), so the legitimate caller has both.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const paymentRef = searchParams.get('ref')?.trim() || searchParams.get('tn')?.trim() || ''
    const restaurantId =
      searchParams.get('restaurantId')?.trim() ||
      searchParams.get('restaurant_id')?.trim() ||
      searchParams.get('rid')?.trim() ||
      ''
    const tableNumber = parseOptionalInt(searchParams.get('table_number'))
    const sessionId = searchParams.get('session_id')?.trim() || null

    if (!paymentRef) {
      return NextResponse.json({ error: 'ref is required' }, { status: 400 })
    }
    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }

    const orders = await fetchGuestOrdersByPaymentRef({
      paymentRef,
      restaurantId,
      tableNumber,
      sessionId,
    })

    return NextResponse.json({ orders, count: orders.length })
  } catch (err) {
    console.error('[guest/orders/by-payment-ref] GET failed:', err)
    return NextResponse.json({ error: 'Failed to load orders by payment reference' }, { status: 500 })
  }
}
