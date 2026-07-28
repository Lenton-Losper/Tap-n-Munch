import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { markPaymentAttemptStarted } from '@/lib/payments/mark-payment-attempt-started'

export const dynamic = 'force-dynamic'

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

/**
 * Terminal-side acknowledgment that WiseCashier was actually launched on-device.
 * Distinct from prepare-payment, which only allocates the merchant order number.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    if (!terminal.permissions.includes('orders:update')) {
      return NextResponse.json({ error: 'Missing permission' }, { status: 403 })
    }

    const { orderId } = await params
    if (!isUuid(orderId)) {
      return NextResponse.json({ error: 'orderId must be a valid UUID' }, { status: 400 })
    }

    const body = await req.json().catch(() => ({}))
    const businessOrderNo = String(
      body?.businessOrderNo ?? body?.merchantOrderNo ?? body?.merchant_order_no ?? '',
    ).trim()
    const appVersion = body?.appVersion ? String(body.appVersion).trim() : null
    const launchedAt = body?.launchedAt ? String(body.launchedAt).trim() : null

    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, restaurant_id, payment_status, paycloud_merchant_order_no')
      .eq('id', orderId)
      .eq('restaurant_id', terminal.restaurantId)
      .maybeSingle()

    if (orderError) {
      console.error('[terminal/attempt-started] load order failed', orderError)
      return NextResponse.json({ error: 'Failed to load order' }, { status: 500 })
    }
    if (!order) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }

    const persistedBusinessOrderNo = String(order.paycloud_merchant_order_no || '').trim()
    if (!persistedBusinessOrderNo) {
      return NextResponse.json(
        {
          error: 'Order has no paycloud_merchant_order_no — prepare-payment must happen first',
          code: 'NO_MERCHANT_ORDER_NO',
        },
        { status: 400 },
      )
    }
    if (businessOrderNo && businessOrderNo !== persistedBusinessOrderNo) {
      return NextResponse.json(
        {
          error: 'businessOrderNo does not match the persisted paycloud_merchant_order_no',
          code: 'BUSINESS_ORDER_NO_MISMATCH',
          expected: persistedBusinessOrderNo,
          received: businessOrderNo,
        },
        { status: 400 },
      )
    }

    const result = await markPaymentAttemptStarted(supabase, {
      orderId,
      restaurantId: terminal.restaurantId,
      businessOrderNo: persistedBusinessOrderNo,
      source: 'terminal_app',
      terminalId: terminal.terminalId,
      terminalSn: terminal.deviceSerial,
      appVersion,
      launchedAt,
    })

    return NextResponse.json({
      success: true,
      recorded: result.recorded,
      startedAt: result.startedAt,
      businessOrderNo: persistedBusinessOrderNo,
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/attempt-started]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
