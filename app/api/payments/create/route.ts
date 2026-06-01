// @ts-nocheck
import { NextResponse } from 'next/server'
import { createPaymentRequest } from '@/payments/paycloud'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const amount = Number(body.amount)
    const note = String(body.note || '').trim()
    const merchantName = String(body.merchantName || 'FlashTap Pay Merchant').trim()

    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 })
    }

    const merchantNo = String(body.merchantNo || '').trim()
    const storeNo = String(body.storeNo || '').trim()
    if (!merchantNo || !storeNo) {
      return NextResponse.json(
        { error: 'merchantNo and storeNo are required (Finatic credentials for the restaurant)' },
        { status: 400 }
      )
    }

    const orderId = `flashtap-pay:${Date.now()}`
    const payment = await createPaymentRequest({
      amount,
      orderId,
      merchantNo,
      storeNo,
      description: note || `FlashTap Pay - ${merchantName}`,
    })

    const shareUrl = `${new URL(req.url).origin}/flashtap-pay/checkout?merchant=${encodeURIComponent(
      merchantName
    )}&amount=${encodeURIComponent(amount.toFixed(2))}&note=${encodeURIComponent(note)}&url=${encodeURIComponent(
      payment.checkoutUrl
    )}`

    return NextResponse.json(
      {
        ok: true,
        orderId,
        merchantName,
        amount: amount.toFixed(2),
        note,
        checkoutUrl: payment.checkoutUrl,
        shareUrl,
        qrBase64: null,
        qrSvg: null,
        expiresAt: null,
        paymentStatus: payment.paymentStatus,
        requires3ds: payment.requires3ds,
      },
      { status: 201 }
    )
  } catch (error: any) {
    return NextResponse.json(
      { ok: false, error: error.message || 'Failed to create PayCloud payment link' },
      { status: 500 }
    )
  }
}
