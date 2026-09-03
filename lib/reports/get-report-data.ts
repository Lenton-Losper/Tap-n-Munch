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
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'

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

/**
 * The one status a report describes. Named rather than inlined so the query filter, the
 * narrowing guard and the tests all refer to the same value.
 */
const REPORTABLE_STATUS = 'completed'

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

  /**
   * ============================================================================================
   * COMPLETED ONLY, FILTERED AT THE QUERY — NOT HIDDEN AT RENDER TIME
   * ============================================================================================
   *
   * This read `.neq('status', 'cancelled')`, so PENDING orders were in the exported rows. Found on
   * a real terminal trial 2026-09-03: the downloaded Order History contained #84, #76, #75 and #74,
   * all `pending`.
   *
   * The deeper defect was that THE ROWS AND THE SUMMARY WERE NEVER THE SAME DATASET. The rows were
   * every non-cancelled order; the totals below were computed from a separate
   * `payment_status === 'paid'` subset. Measured on production across 90 days: 87 pending orders
   * worth N$11,137 appeared as rows in a report whose Total Revenue read N$203,845 and never
   * counted them. Somebody adding the rows up could not reach the total, and the gap was a whole
   * category of order rather than a rounding difference.
   *
   * So the filter moves to the QUERY and everything below derives from the single set that comes
   * back. Hiding pending rows at render time would have left those two datasets in place.
   *
   * WHY `status = 'completed'` AND NOT `payment_status = 'paid'`: on the same 90 days, `paid` is a
   * strict SUBSET of `completed` -- 3066 are both, ZERO are paid-but-not-completed, and 3 are
   * completed-but-unpaid (N$26 across all venues). Keying on the order's own lifecycle status is
   * what the report claims to show and is the field the exported Status column prints, so the rows
   * and the filter now agree by construction rather than by coincidence.
   */
  let query = supabase
    .from('orders')
    .select('id, order_number, placed_at, table_number, customer_name, status, payment_method, payment_channel, payment_status, total, items')
    .eq('restaurant_id', params.restaurantId)
    .eq('status', REPORTABLE_STATUS)
    .gte('placed_at', startIso)
    .lt('placed_at', endIsoExclusive)
    .order('placed_at', { ascending: false })

  if (params.tableNumber) {
    query = query.eq('table_number', params.tableNumber)
  }
  /**
   * A caller-supplied status can only NARROW, never widen. Anything other than 'completed' yields
   * an empty report rather than reintroducing the rows this filter exists to exclude -- which is
   * what a second `.eq('status', ...)` on the same column does in PostgREST.
   */
  if (params.status && params.status !== 'All' && params.status !== REPORTABLE_STATUS) {
    query = query.eq('status', params.status)
  }

  // #323: THIS PATH REACHES CLIENTS AS A DOCUMENT.
  //
  // It backs the CSV export, the emailed report, and the nightly cron. Unpaginated it was capped at
  // 1000 rows, so a busy month would have produced a PDF that looked complete and under-reported
  // the total. No client has been sent a wrong figure yet -- the largest real restaurant-month on
  // production is FNB ChowNow 2026-07 at 695 orders -- but that is headroom, not safety.
  const rawOrders = await fetchAllRows<{
    id: string
    [key: string]: unknown
  }>(query, { label: 'getReportData' })

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

  /**
   * ONE DATASET. Total Revenue, Total Orders, Average Order Value, the payment split, the refunds
   * and the exported rows are all computed from `rawOrders` -- the completed-only set the query
   * returned -- so the rows reconcile with the summary by construction.
   *
   * This was `rawOrders.filter(payment_status === 'paid')`, a SECOND dataset narrower than the rows
   * being printed beside it. That is what made the totals unreachable by adding up the export.
   */
  const reportedOrders = (rawOrders ?? []) as Array<Record<string, unknown>>
  const grossCompleted = reportedOrders.reduce((sum, o) => sum + Number(o.total ?? 0), 0)
  const refundedDistinct = sumDistinctRefundedAmounts(
    reportedOrders.map((o) => String(o.id)),
    projections,
  )
  const totalRevenue = grossCompleted - refundedDistinct
  const totalOrders = reportedOrders.length
  const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0

  // Payment-method split, computed here rather than by the caller because this is the only
  // place the RAW orders.payment_status is in scope. ReportOrder exposes `paymentStatus`,
  // which is derived from payment_events and is null whenever no SALE row exists, so a split
  // built from it would silently under-count. Gross of refunds, so the parts sum to grossPaid,
  // not to totalRevenue -- refunds are reported separately.
  const splitByMethod = new Map<string, { orders: number; gross: number }>()
  for (const o of reportedOrders) {
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
   * ============================================================================================
   * MEASURED OVER ITS OWN, WIDER SET — 2026-09-03
   * ============================================================================================
   *
   * This counted over `rawOrders`, which was every non-cancelled order. The completed-only filter
   * above would have quietly gutted it: on production over 90 days, orders owing money drop from
   * 87 (worth N$11,137) to the 3 that are completed-but-unpaid. The figure would still have
   * rendered, still been labelled "stranded/pending, surfaced same-day", and been wrong by two
   * orders of magnitude -- a safety signal silently switched off by a reporting change, which is
   * how a stranded payment stops being noticed.
   *
   * It is NOT part of the revenue summary and was not in scope for the completed-only rule: Total
   * Revenue, Total Orders, Average Order Value, the rows and the refunds all describe completed
   * business, whereas this one exists precisely to surface what has NOT completed. So it keeps its
   * own query over the same window and the same non-cancelled population it always had.
   *
   * The `status !== 'cancelled'` half of the old predicate was redundant against that query, which
   * applies `.neq('status', 'cancelled')` itself.
   *
   * MEASURED IMPACT ON STAGING TODAY: none. Read-only over the 14 non-cancelled orders present,
   * `payment_status` is only ever `paid` (7) or `pending` (7), so the two predicates agree
   * exactly and this changes no figure. That is a small, freshly-cleaned sample and is NOT
   * evidence the divergence does not occur elsewhere — the defect is latent, and it fires the
   * moment a cancelled payment sits on a live order. Stated rather than dressed up as a fix for
   * something observed.
   */
  const unresolvedRows = await fetchAllRows<{ id: string; payment_status: unknown }>(
    supabase
      .from('orders')
      .select('id, payment_status')
      .eq('restaurant_id', params.restaurantId)
      .neq('status', 'cancelled')
      .gte('placed_at', startIso)
      .lt('placed_at', endIsoExclusive),
    { label: 'getReportData:unresolved' },
  )
  const unresolvedOrders = (unresolvedRows ?? []).filter((o) => owesMoney(o.payment_status as string)).length

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
