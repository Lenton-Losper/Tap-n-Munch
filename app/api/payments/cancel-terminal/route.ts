import { NextResponse } from 'next/server'
import { paycloudWireMerchantOrderNo, signRequest } from '@/payments/paycloud'
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
    const { orderId } = body || {}
    if (!orderId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }

    const appId = process.env.PAYCLOUD_APP_ID
    const endpoint = process.env.PAYCLOUD_ENDPOINT
    if (!appId || !endpoint) {
      return NextResponse.json({ error: 'Missing PayCloud configuration' }, { status: 500 })
    }

    const { supabase, restaurantId: callerRestaurantId } = auth
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single()

    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    const orderRestaurantId = String((order as { restaurant_id?: string }).restaurant_id || '').trim()
    if (!orderRestaurantId || orderRestaurantId !== callerRestaurantId) {
      return NextResponse.json({ error: 'Order does not belong to this restaurant' }, { status: 403 })
    }

    let merchantNo: string
    let storeNo: string
    try {
      const creds = await getRestaurantFinaticCredentials(callerRestaurantId)
      merchantNo = creds.merchantNo
      storeNo = creds.storeNo
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load payment credentials'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    // Prefer the stored Finatic merchant order no; fall back to wire-format of order id.
    const storedMerchantNo = String(
      (order as { paycloud_merchant_order_no?: string | null }).paycloud_merchant_order_no || '',
    ).trim()
    const merchantOrderNo = storedMerchantNo || paycloudWireMerchantOrderNo(String(orderId))
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

    // Clear card/gateway references so cash receipts never inherit a masked card-style ref.
    const { error: updateError } = await supabase
      .from('orders')
      .update({
        payment_method: 'cash',
        payment_status: 'cash_pending',
        payment_reference: null,
        paycloud_merchant_order_no: null,
        payment_checkout_url: null,
      })
      .eq('id', String(orderId))

    if (updateError) {
      console.error('[cancel-terminal] order update failed', updateError)
      return NextResponse.json({ error: 'Failed to switch order to cash' }, { status: 500 })
    }

    return NextResponse.json({ success: true, data: (data as Record<string, unknown>)?.data || null }, { status: 200 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to cancel terminal payment'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
