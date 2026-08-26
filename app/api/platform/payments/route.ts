import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { excludeStressFixtures } from '@/lib/orders/stress-fixtures'

export const dynamic = 'force-dynamic'

function startOfUtcDay(date = new Date()): string {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  ).toISOString()
}

function restaurantName(relation: unknown): string | null {
  if (Array.isArray(relation)) {
    const first = relation[0]
    return first && typeof first === 'object' && 'name' in first
      ? String((first as { name: unknown }).name)
      : null
  }
  if (relation && typeof relation === 'object' && 'name' in relation) {
    return String((relation as { name: unknown }).name)
  }
  return null
}

export type PaymentOpsStatus =
  | 'successful'
  | 'failed'
  | 'canceled'
  | 'refunded'
  | 'pending'
  | 'unknown'

function statusFromOrder(paymentStatus: string | null | undefined, orderStatus?: string | null): PaymentOpsStatus {
  const pay = String(paymentStatus || '').toLowerCase()
  const ord = String(orderStatus || '').toLowerCase()
  if (pay === 'paid' || pay === 'success' || pay === 'succeeded') return 'successful'
  if (pay === 'failed') return 'failed'
  if (pay === 'refunded' || pay === 'partially_refunded') return 'refunded'
  if (ord === 'canceled' || ord === 'cancelled' || pay === 'canceled' || pay === 'cancelled') {
    return 'canceled'
  }
  if (pay === 'pending' || pay === 'processing') return 'pending'
  return 'unknown'
}

function statusFromEvent(eventType: string | null | undefined, gatewayCode?: string | null): PaymentOpsStatus {
  const type = String(eventType || '').toLowerCase()
  if (type === 'refund_succeeded') return 'refunded'
  if (type === 'refund_failed' || type.includes('fail')) return 'failed'
  if (type === 'refund_attempted') return 'pending'
  if (type.includes('cancel')) return 'canceled'
  if (type === 'sale') {
    const code = String(gatewayCode || '').trim()
    if (code && !['0', '00', '0000', 'SUCCESS', 'success'].includes(code) && /fail|error|deny|cancel|refuse/i.test(code)) {
      return 'failed'
    }
    return 'successful'
  }
  return 'unknown'
}

export async function GET(request: Request) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const url = new URL(request.url)
    const statusFilter = (url.searchParams.get('status') || 'all').toLowerCase()
    const rangeDays = Math.min(90, Math.max(1, Number(url.searchParams.get('rangeDays') || 7) || 7))
    const restaurantId = url.searchParams.get('restaurantId') || ''
    const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString()
    const today = startOfUtcDay()

    const supabase = createServerSupabaseClient()

    // `restaurantId` is OPTIONAL here, so this is unscoped whenever the operator has not picked a
    // venue -- which is the default view. The exclusion goes on unconditionally rather than inside
    // the `if (restaurantId)` below, because the unscoped case is the one that can see a fixture.
    let ordersQuery = excludeStressFixtures(
      supabase
        .from('orders')
        .select(
          'id, restaurant_id, order_number, status, payment_status, payment_method, total, paycloud_merchant_order_no, payment_reference, payment_voucher_no, placed_at, paid_at, restaurants(name)',
        ),
    )
      .gte('placed_at', since)
      .order('placed_at', { ascending: false })
      .limit(200)

    let eventsQuery = supabase
      .from('payment_events')
      .select(
        'id, restaurant_id, order_ids, event_type, business_order_no, origin_business_order_no, transaction_id, terminal_id, app_version, amount, currency, reason_code, reason_note, gateway_result_code, gateway_result_message, raw_gateway_response, created_at, restaurants(name)',
      )
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(200)

    if (restaurantId) {
      ordersQuery = ordersQuery.eq('restaurant_id', restaurantId)
      eventsQuery = eventsQuery.eq('restaurant_id', restaurantId)
    }

    const [
      paidCountResult,
      failedCountResult,
      canceledCountResult,
      ordersResult,
      eventsResult,
      spendOrdersResult,
    ] = await Promise.all([
      /*
       * These five counts span every venue, so each carries the stress-fixture exclusion. All five
       * are excluded today by VALUE as well -- a fixture is never 'paid', never 'failed', never
       * 'cancelled' in `status`, and carries no paid_at -- but that is a fact about the rows the
       * stress script happened to write, not a rule anyone is holding to. The filter says what is
       * meant, so a future stress run with different values cannot quietly re-enter these numbers.
       */
      excludeStressFixtures(
        supabase.from('orders').select('id', { count: 'exact', head: true }),
      )
        .eq('payment_status', 'paid')
        .gte('paid_at', today),
      excludeStressFixtures(
        supabase.from('orders').select('id', { count: 'exact', head: true }),
      )
        .eq('payment_status', 'failed')
        .gte('placed_at', today),
      excludeStressFixtures(
        supabase.from('orders').select('id', { count: 'exact', head: true }),
      )
        .in('status', ['canceled', 'cancelled'])
        .gte('placed_at', today),
      ordersQuery,
      eventsQuery,
      excludeStressFixtures(
        supabase
          .from('orders')
          .select('restaurant_id, total, payment_status, restaurants(name)'),
      )
        .eq('payment_status', 'paid')
        .gte('paid_at', since)
        .limit(5000),
    ])

    const error =
      paidCountResult.error ??
      failedCountResult.error ??
      canceledCountResult.error ??
      ordersResult.error ??
      eventsResult.error ??
      spendOrdersResult.error
    if (error) throw error

    const paidToday = paidCountResult.count ?? 0
    const failedToday = failedCountResult.count ?? 0
    const canceledToday = canceledCountResult.count ?? 0
    const attemptsToday = paidToday + failedToday

    type Txn = {
      id: string
      source: 'order' | 'payment_event'
      status: PaymentOpsStatus
      reference: string
      restaurantId: string | null
      restaurantName: string | null
      amount: number
      currency: string
      eventType: string | null
      paymentStatus: string | null
      gatewayCode: string | null
      gatewayMessage: string | null
      reasonNote: string | null
      hasPayload: boolean
      at: string
      href: string
    }

    const transactions: Txn[] = []

    for (const order of ordersResult.data ?? []) {
      const status = statusFromOrder(order.payment_status, order.status)
      const reference =
        order.paycloud_merchant_order_no ||
        order.payment_voucher_no ||
        order.payment_reference ||
        order.order_number ||
        order.id
      transactions.push({
        id: `order:${order.id}`,
        source: 'order',
        status,
        reference: String(reference),
        restaurantId: order.restaurant_id,
        restaurantName: restaurantName(order.restaurants),
        amount: Number(order.total || 0),
        currency: 'NAD',
        eventType: null,
        paymentStatus: order.payment_status,
        gatewayCode: null,
        gatewayMessage: null,
        reasonNote: null,
        hasPayload: false,
        at: order.paid_at || order.placed_at,
        href: `/admin/payments?eventId=order:${order.id}`,
      })
    }

    for (const event of eventsResult.data ?? []) {
      const status = statusFromEvent(event.event_type, event.gateway_result_code)
      transactions.push({
        id: `event:${event.id}`,
        source: 'payment_event',
        status,
        reference: String(event.business_order_no || event.transaction_id || event.id),
        restaurantId: event.restaurant_id,
        restaurantName: restaurantName(event.restaurants),
        amount: Number(event.amount || 0),
        currency: event.currency || 'NAD',
        eventType: event.event_type,
        paymentStatus: null,
        gatewayCode: event.gateway_result_code,
        gatewayMessage: event.gateway_result_message,
        reasonNote: event.reason_note,
        hasPayload: Boolean(event.raw_gateway_response),
        at: event.created_at,
        href: `/admin/payments?eventId=event:${event.id}`,
      })
    }

    transactions.sort((a, b) => String(b.at).localeCompare(String(a.at)))

    const filtered =
      statusFilter === 'all'
        ? transactions
        : transactions.filter((t) => t.status === statusFilter)

    // Restaurant spend (Finatic-style summary)
    const spendMap = new Map<
      string,
      {
        restaurantId: string
        restaurantName: string
        purchasesQty: number
        purchasesAmount: number
        failedQty: number
        failedAmount: number
      }
    >()

    for (const order of spendOrdersResult.data ?? []) {
      const id = order.restaurant_id
      if (!id) continue
      const cur = spendMap.get(id) || {
        restaurantId: id,
        restaurantName: restaurantName(order.restaurants) || 'Unknown',
        purchasesQty: 0,
        purchasesAmount: 0,
        failedQty: 0,
        failedAmount: 0,
      }
      cur.purchasesQty += 1
      cur.purchasesAmount += Number(order.total || 0)
      spendMap.set(id, cur)
    }

    for (const order of ordersResult.data ?? []) {
      if (String(order.payment_status).toLowerCase() !== 'failed') continue
      const id = order.restaurant_id
      if (!id) continue
      const cur = spendMap.get(id) || {
        restaurantId: id,
        restaurantName: restaurantName(order.restaurants) || 'Unknown',
        purchasesQty: 0,
        purchasesAmount: 0,
        failedQty: 0,
        failedAmount: 0,
      }
      cur.failedQty += 1
      cur.failedAmount += Number(order.total || 0)
      spendMap.set(id, cur)
    }

    const restaurantSpend = Array.from(spendMap.values())
      .map((r) => ({
        ...r,
        purchasesAmount: Math.round(r.purchasesAmount * 100) / 100,
        failedAmount: Math.round(r.failedAmount * 100) / 100,
      }))
      .sort((a, b) => b.purchasesAmount - a.purchasesAmount)
      .slice(0, 40)

    const failedTransactions = filtered.filter((t) => t.status === 'failed').slice(0, 50)

    return NextResponse.json({
      meta: {
        generatedAt: new Date().toISOString(),
        rangeDays,
        statusFilter,
        since,
      },
      summary: {
        paidToday,
        failedToday,
        canceledToday,
        successRate:
          attemptsToday > 0 ? Math.round((paidToday / attemptsToday) * 1000) / 10 : null,
      },
      restaurantSpend,
      transactions: filtered.slice(0, 120),
      failedTransactions,
      // backward-compatible keys for older UI
      failedOrders: (ordersResult.data ?? []).filter(
        (o) => String(o.payment_status).toLowerCase() === 'failed',
      ),
      paymentEvents: eventsResult.data ?? [],
    })
  } catch (error) {
    console.error('[platform/payments] GET', error)
    return NextResponse.json({ error: 'Failed to load payment operations.' }, { status: 500 })
  }
}
