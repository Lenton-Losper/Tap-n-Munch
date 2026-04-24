import { NextResponse } from 'next/server'
import { paycloudWireMerchantOrderNo, signRequest } from '@/payments/paycloud'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { orderId } = body || {}
    if (!orderId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const merchantNo = process.env.PAYCLOUD_MERCHANT_NO
    const storeNo = process.env.PAYCLOUD_STORE_NO
    const appId = process.env.PAYCLOUD_APP_ID
    const endpoint = process.env.PAYCLOUD_ENDPOINT
    if (!merchantNo || !storeNo || !appId || !endpoint) {
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
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Failed to cancel terminal payment' }, { status: 500 })
  }
}
