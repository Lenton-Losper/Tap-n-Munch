import { NextResponse } from 'next/server'
import { fetchGuestOrdersByPaymentRef } from '@/lib/guest-orders/queries'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const paymentRef = searchParams.get('ref')?.trim() || searchParams.get('tn')?.trim() || ''
    const restaurantId = searchParams.get('restaurantId')?.trim() || null

    if (!paymentRef) {
      return NextResponse.json({ error: 'ref is required' }, { status: 400 })
    }

    const orders = await fetchGuestOrdersByPaymentRef({ paymentRef, restaurantId })

    return NextResponse.json({ orders, count: orders.length })
  } catch (err) {
    console.error('[guest/orders/by-payment-ref] GET failed:', err)
    return NextResponse.json({ error: 'Failed to load orders by payment reference' }, { status: 500 })
  }
}
