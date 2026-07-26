// @ts-nocheck — createPaymentRequest is JS without complete typings
import { NextResponse } from 'next/server'
import { createPaymentRequest } from '@/payments/paycloud'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
import {
  isAuthError,
  requireCallerRestaurantPermission,
} from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'

export async function POST(req: Request) {
  try {
    const auth = await requireCallerRestaurantPermission(PERMISSIONS.PAYMENTS_PROCESS, req)
    if (isAuthError(auth)) return auth

    const body = await req.json()
    const amount = Number(body.amount)
    const note = String(body.note || '').trim()
    const merchantName = String(body.merchantName || 'FlashTap Pay Merchant').trim()

    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Amount must be a positive number' }, { status: 400 })
    }

    // Never trust client-supplied Finatic merchant/store numbers.
    let merchantNo: string
    let storeNo: string
    try {
      const creds = await getRestaurantFinaticCredentials(auth.restaurantId)
      merchantNo = creds.checkoutMerchantNo || creds.merchantNo
      storeNo = creds.checkoutStoreNo || creds.storeNo
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load payment credentials'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    if (!merchantNo || !storeNo) {
      return NextResponse.json(
        { error: 'This restaurant has not configured Finatic checkout credentials.' },
        { status: 400 },
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
      merchantName,
    )}&amount=${encodeURIComponent(amount.toFixed(2))}&note=${encodeURIComponent(note)}&url=${encodeURIComponent(
      payment.checkoutUrl,
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
      { status: 201 },
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create PayCloud payment link'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
