import { NextResponse } from 'next/server'
import { formatPaycloudRequestSignature, loadPrivateKey, signUtf8WithForgePkcs1RsaSha256 } from '@/payments/signature'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'

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
    const normalizedRestaurantId = String(restaurantId || '').trim()
    const normalizedOrderId = String(orderId || '').trim()
    if (!normalizedOrderId || !normalizedRestaurantId) {
      console.error('[PUSH-TO-TERMINAL] Missing required fields', {
        orderId,
        restaurantId,
      })
      console.log('[PUSH-TO-TERMINAL] Returning 400 because:', 'Missing required fields')
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
        console.log('[PUSH-TO-TERMINAL] Returning 400 because:', 'Invalid orderId format')
        return NextResponse.json({ error: 'Invalid orderId format' }, { status: 400 })
      }
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    if (!order) {
      console.error('[PUSH-TO-TERMINAL] Order not found', { orderId: normalizedOrderId })
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    if (String(order.payment_status || '').toLowerCase() === 'paid') {
      console.log('[PUSH-TO-TERMINAL] Order already paid, blocking duplicate:', normalizedOrderId)
      console.log('[PUSH-TO-TERMINAL] Returning 400 because:', 'Order already paid')
      return NextResponse.json(
        {
          error: 'This order has already been paid',
          code: 'ALREADY_PAID',
        },
        { status: 400 }
      )
    }

    const resolvedAmount = amount === undefined || amount === null ? Number(order.total) : Number(amount)
    if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
      console.log('[PUSH-TO-TERMINAL] Returning 400 because:', 'Invalid amount')
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })
    }

    let merchantNo: string
    let storeNo: string
    let terminalSn: string | null
    try {
      const credentials = await getRestaurantFinaticCredentials(normalizedRestaurantId)
      merchantNo = credentials.merchantNo
      storeNo = credentials.storeNo
      terminalSn = credentials.terminalSn
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load payment credentials'
      console.log('[PUSH-TO-TERMINAL] Returning 400 because:', message)
      return NextResponse.json({ error: message }, { status: 400 })
    }
    if (!terminalSn) {
      console.log('[PUSH-TO-TERMINAL] Returning 400 because:', 'No terminal configured for this restaurant')
      return NextResponse.json(
        {
          error: 'No terminal configured for this restaurant',
          code: 'NO_TERMINAL',
        },
        { status: 400 }
      )
    }
    const appId = process.env.PAYCLOUD_APP_ID
    console.log('[PUSH-TO-TERMINAL] Using terminal credentials:', {
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

    const existingMo = String((order as { paycloud_merchant_order_no?: string | null }).paycloud_merchant_order_no || '').trim()
    const rand4 = Math.floor(Math.random() * 10000).toString().padStart(4, '0')
    const merchantOrderNo = existingMo
      ? `FT${Date.now()}${rand4}`.slice(0, 32)
      : existingMo || `FT${Date.now()}`.slice(0, 32)

    const persistRes = await supabase
      .from('orders')
      .update({ paycloud_merchant_order_no: merchantOrderNo })
      .eq('id', normalizedOrderId)
    if (persistRes.error) {
      console.error('[PUSH-TO-TERMINAL] Failed to persist merchant order no:', persistRes.error)
      return NextResponse.json({ error: persistRes.error.message }, { status: 500 })
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
      console.log('[PUSH-TO-TERMINAL] Finatic raw response status:', response.status)
      console.log('[PUSH-TO-TERMINAL] Finatic raw response body:', await response.clone().text())
      data = (await response.json().catch(() => ({}))) as Record<string, unknown>

      if (!response.ok || String(data?.code || '') !== '0') {
        const finaticReason = `Finatic error: HTTP ${response.status}, code=${String(data?.code ?? '')}, msg=${String(data?.msg || 'Failed to push to terminal')}`
        console.log('[PUSH-TO-TERMINAL] Returning 400 because:', finaticReason)
        await supabase
          .from('orders')
          .update({ terminal_status: 'failed' })
          .eq('id', normalizedOrderId)
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
      console.error('[PUSH-TO-TERMINAL] Finatic call threw error:', err)
      console.error('[PUSH-TO-TERMINAL] Finatic call failed:', err)
      await supabase
        .from('orders')
        .update({ terminal_status: 'failed' })
        .eq('id', normalizedOrderId)
      return NextResponse.json(
        { error: 'Finatic call failed', details: String(err) },
        { status: 500 }
      )
    }

    await supabase
      .from('orders')
      .update({
        payment_status: 'terminal_pending',
        status: 'completed',
        terminal_status: 'pending',
        terminal_sn: terminalSn,
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
