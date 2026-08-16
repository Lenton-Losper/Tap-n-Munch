import { createServerSupabaseClient } from '@/lib/supabase/server'
import {
  getPaymentProjections,
  sumDistinctRefundedAmounts,
  type PaymentStatus,
} from '@/lib/payments/get-payment-projection'
import {
  calendarDateRangeToUtcIso,
  DEFAULT_REPORT_TIMEZONE,
} from '@/lib/reports/format-report-datetime'
import { owesMoney } from '@/lib/payments/payment-integrity'

export interface ReportOrder {
  order_number: number
  placed_at: string
  table_number: number | null
  customer_name: string | null
  items: string
  total: number
  payment_method: string | null
  payment_channel: string | null
  status: string
  /** Derived from payment_events; null when no SALE row exists for this order. */
  paymentStatus: PaymentStatus | null
  refundedAmount: number
}

export interface ReportData {
  restaurant: {
    id: string
    name: string
    logo_url: string | null
    /** IANA timezone used when formatting export timestamps (PDF/CSV). */
    timezone: string
  }
  filters: {
    startDate: string
    endDate: string
    tableNumber?: number
    status?: string
  }
  summary: {
    totalRevenue: number
    totalOrders: number
    averageOrderValue: number
    /** Distinct refunds already subtracted from totalRevenue. */
    refundedTotal: number
    /** Paid orders grouped by payment_method, GROSS of refunds. Sums to totalRevenue + refundedTotal. */
    paymentMethodSplit: Array<{ method: string; orders: number; gross: number }>
    /** Non-cancelled orders that are not paid -- stranded/pending, surfaced same-day. */
    unresolvedOrders: number
  }
  orders: ReportOrder[]
  generatedAt: string
}

export interface GetReportDataParams {
  restaurantId: string
  startDate: string    // YYYY-MM-DD
  endDate: string      // YYYY-MM-DD
  tableNumber?: number
  status?: string
}

export async function getReportData(params: GetReportDataParams): Promise<ReportData> {
  const supabase = createServerSupabaseClient()

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .select('id, name, logo_url, timezone')
    .eq('id', params.restaurantId)
    .single()

  if (restaurantError || !restaurant) {
    throw new Error('Restaurant not found')
  }

  const timezone =
    typeof restaurant.timezone === 'string' && restaurant.timezone.trim()
      ? restaurant.timezone.trim()
      : DEFAULT_REPORT_TIMEZONE

  const { startIso, endIsoExclusive } = calendarDateRangeToUtcIso(
    params.startDate,
    params.endDate,
    timezone,
  )

  let query = supabase
    .from('orders')
    .select('id, order_number, placed_at, table_number, customer_name, status, payment_method, payment_channel, payment_status, total, items')
    .eq('restaurant_id', params.restaurantId)
    .neq('status', 'cancelled')
    .gte('placed_at', startIso)
    .lt('placed_at', endIsoExclusive)
    .order('placed_at', { ascending: false })

  if (params.tableNumber) {
    query = query.eq('table_number', params.tableNumber)
  }
  if (params.status && params.status !== 'All') {
    query = query.eq('status', params.status)
  }

  const { data: rawOrders, error: ordersError } = await query
  if (ordersError) throw new Error(ordersError.message)

  const orderIds = (rawOrders ?? []).map((o: { id: string }) => String(o.id))
  const projections = await getPaymentProjections(
    supabase,
    params.restaurantId,
    orderIds,
  )

  const orders: ReportOrder[] = (rawOrders ?? []).map((o: any) => {
    const itemList = Array.isArray(o.items) ? o.items : []
    const itemsSummary = itemList
      .map((item: any) =>
        item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name
      )
      .join(', ')

    const projection = projections.get(String(o.id)) ?? null

    return {
      order_number: o.order_number,
      placed_at: o.placed_at,
      table_number: o.table_number ?? null,
      customer_name: o.customer_name ?? null,
      items: itemsSummary,
      total: Number(o.total ?? 0),
      payment_method: o.payment_method ?? null,
      payment_channel: o.payment_channel ?? null,
      status: o.status,
      paymentStatus: projection?.paymentStatus ?? null,
      refundedAmount: projection?.refundedAmount ?? 0,
    }
  })

  const paidOrders = (rawOrders ?? []).filter((o: any) => o.payment_status === 'paid')
  const grossPaid = paidOrders.reduce((sum, o: any) => sum + Number(o.total ?? 0), 0)
  const refundedDistinct = sumDistinctRefundedAmounts(
    paidOrders.map((o: any) => String(o.id)),
    projections,
  )
  const totalRevenue = grossPaid - refundedDistinct
  const totalOrders = paidOrders.length
  const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0

  // Payment-method split, computed here rather than by the caller because this is the only
  // place the RAW orders.payment_status is in scope. ReportOrder exposes `paymentStatus`,
  // which is derived from payment_events and is null whenever no SALE row exists, so a split
  // built from it would silently under-count. Gross of refunds, so the parts sum to grossPaid,
  // not to totalRevenue -- refunds are reported separately.
  const splitByMethod = new Map<string, { orders: number; gross: number }>()
  for (const o of paidOrders as Array<Record<string, unknown>>) {
    const method = String(o.payment_method ?? '').trim().toLowerCase() || 'unknown'
    const entry = splitByMethod.get(method) ?? { orders: 0, gross: 0 }
    entry.orders += 1
    entry.gross += Number(o.total ?? 0)
    splitByMethod.set(method, entry)
  }
  const paymentMethodSplit = [...splitByMethod.entries()]
    .map(([method, v]) => ({ method, orders: v.orders, gross: Math.round(v.gross * 100) / 100 }))
    .sort((a, b) => b.gross - a.gross)

  /**
   * WHAT IS STILL OWED — `owesMoney`, not a hand-rolled "not paid" (#232, and #139's
   * consolidation).
   *
   * This read `o.status !== 'cancelled' && o.payment_status !== 'paid'`, which is the SIXTH site
   * of a question this codebase has already answered five times. The reason it is wrong is
   * written verbatim in `mark-order-paid-confirmed.ts`:
   *
   *   > Partitioned with owesMoney(), not `.neq('payment_status','paid')` -- "not paid" is also
   *   > true of a CANCELLED order, so a cancelled order's money kept being carried in
   *   > tabs.total (#104, the fifth site of the same question).
   *
   * `payment_status = 'cancelled'` is a value this codebase writes, and it is deliberately
   * absent from `OWES_MONEY_PAYMENT_STATUSES`. An order whose PAYMENT was cancelled while the
   * order itself was not therefore counted as "stranded/pending, surfaced same-day" on the staff
   * report — money nobody owes, presented as money to chase.
   *
   * The `status !== 'cancelled'` half was redundant besides: the query above already applies
   * `.neq('status', 'cancelled')`.
   *
   * MEASURED IMPACT ON STAGING TODAY: none. Read-only over the 14 non-cancelled orders present,
   * `payment_status` is only ever `paid` (7) or `pending` (7), so the two predicates agree
   * exactly and this changes no figure. That is a small, freshly-cleaned sample and is NOT
   * evidence the divergence does not occur elsewhere — the defect is latent, and it fires the
   * moment a cancelled payment sits on a live order. Stated rather than dressed up as a fix for
   * something observed.
   */
  const unresolvedOrders = (rawOrders ?? []).filter((o: any) => owesMoney(o.payment_status)).length

  return {
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      logo_url: restaurant.logo_url ?? null,
      timezone,
    },
    filters: {
      startDate: params.startDate,
      endDate: params.endDate,
      tableNumber: params.tableNumber,
      status: params.status,
    },
    summary: {
      totalRevenue,
      totalOrders,
      averageOrderValue,
      refundedTotal: Math.round(refundedDistinct * 100) / 100,
      paymentMethodSplit,
      unresolvedOrders,
    },
    orders,
    generatedAt: new Date().toISOString(),
  }
}
