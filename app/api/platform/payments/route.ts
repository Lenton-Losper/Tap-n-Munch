import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

function startOfUtcDay(date = new Date()): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  ).toISOString()
}

export async function GET(request: Request) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const supabase = createServerSupabaseClient()
    const today = startOfUtcDay()

    const [paidCountResult, failedCountResult, failedOrdersResult, eventsResult] =
      await Promise.all([
        supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('payment_status', 'paid')
          .gte('paid_at', today),
        supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('payment_status', 'failed')
          .gte('placed_at', today),
        supabase
          .from('orders')
          .select(
            'id, restaurant_id, order_number, total, payment_status, payment_method, paycloud_merchant_order_no, payment_reference, payment_voucher_no, placed_at, paid_at, restaurants(name)',
          )
          .eq('payment_status', 'failed')
          .order('placed_at', { ascending: false })
          .limit(30),
        supabase
          .from('payment_events')
          .select(
            'id, restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no, transaction_id, terminal_id, app_version, amount, currency, reason_code, reason_note, gateway_result_code, gateway_result_message, created_at, restaurants(name)',
          )
          .in('event_type', [
            'sale',
            'refund_attempted',
            'refund_succeeded',
            'refund_failed',
          ])
          .order('created_at', { ascending: false })
          .limit(40),
      ])

    const error =
      paidCountResult.error ??
      failedCountResult.error ??
      failedOrdersResult.error ??
      eventsResult.error
    if (error) throw error

    const paidToday = paidCountResult.count ?? 0
    const failedToday = failedCountResult.count ?? 0
    const attemptsToday = paidToday + failedToday

    return NextResponse.json({
      summary: {
        paidToday,
        failedToday,
        successRate:
          attemptsToday > 0
            ? Math.round((paidToday / attemptsToday) * 1000) / 10
            : null,
      },
      failedOrders: failedOrdersResult.data ?? [],
      paymentEvents: eventsResult.data ?? [],
      gateway: {
        hint: 'Use the payment gateway health endpoint for a live connectivity check.',
        healthEndpoint: '/api/payments/health',
      },
    })
  } catch (error) {
    console.error('[platform/payments] GET', error)
    return NextResponse.json({ error: 'Failed to load payment operations.' }, { status: 500 })
  }
}
