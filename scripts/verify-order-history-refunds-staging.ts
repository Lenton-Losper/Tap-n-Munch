/**
 * Staging verification for #28: order-history dashboard/export must reflect
 * refunds in both status and revenue totals.
 *
 * Exercises the real lib/reports/get-report-data.ts (used by both PDF and
 * CSV export). It shares the exact same underlying helpers
 * (getPaymentProjections / sumDistinctRefundedAmounts from
 * lib/payments/get-payment-projection.ts) that GET /api/orders/history uses
 * for the on-screen dashboard, so this also covers that path's logic.
 *
 * Covers:
 *   1. Single order: paid -> refunded, revenue reduced by refunded amount,
 *      paymentStatus surfaced as 'refunded'.
 *   2. Multi-order tab settlement: one SALE event covering 2 orders, one
 *      refund against that SALE — revenue must be reduced ONCE, not once
 *      per order (sumDistinctRefundedAmounts dedup).
 *
 *   npx tsx scripts/verify-order-history-refunds-staging.ts
 */
import { randomUUID } from 'crypto'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { getReportData } from '@/lib/reports/get-report-data'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: staging Supabase credentials missing (.env.test)')
}
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function ts(): string {
  return new Date().toISOString()
}

async function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  console.log(`[${ts()}] OK: ${message}`)
}

async function main() {
  const tag = randomUUID().slice(0, 8)
  let restaurantId: string | null = null
  const orderIds: string[] = []

  console.log(`[${ts()}] === Order-history refund reflection staging verification (#28) ===`)

  try {
    const { data: restaurant, error: restErr } = await admin
      .from('restaurants')
      .insert({ name: `Order History Refund Test ${tag}`, currency: 'NAD' })
      .select('id')
      .single()
    if (restErr || !restaurant?.id) throw restErr || new Error('restaurant insert failed')
    restaurantId = String(restaurant.id)

    const today = new Date().toISOString().split('T')[0]
    const placedAt = new Date().toISOString()

    // --- Case 1: single order, paid then fully refunded ---
    const order1Id = randomUUID()
    const order1No = `TEST-${tag}-1`
    const order1No_ = await insertOrder(order1Id, restaurantId, 100, placedAt)
    orderIds.push(order1Id)

    await insertPaymentEvent({
      restaurantId,
      eventType: 'sale',
      businessOrderNo: order1No,
      originBusinessOrderNo: order1No,
      orderIds: [order1Id],
      amount: 100,
      idempotencyKey: `sale-${tag}-1`,
    })

    // Before refund: report should show full revenue, no refund.
    const reportBefore = await getReportData({ restaurantId, startDate: today, endDate: today })
    const order1Before = reportBefore.orders.find((o) => o.order_number === order1No_)
    await assert(order1Before?.paymentStatus === 'paid', 'before refund: order1 paymentStatus = paid')
    await assert(order1Before?.refundedAmount === 0, 'before refund: order1 refundedAmount = 0')
    await assert(reportBefore.summary.totalRevenue >= 100, 'before refund: totalRevenue includes order1 (>= 100)')
    const totalRevenueBefore = reportBefore.summary.totalRevenue

    await insertPaymentEvent({
      restaurantId,
      eventType: 'refund_succeeded',
      businessOrderNo: `${order1No}-R1`,
      originBusinessOrderNo: order1No,
      orderIds: [order1Id],
      amount: 100,
      idempotencyKey: `refund-${tag}-1`,
    })

    const reportAfter = await getReportData({ restaurantId, startDate: today, endDate: today })
    const order1After = reportAfter.orders.find((o) => o.order_number === order1No_)
    await assert(order1After?.paymentStatus === 'refunded', 'after full refund: order1 paymentStatus = refunded')
    await assert(order1After?.refundedAmount === 100, 'after full refund: order1 refundedAmount = 100')
    await assert(
      Math.abs(reportAfter.summary.totalRevenue - (totalRevenueBefore - 100)) < 0.001,
      `after full refund: totalRevenue reduced by exactly 100 (before=${totalRevenueBefore}, after=${reportAfter.summary.totalRevenue})`,
    )

    // --- Case 2: multi-order tab settlement, one SALE covers 2 orders, refund once ---
    const order2Id = randomUUID()
    const order3Id = randomUUID()
    const tabOrderNo = `TEST-${tag}-TAB`
    const order2No_ = await insertOrder(order2Id, restaurantId, 60, placedAt)
    const order3No_ = await insertOrder(order3Id, restaurantId, 40, placedAt)
    orderIds.push(order2Id, order3Id)

    await insertPaymentEvent({
      restaurantId,
      eventType: 'sale',
      businessOrderNo: tabOrderNo,
      originBusinessOrderNo: tabOrderNo,
      orderIds: [order2Id, order3Id],
      amount: 100,
      idempotencyKey: `sale-${tag}-tab`,
    })

    const reportBeforeTabRefund = await getReportData({ restaurantId, startDate: today, endDate: today })
    const revenueBeforeTabRefund = reportBeforeTabRefund.summary.totalRevenue

    await insertPaymentEvent({
      restaurantId,
      eventType: 'refund_succeeded',
      businessOrderNo: `${tabOrderNo}-R1`,
      originBusinessOrderNo: tabOrderNo,
      orderIds: [order2Id, order3Id],
      amount: 25,
      idempotencyKey: `refund-${tag}-tab`,
    })

    const reportAfterTabRefund = await getReportData({ restaurantId, startDate: today, endDate: today })
    await assert(
      Math.abs(reportAfterTabRefund.summary.totalRevenue - (revenueBeforeTabRefund - 25)) < 0.001,
      `tab settlement: refund subtracted ONCE, not per-order (before=${revenueBeforeTabRefund}, after=${reportAfterTabRefund.summary.totalRevenue}, expected -25)`,
    )
    const order2After = reportAfterTabRefund.orders.find((o) => o.order_number === order2No_)
    const order3After = reportAfterTabRefund.orders.find((o) => o.order_number === order3No_)
    await assert(order2After?.paymentStatus === 'partially_refunded', 'tab order2 paymentStatus = partially_refunded')
    await assert(order3After?.paymentStatus === 'partially_refunded', 'tab order3 paymentStatus = partially_refunded')

    console.log(`\n[${ts()}] Order-history refund reflection verification passed.`)
  } finally {
    if (restaurantId) {
      await admin.from('payment_events').delete().eq('restaurant_id', restaurantId)
      await admin.from('orders').delete().eq('restaurant_id', restaurantId)
      await admin.from('restaurants').delete().eq('id', restaurantId)
    }
    console.log(`[${ts()}] cleanup complete`)
  }
}

let nextOrderNumber = Math.floor(Date.now() / 1000) % 1_000_000

async function insertOrder(id: string, restaurantId: string, total: number, placedAt: string): Promise<number> {
  const orderNumber = nextOrderNumber++
  const { error } = await admin.from('orders').insert({
    id,
    restaurant_id: restaurantId,
    order_number: orderNumber,
    total,
    status: 'completed',
    payment_status: 'paid',
    placed_at: placedAt,
    items: [],
  })
  if (error) throw error
  return orderNumber
}

async function insertPaymentEvent(params: {
  restaurantId: string
  eventType: 'sale' | 'refund_succeeded'
  businessOrderNo: string
  originBusinessOrderNo: string
  orderIds: string[]
  amount: number
  idempotencyKey: string
}) {
  const { error } = await admin.from('payment_events').insert({
    restaurant_id: params.restaurantId,
    event_type: params.eventType,
    business_order_no: params.businessOrderNo,
    origin_business_order_no: params.originBusinessOrderNo,
    order_ids: params.orderIds,
    amount: params.amount,
    currency: 'NAD',
    idempotency_key: params.idempotencyKey,
    reason_code: params.eventType === 'refund_succeeded' ? 'customer_request' : 'n/a',
  })
  if (error) throw error
}

main().catch((error) => {
  console.error(`\n[${ts()}] Verification failed:`, error)
  process.exit(1)
})
