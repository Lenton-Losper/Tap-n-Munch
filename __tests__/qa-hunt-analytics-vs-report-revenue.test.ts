/**
 * BUG REPRO (bug-hunter): two revenue figures are computed from the same orders by
 * two different predicates, and they disagree.
 *
 *   lib/supabase/analytics.ts:30-38 (dashboard)
 *     .eq('payment_status', 'paid')            <- no status filter, no refund awareness
 *
 *   lib/reports/get-report-data.ts:82-86, :133-139 (emailed / PDF report)
 *     .neq('status', 'cancelled')
 *     ...then filter payment_status === 'paid', minus sumDistinctRefundedAmounts()
 *
 * Divergence 1: an order that is status='cancelled' AND payment_status='paid'
 *   -- reachable via app/api/tables/[tableNumber]/close/route.ts:50-62 and
 *   app/api/webhooks/paycloud/route.ts:69-82, both reproduced in sibling qa-hunt tests --
 *   is counted by the dashboard and excluded from the report.
 *
 * Divergence 2: a refund writes payment_events only and never changes
 *   orders.payment_status, so the dashboard reports 100% of a fully refunded order.
 *
 * These assert CURRENT behaviour; they should FAIL once the two agree.
 */
import { calculateDailyAnalytics } from '@/lib/supabase/analytics'
import { getReportData } from '@/lib/reports/get-report-data'

const DATE = '2026-07-30'
const RESTAURANT_ID = 'rest-1'

type Row = Record<string, any>

let tables: Record<string, Row[]> = {}

function queryBuilder(rows: Row[]) {
  const filters: Array<(r: Row) => boolean> = []
  const apply = () => rows.filter((r) => filters.every((f) => f(r)))
  const b: Record<string, any> = {
    eq(c: string, v: unknown) {
      filters.push((r) => r[c] === v)
      return b
    },
    neq(c: string, v: unknown) {
      filters.push((r) => r[c] !== v)
      return b
    },
    gte(c: string, v: unknown) {
      filters.push((r) => String(r[c]) >= String(v))
      return b
    },
    lte(c: string, v: unknown) {
      filters.push((r) => String(r[c]) <= String(v))
      return b
    },
    lt(c: string, v: unknown) {
      filters.push((r) => String(r[c]) < String(v))
      return b
    },
    in(c: string, vs: unknown[]) {
      filters.push((r) => vs.includes(r[c]))
      return b
    },
    overlaps(c: string, vs: unknown[]) {
      filters.push(
        (r) => Array.isArray(r[c]) && r[c].some((x: unknown) => vs.includes(String(x))),
      )
      return b
    },
    order() {
      return b
    },
    single: async () => {
      const m = apply()
      return { data: m[0] ?? null, error: m[0] ? null : { message: 'not found' } }
    },
    maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
    then(resolve: (v: unknown) => void) {
      resolve({ data: apply(), error: null })
    },
  }
  return b
}

const supabaseMock = {
  from: (table: string) => ({
    select: () => queryBuilder(tables[table] ?? []),
  }),
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => supabaseMock,
}))
// analytics.ts also imports a module-level browser client; never used on these paths.
jest.mock('@/lib/supabase/client', () => ({ supabase: {} }))

function baseTables(orders: Row[], paymentEvents: Row[] = []) {
  return {
    restaurants: [
      { id: RESTAURANT_ID, name: 'Test Cafe', logo_url: null, timezone: 'UTC' },
    ],
    orders,
    payment_events: paymentEvents,
  }
}

const report = () =>
  getReportData({ restaurantId: RESTAURANT_ID, startDate: DATE, endDate: DATE })

describe('dashboard analytics vs emailed report -- same orders, different revenue', () => {
  it('DIVERGENCE 1: a cancelled-but-paid order is revenue on the dashboard and absent from the report', async () => {
    tables = baseTables([
      {
        id: 'ord-cancelled-paid',
        restaurant_id: RESTAURANT_ID,
        order_number: 101,
        placed_at: `${DATE}T12:00:00.000Z`,
        status: 'cancelled',
        payment_status: 'paid',
        total: 250,
        tax: 0,
        tip: 0,
        items: [],
      },
    ])

    const analytics = await calculateDailyAnalytics(RESTAURANT_ID, DATE)
    const reportData = await report()

    expect(analytics.total_revenue).toBe(250)
    expect(analytics.total_orders).toBe(1)

    expect(reportData.summary.totalRevenue).toBe(0)
    expect(reportData.summary.totalOrders).toBe(0)

    // The headline number differs by the full value of the order.
    expect(analytics.total_revenue - reportData.summary.totalRevenue).toBe(250)
  })

  it('DIVERGENCE 2: a fully refunded order counts 100% on the dashboard and 0 in the report', async () => {
    tables = baseTables(
      [
        {
          id: 'ord-refunded',
          restaurant_id: RESTAURANT_ID,
          order_number: 102,
          placed_at: `${DATE}T12:00:00.000Z`,
          status: 'completed',
          payment_status: 'paid', // refunds never change this
          total: 200,
          tax: 0,
          tip: 0,
          items: [],
        },
      ],
      [
        {
          restaurant_id: RESTAURANT_ID,
          event_type: 'sale',
          business_order_no: 'FT-SALE-1',
          origin_business_order_no: null,
          order_ids: ['ord-refunded'],
          amount: 200,
          currency: 'NAD',
          created_at: `${DATE}T12:05:00.000Z`,
        },
        {
          restaurant_id: RESTAURANT_ID,
          event_type: 'refund_succeeded',
          business_order_no: 'FT-REFUND-1',
          origin_business_order_no: 'FT-SALE-1',
          order_ids: ['ord-refunded'],
          amount: 200,
          currency: 'NAD',
          created_at: `${DATE}T13:00:00.000Z`,
        },
      ],
    )

    const analytics = await calculateDailyAnalytics(RESTAURANT_ID, DATE)
    const reportData = await report()

    expect(analytics.total_revenue).toBe(200) // refund invisible to the dashboard
    expect(reportData.summary.totalRevenue).toBe(0) // report nets it out
  })

  it('CONTROL: an ordinary completed+paid order with no refund agrees on both sides', async () => {
    tables = baseTables([
      {
        id: 'ord-normal',
        restaurant_id: RESTAURANT_ID,
        order_number: 103,
        placed_at: `${DATE}T12:00:00.000Z`,
        status: 'completed',
        payment_status: 'paid',
        total: 150,
        tax: 0,
        tip: 0,
        items: [],
      },
    ])

    const analytics = await calculateDailyAnalytics(RESTAURANT_ID, DATE)
    const reportData = await report()

    // Proves the divergences above are caused by status/refund handling specifically,
    // not by an artefact of the test harness.
    expect(analytics.total_revenue).toBe(150)
    expect(reportData.summary.totalRevenue).toBe(150)
  })
})
