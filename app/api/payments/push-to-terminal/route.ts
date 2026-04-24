import { NextResponse } from 'next/server'
import { formatPaycloudRequestSignature, loadPrivateKey, signUtf8WithForgePkcs1RsaSha256 } from '@/payments/signature'
import { createServerSupabaseClient } from '@/lib/supabase/server'

const ECR_ORDER_URL = 'https://open.finatic.africa/api/entry/ecrorder'

function buildCanonicalString(payload: Record<string, unknown>) {
  const keys = Object.keys(payload)
    .filter((k) => k !== 'sign')
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return keys.map((k) => `${k}=${String(payload[k])}`).join('&')
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    console.log('[PUSH-TO-TERMINAL] Request body:', JSON.stringify(body))
    const { orderId, restaurantId, amount, tableNumber, orderNumber } = body || {}
    const normalizedOrderId = String(orderId || '').trim()
    if (!normalizedOrderId || !restaurantId) {
      console.error('[PUSH-TO-TERMINAL] Missing required fields', {
        orderId,
        restaurantId,
      })
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    const { data: order, error: orderLookupError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', normalizedOrderId)
      .single()

    if (orderLookupError) {
      console.error('[PUSH-TO-TERMINAL] Order lookup failed', {
        orderId: normalizedOrderId,
        code: orderLookupError.code,
        message: orderLookupError.message,
        details: orderLookupError.details,
      })
      const invalidUuid = String(orderLookupError.message || '')
        .toLowerCase()
        .includes('invalid input syntax for type uuid')
      if (invalidUuid) {
        return NextResponse.json({ error: 'Invalid orderId format' }, { status: 400 })
      }
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    if (!order) {
      console.error('[PUSH-TO-TERMINAL] Order not found', { orderId: normalizedOrderId })
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }
    const resolvedAmount = amount === undefined || amount === null ? Number(order.total) : Number(amount)
    if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
    }

    // TODO: Switch to per-restaurant credentials once
    // Sedrick links Sweet Side's P5 to their merchant account
    const merchantNo = "342400001004"
    const storeNo = "4424000013"
    const terminalSn = "WPYB002349003019"
    const appId = process.env.PAYCLOUD_APP_ID
    console.log('[PUSH-TO-TERMINAL] credentials:', {
      merchantNo,
      storeNo,
      terminalSn
    })

    if (!appId || !merchantNo || !storeNo) {
      return NextResponse.json(
        { error: 'Missing PayCloud configuration (PAYCLOUD_APP_ID / merchant / store)' },
        { status: 500 }
      )
    }

    const merchantOrderNo = `FT${Date.now()}`.slice(0, 32)
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
      terminal_sn: terminalSn,
      message_receiving_application: 'WISECASHIER',
      pay_scenario: 'SWIPE_CARD',
      price_currency: 'NAD',
      order_amount: resolvedAmount,
      trans_type: 1,
      merchant_order_no: merchantOrderNo,
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
    console.log('[PUSH-TO-TERMINAL] Finatic payload:', {
      method: 'wisehub.cloud.pay.order',
      merchant_order_no: merchantOrderNo,
      order_amount: resolvedAmount,
      terminal_sn: terminalSn,
      merchant_no: merchantNo,
      store_no: storeNo
    })
    let data: Record<string, unknown>
    try {
      const response = await fetch(ECR_ORDER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        body: JSON.stringify(payload),
      })
      data = (await response.json().catch(() => ({}))) as Record<string, unknown>

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
    } catch (err) {
      console.error('[PUSH-TO-TERMINAL] Finatic call failed:', err)
      return NextResponse.json(
        { error: 'Finatic call failed', details: String(err) },
        { status: 500 }
      )
    }

    await supabase
      .from('orders')
      .update({
        payment_status: 'terminal_pending',
        terminal_sn: terminalSn,
        paycloud_merchant_order_no: merchantOrderNo
      })
      .eq('id', normalizedOrderId)

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
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
