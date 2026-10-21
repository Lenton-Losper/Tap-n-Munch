import { NextResponse } from 'next/server'
import { isAuthError, requireStaffPermission } from '@/lib/api/require-staff-permission'
import { PERMISSIONS } from '@/lib/permissions'
import { resolveRestaurantUuid } from '@/lib/supabase/restaurants'
import { fetchAllRows } from '@/lib/supabase/fetch-all-rows'
import { addCalendarDays } from '@/lib/reports/date-range-presets'
import { calendarDateRangeToUtcIso, DEFAULT_REPORT_TIMEZONE } from '@/lib/reports/format-report-datetime'
import {
  buildPaymentMethodBreakdown,
  type PaidOrder,
  type RefundEvent,
  type SettlementEvent,
} from '@/lib/analytics/payment-method-breakdown'

export const dynamic = 'force-dynamic'

/** A year of daily rows is the most the page can sensibly show; it also bounds the reads below. */
const MAX_RANGE_DAYS = 366

const YMD = /^\d{4}-\d{2}-\d{2}$/

function isRealDate(ymd: string): boolean {
  return YMD.test(ymd) && !Number.isNaN(new Date(`${ymd}T00:00:00Z`).getTime())
}

/** Whole currency units (numeric column) to integer cents. */
const toCents = (n: unknown) => Math.round((Number(n) || 0) * 100)

type EventRow = {
  id: string
  amount: number | string
  created_at: string
  order_ids: string[] | null
  origin: string | null
  terminal_id: string | null
}
type NonGatewayRow = {
  id: string
  method: string | null
  amount_cents: number
  created_at: string
  order_ids: string[] | null
  origin: string | null
  terminal_id: string | null
}
type OrderRow = { id: string; payment_method: string | null; total: number | string | null; paid_at: string }

/** Ceiling per read. Crossing it throws (see fetchAllRows) instead of returning a truncated total. */
const MAX_ROWS = 150_000

/** Order ids per coverage lookup; keeps the `ov.{...}` filter well inside URL limits. */
const COVERAGE_CHUNK = 100

/**
 * Settlement-ledger breakdown by payment method. See lib/analytics/payment-method-breakdown.ts for
 * the contract; this route only gathers rows.
 *
 * EVERY READ IS SCOPED BY `restaurant_id`. The client below is the service role, which bypasses RLS,
 * so that filter is the whole tenant boundary -- authorisation proves the caller belongs to
 * restaurantUuid, and these filters keep the data to restaurantUuid.
 *
 * Every read is widened by a day either side and the aggregation filters each row back to the
 * requested local days with Intl. The DB bounds therefore only have to be generous, not exact, and
 * a time-zone offset-probe error (calendarDateRangeToUtcIso is exact for Windhoek, approximate
 * around a DST change elsewhere) cannot lose a row.
 *
 * COVERAGE IS NOT INFERRED FROM THE DATE MARGIN. A paid order whose settlement row was stamped more
 * than a day away (a device sale promoted or reconciled later) would be reported as a gap. So any
 * paid order not matched by the fetched rows is looked up directly by order_ids, with no date bound,
 * and only an order that still matches nothing is reported as uncovered.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const restaurantId = (searchParams.get('restaurantId') || '').trim()
  const startDate = (searchParams.get('startDate') || '').trim()
  const endDate = (searchParams.get('endDate') || '').trim()

  if (!restaurantId) {
    return NextResponse.json({ error: 'restaurantId is required' }, { status: 400 })
  }
  if (!isRealDate(startDate) || !isRealDate(endDate)) {
    return NextResponse.json({ error: 'startDate and endDate must be YYYY-MM-DD' }, { status: 400 })
  }
  if (startDate > endDate) {
    return NextResponse.json({ error: 'startDate must not be after endDate' }, { status: 400 })
  }
  if (addCalendarDays(startDate, MAX_RANGE_DAYS) <= endDate) {
    return NextResponse.json({ error: `Range is limited to ${MAX_RANGE_DAYS} days` }, { status: 400 })
  }

  let restaurantUuid: string
  try {
    restaurantUuid = await resolveRestaurantUuid(restaurantId)
  } catch {
    return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
  }
  const auth = await requireStaffPermission(restaurantUuid, PERMISSIONS.ANALYTICS_VIEW, req)
  if (isAuthError(auth)) return auth

  try {
    const { data: venue } = await auth.supabase
      .from('restaurants')
      .select('timezone')
      .eq('id', restaurantUuid)
      .maybeSingle()
    const timeZone =
      typeof venue?.timezone === 'string' && venue.timezone.trim() ? venue.timezone.trim() : DEFAULT_REPORT_TIMEZONE

    const wide = calendarDateRangeToUtcIso(addCalendarDays(startDate, -1), addCalendarDays(endDate, 1), timeZone)

    const [gateway, nonGateway, refundRows, orders] = await Promise.all([
      fetchAllRows<EventRow>(
        auth.supabase
          .from('payment_events')
          .select('id, amount, created_at, order_ids, origin, terminal_id')
          .eq('restaurant_id', restaurantUuid)
          .eq('event_type', 'sale')
          .gte('created_at', wide.startIso)
          .lt('created_at', wide.endIsoExclusive)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true }),
        { label: 'payment-methods:gateway', maxRows: MAX_ROWS },
      ),
      fetchAllRows<NonGatewayRow>(
        auth.supabase
          .from('non_gateway_payment_events')
          .select('id, method, amount_cents, created_at, order_ids, origin, terminal_id')
          .eq('restaurant_id', restaurantUuid)
          .gte('created_at', wide.startIso)
          .lt('created_at', wide.endIsoExclusive)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true }),
        { label: 'payment-methods:non-gateway', maxRows: MAX_ROWS },
      ),
      fetchAllRows<EventRow>(
        auth.supabase
          .from('payment_events')
          .select('id, amount, created_at, order_ids, origin, terminal_id')
          .eq('restaurant_id', restaurantUuid)
          .eq('event_type', 'refund_succeeded')
          .gte('created_at', wide.startIso)
          .lt('created_at', wide.endIsoExclusive)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true }),
        { label: 'payment-methods:refunds', maxRows: MAX_ROWS },
      ),
      fetchAllRows<OrderRow>(
        auth.supabase
          .from('orders')
          .select('id, payment_method, total, paid_at')
          .eq('restaurant_id', restaurantUuid)
          .eq('payment_status', 'paid')
          .gte('paid_at', wide.startIso)
          .lt('paid_at', wide.endIsoExclusive)
          .order('paid_at', { ascending: true })
          .order('id', { ascending: true }),
        { label: 'payment-methods:orders', maxRows: MAX_ROWS },
      ),
    ])

    const events: SettlementEvent[] = [
      ...gateway.map((r) => ({
        id: `gateway:${r.id}`,
        source: 'gateway' as const,
        method: null,
        amountCents: toCents(r.amount),
        createdAt: r.created_at,
        orderIds: r.order_ids ?? [],
        origin: r.origin ?? 'gateway',
        terminalId: r.terminal_id,
      })),
      ...nonGateway.map((r) => ({
        id: `non_gateway:${r.id}`,
        source: 'non_gateway' as const,
        method: r.method,
        amountCents: Number(r.amount_cents) || 0,
        createdAt: r.created_at,
        orderIds: r.order_ids ?? [],
        origin: r.origin,
        terminalId: r.terminal_id,
      })),
    ]
    const refunds: RefundEvent[] = refundRows.map((r) => ({
      id: r.id,
      amountCents: toCents(r.amount),
      createdAt: r.created_at,
      orderIds: r.order_ids ?? [],
    }))
    const paidOrders: PaidOrder[] = orders.map((o) => ({
      id: o.id,
      paymentMethod: o.payment_method,
      totalCents: toCents(o.total),
      paidAt: o.paid_at,
    }))

    // Direct coverage lookup for every paid order the fetched ledger rows do not mention.
    const mentioned = new Set<string>()
    events.forEach((e) => e.orderIds.forEach((id) => mentioned.add(id)))
    const unmatched = paidOrders.map((o) => o.id).filter((id) => !mentioned.has(id))
    const coveredElsewhere = new Set<string>()
    for (let i = 0; i < unmatched.length; i += COVERAGE_CHUNK) {
      const chunk = unmatched.slice(i, i + COVERAGE_CHUNK)
      const wanted = new Set(chunk)
      const [g, n] = await Promise.all([
        fetchAllRows<{ order_ids: string[] | null }>(
          auth.supabase
            .from('payment_events')
            .select('order_ids')
            .eq('restaurant_id', restaurantUuid)
            .eq('event_type', 'sale')
            .overlaps('order_ids', chunk)
            .order('id', { ascending: true }),
          { label: 'payment-methods:coverage-gateway' },
        ),
        fetchAllRows<{ order_ids: string[] | null }>(
          auth.supabase
            .from('non_gateway_payment_events')
            .select('order_ids')
            .eq('restaurant_id', restaurantUuid)
            .overlaps('order_ids', chunk)
            .order('id', { ascending: true }),
          { label: 'payment-methods:coverage-non-gateway' },
        ),
      ])
      for (const row of [...g, ...n]) {
        for (const id of row.order_ids ?? []) if (wanted.has(id)) coveredElsewhere.add(id)
      }
    }

    return NextResponse.json(
      buildPaymentMethodBreakdown({
        startDate,
        endDate,
        timeZone,
        events,
        refunds,
        paidOrders,
        coveredElsewhere: [...coveredElsewhere],
      }),
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[analytics/payment-methods] failed', { restaurantUuid, error: err })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
