import { NextResponse } from 'next/server'
import { orderPath } from '@/lib/firebase/paths'
import { createPaymentRequest } from '@/payments/paycloud'
import { adminDb } from '@/lib/firebase/admin-firestore'

const ADMIN_NOT_CONFIGURED =
  'Server configuration error: Firebase Admin not initialized. Add FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_B64 (recommended on Vercel) to environment variables and redeploy.'

async function fetchOrderData(
  fs: NonNullable<ReturnType<typeof adminDb>>,
  restaurantId: string,
  orderId: string
) {
  const snap = await fs.doc(orderPath(restaurantId, orderId)).get()
  if (!snap.exists) return null
  return snap.data() as Record<string, unknown>
}

export async function POST(req: Request) {
  const fs = adminDb()
  if (!fs) {
    return NextResponse.json({ ok: false, error: ADMIN_NOT_CONFIGURED }, { status: 503 })
  }

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
    let sum = 0
    for (const orderId of sortedOrderIds) {
      const data = await fetchOrderData(fs, restaurantId, orderId)
      if (!data) {
        return NextResponse.json({ ok: false, error: `Order not found: ${orderId}` }, { status: 404 })
      }
      const tn = Number(data.table_number)
      if (tn !== tableNumber) {
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

    const origin = new URL(req.url).origin
    const merchantOrderNo = `${restaurantId}:receipt:${sortedOrderIds.join(',')}`

    const payment = await createPaymentRequest({
      amount: roundedSum,
      orderId: merchantOrderNo,
      description: `FlashTap receipt — Table ${tableNumber} (${sortedOrderIds.length} order${sortedOrderIds.length > 1 ? 's' : ''})`,
      notifyUrl: `${origin}/api/webhooks/paycloud`,
      returnUrl: `${origin}/menu/${restaurantId}/receipt?table=${encodeURIComponent(String(tableNumber))}`,
    })

    return NextResponse.json(
      {
        ok: true,
        paymentStatus: payment.paymentStatus,
        requires3ds: payment.requires3ds,
        checkoutUrl: payment.checkoutUrl,
        merchantOrderNo,
      },
      { status: 201 }
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Payment failed'
    return NextResponse.json({ ok: false, error: message }, { status: 502 })
  }
}
