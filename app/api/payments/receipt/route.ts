import { NextResponse } from 'next/server'
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase/config'
import { orderPath } from '@/lib/firebase/paths'
import { createPaymentRequest } from '@/payments/paycloud'

function getTermIp(req: Request) {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return req.headers.get('x-real-ip') || '127.0.0.1'
}

export async function POST(req: Request) {
  try {
    if (!db) {
      return NextResponse.json({ ok: false, error: 'Database not configured' }, { status: 503 })
    }

    const body = await req.json()
    const restaurantId = String(body.restaurantId || '').trim()
    const tableNumber = Number(body.tableNumber)
    const orderIds: string[] = Array.isArray(body.orderIds)
      ? body.orderIds.map((id: unknown) => String(id).trim()).filter(Boolean)
      : []
    const clientAmount = Number(body.amount)
    const card = body.card

    if (!restaurantId || !Number.isFinite(tableNumber) || tableNumber <= 0) {
      return NextResponse.json({ ok: false, error: 'Invalid restaurant or table' }, { status: 400 })
    }
    if (orderIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'No orders to pay' }, { status: 400 })
    }
    if (!card?.cardNo || !card?.cvv || !card?.expireMonth || !card?.expireYear) {
      return NextResponse.json({ ok: false, error: 'Complete card details are required' }, { status: 400 })
    }

    let sum = 0
    for (const orderId of orderIds) {
      const snap = await getDoc(doc(db, orderPath(restaurantId, orderId)))
      if (!snap.exists()) {
        return NextResponse.json({ ok: false, error: `Order not found: ${orderId}` }, { status: 404 })
      }
      const data = snap.data() as Record<string, unknown>
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
    const merchantOrderNo = `${restaurantId}:receipt:${orderIds.join(',')}`

    const payment = await createPaymentRequest({
      amount: roundedSum,
      orderId: merchantOrderNo,
      description: `FlashTap receipt — Table ${tableNumber} (${orderIds.length} order${orderIds.length > 1 ? 's' : ''})`,
      card: {
        cardNo: String(card.cardNo).replace(/\s+/g, ''),
        cvv: String(card.cvv),
        expireMonth: String(card.expireMonth).padStart(2, '0'),
        expireYear: String(card.expireYear),
        cardHolder: String(card.cardHolder || 'Customer').trim(),
        termIp: getTermIp(req),
      },
      termIp: getTermIp(req),
      attach: { source: 'receipt', tableNumber: String(tableNumber), orderIds },
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
