import { NextResponse } from 'next/server'
import { createPaymentRequest } from '@/payments/paycloud'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const supabase = createServerSupabaseClient()

  try {
    const body = await req.json()
    const restaurantId = String(body.restaurantId || '').trim()
    const tableNumber = Number(body.tableNumber)
    const orderIds: string[] = Array.isArray(body.orderIds)
      ? body.orderIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const sortedOrderIds = [...orderIds].sort()
    const clientAmount = Number(body.amount)

    if (!restaurantId || !Number.isFinite(tableNumber) || tableNumber <= 0) {
      return NextResponse.json({ ok: false, error: 'Invalid restaurant or table' }, { status: 400 })
    }
    if (orderIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'No orders to pay' }, { status: 400 })
    }

    const { data: orders } = await supabase
      .from('orders')
      .select('*')
      .eq('firebase_restaurant_id', restaurantId)
      .eq('table_number', Number(tableNumber))
      .eq('is_closed', false)
      .order('placed_at', { ascending: true })

    const byId = new Map((orders || []).map((o: any) => [String(o.id), o]))
    let sum = 0
    for (const orderId of sortedOrderIds) {
      const data = byId.get(orderId)
      if (!data) {
        return NextResponse.json({ ok: false, error: `Order not found: ${orderId}` }, { status: 404 })
      }
      if (Number(data.table_number) !== tableNumber) {
        return NextResponse.json({ ok: false, error: 'Order does not match this table' }, { status: 400 })
      }
      if (data.is_closed === true) {
        return NextResponse.json({ ok: false, error: 'Cannot pay for a closed order' }, { status: 400 })
      }
      if (data.payment_status === 'paid') {
        return NextResponse.json({ ok: false, error: 'An order is already paid' }, { status: 400 })
      }
      sum += Number(data.total) || 0
    }

    const roundedSum = Math.round(sum * 100) / 100
    const roundedClient = Math.round(clientAmount * 100) / 100
    if (Math.abs(roundedSum - roundedClient) > 0.02) {
      return NextResponse.json(
        { ok: false, error: 'Amount does not match order total. Please refresh and try again.' },
        { status: 400 }
      )
    }

    const attemptNonce = String(Date.now()).slice(-8)
    const merchantOrderNo = `${restaurantId}:receipt:${sortedOrderIds.join(',')}@${attemptNonce}`

    const payment = await createPaymentRequest({
      amount: roundedSum,
      orderId: merchantOrderNo,
      description: `FlashTap receipt - Table ${tableNumber} (${sortedOrderIds.length} order${sortedOrderIds.length > 1 ? 's' : ''})`,
    })

    let tn: string | null = null
    try {
      tn = new URL(payment.checkoutUrl).searchParams.get('tn')
    } catch {
      tn = null
    }

    if (tn) {
      await Promise.all(
        sortedOrderIds.map(async (id) => {
          await supabase
            .from('orders')
            .update({
              payment_status: 'pending',
              payment_provider: 'paycloud',
              payment_reference: merchantOrderNo,
              paycloud_merchant_order_no: tn,
              payment_checkout_url: payment.checkoutUrl,
            })
            .eq('id', id)
        })
      )
    }

    return NextResponse.json(
      {
        ok: true,
        paymentStatus: payment.paymentStatus,
        requires3ds: payment.requires3ds,
        checkoutUrl: payment.checkoutUrl,
        merchantOrderNo,
      },
      {
        status: 201,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Payment failed'
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
