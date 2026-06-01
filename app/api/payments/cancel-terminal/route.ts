import { NextResponse } from 'next/server'
import { paycloudWireMerchantOrderNo, signRequest } from '@/payments/paycloud'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { orderId, restaurantId: restaurantIdRaw } = body || {}
    if (!orderId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const restaurantId = String(restaurantIdRaw || '').trim()
    if (!restaurantId) {
      return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
    }

    const appId = process.env.PAYCLOUD_APP_ID
    const endpoint = process.env.PAYCLOUD_ENDPOINT
    if (!appId || !endpoint) {
      return NextResponse.json({ error: 'Missing PayCloud configuration' }, { status: 500 })
    }

    const supabase = createServerSupabaseClient()
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single()

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    const orderRestaurantId = String((order as { restaurant_id?: string }).restaurant_id || '').trim()
    if (orderRestaurantId && orderRestaurantId !== restaurantId) {
      return NextResponse.json({ error: 'Order does not belong to this restaurant' }, { status: 400 })
    }

    let merchantNo: string
    let storeNo: string
    try {
      const creds = await getRestaurantFinaticCredentials(restaurantId)
      merchantNo = creds.merchantNo
      storeNo = creds.storeNo
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load payment credentials'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    const merchantOrderNo = paycloudWireMerchantOrderNo(String(orderId))
    const params = {
      app_id: appId,
      charset: 'UTF-8',
      format: 'JSON',
      version: '1.0',
      sign_type: 'RSA2',
      method: 'pay.paycloud.close',
      timestamp: Date.now(),
      merchant_no: merchantNo,
      store_no: storeNo,
      merchant_order_no: merchantOrderNo,
    }
    const signed = signRequest(params)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signed),
    })
    const data = await response.json().catch(() => ({}))

    if (!response.ok || String((data as Record<string, unknown>)?.code || '') !== '0') {
      return NextResponse.json(
        {
          success: false,
          error: (data as Record<string, unknown>)?.msg || 'Failed to cancel terminal payment',
          detail: data,
        },
        { status: 400 }
      )
    }

    await supabase
      .from('orders')
      .update({
        payment_method: 'cash',
        payment_status: 'cash_pending',
      })
      .eq('id', String(orderId))

    return NextResponse.json({ success: true, data: (data as Record<string, unknown>)?.data || null }, { status: 200 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to cancel terminal payment'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
