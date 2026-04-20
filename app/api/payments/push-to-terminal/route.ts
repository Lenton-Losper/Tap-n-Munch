import { NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin-firestore'
import { orderPath } from '@/lib/firebase/paths'
import { formatPaycloudRequestSignature, loadPrivateKey, signUtf8WithForgePkcs1RsaSha256 } from '@/payments/signature'

const ECR_ORDER_URL = 'https://open.finatic.africa/api/entry/ecrorder'

/** Hardcoded terminal serial for Finatic WISECASHIER / ecrorder flow. */
const TERMINAL_SN = 'WPYB002349003019'

/** ECR / terminal push — separate merchant from hosted checkout */
const TERMINAL_PUSH_MERCHANT_NO = '342400001004'
const TERMINAL_PUSH_STORE_NO = '4424000013'

function buildCanonicalString(payload: Record<string, unknown>) {
  const keys = Object.keys(payload)
    .filter((k) => k !== 'sign')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return keys.map((k) => `${k}=${String(payload[k])}`).join('&')
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { orderId, restaurantId, amount, tableNumber, orderNumber } = body || {}

    if (!orderId || !restaurantId || amount === undefined || amount === null) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const fs = adminDb()
    if (!fs) {
      return NextResponse.json(
        { error: 'Server configuration error: Firebase Admin not initialized.' },
        { status: 503 }
      )
    }

    const appId = process.env.PAYCLOUD_APP_ID
    const merchantNo = TERMINAL_PUSH_MERCHANT_NO
    const storeNo = TERMINAL_PUSH_STORE_NO

    if (!appId) {
      return NextResponse.json(
        { error: 'Missing PayCloud configuration (PAYCLOUD_APP_ID)' },
        { status: 500 }
      )
    }

    const paramsForSigning: Record<string, unknown> = {
      app_id: appId,
      api_version: '2.0',
      format: 'JSON',
      charset: 'UTF-8',
      sign_type: 'RSA2',
      version: '1.0',
      timestamp: Date.now(),
      method: 'wisehub.cloud.pay.order',
      merchant_no: merchantNo,
      store_no: storeNo,
      terminal_sn: TERMINAL_SN,
      message_receiving_application: 'WISECASHIER',
      pay_scenario: 'SWIPE_CARD',
      price_currency: 'NAD',
      order_amount: Number(amount),
      trans_type: 1,
      merchant_order_no: String(orderId),
      description: `FlashTap Table ${tableNumber} Order #${orderNumber}`,
      notify_url: 'https://www.flashtap.app/api/webhooks/paycloud',
      expires: 300,
      reject_trade_when_terminal_offline: 'false',
      required_terminal_authentication: 'false',
    }

    const canonicalString = buildCanonicalString(paramsForSigning)
    const privateKeyPem = loadPrivateKey()
    const signRaw = signUtf8WithForgePkcs1RsaSha256(canonicalString, privateKeyPem)
    const payload = {
      ...paramsForSigning,
      sign: formatPaycloudRequestSignature(signRaw),
    }

    console.log('[PUSH-TO-TERMINAL] POST', ECR_ORDER_URL, {
      method: paramsForSigning.method,
      merchant_order_no: paramsForSigning.merchant_order_no,
      order_amount: paramsForSigning.order_amount,
    })

    const response = await fetch(ECR_ORDER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(payload),
    })

    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
    console.log('[PUSH-TO-TERMINAL] Finatic response:', JSON.stringify(data))

    if (!response.ok || String(data?.code || '') !== '0') {
      return NextResponse.json(
        {
          success: false,
          error: data?.msg || 'Failed to push to terminal',
          finatic: data,
        },
        { status: 400 }
      )
    }

    await fs.doc(orderPath(String(restaurantId), String(orderId))).update({
      payment_method: 'card_terminal',
      payment_status: 'terminal_pending',
      terminal_sn: TERMINAL_SN,
      paycloud_merchant_order_no: String(orderId),
      updated_at: new Date(),
    })

    return NextResponse.json(
      {
        success: true,
        data: data?.data ?? null,
        finatic: data,
      },
      { status: 200 }
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to push to terminal'
    console.error('[PUSH-TO-TERMINAL] Error:', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
