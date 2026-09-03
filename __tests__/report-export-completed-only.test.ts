/**
 * ORDER HISTORY EXPORT — COMPLETED ORDERS ONLY, AND THE SUMMARY MUST RECONCILE WITH THE ROWS.
 *
 * Found on a real terminal trial 2026-09-03: the downloaded Order History contained #84, #76, #75
 * and #74, all `pending`.
 *
 * The reported symptom was pending rows. The defect underneath was that THE ROWS AND THE SUMMARY
 * WERE NEVER THE SAME DATASET -- the rows were every non-cancelled order, while Total Revenue,
 * Total Orders and Average Order Value were computed from a separate `payment_status === 'paid'`
 * subset. Measured on production over 90 days: 87 pending orders worth N$11,137 printed as rows in
 * a report whose Total Revenue read N$203,845 and never counted them.
 *
 * So there are two assertions here, and BOTH are load-bearing:
 *
 *   1. the filter is applied AT THE QUERY -- `.eq('status','completed')` -- not by hiding rows
 *      afterwards. Hiding them at render time would leave the two datasets in place.
 *   2. the summary is arithmetic over exactly the rows returned. This is what "reconcile" means:
 *      somebody adding up the exported rows reaches Total Revenue.
 *
 * The Supabase client is mocked, so the mock decides what comes back -- which is precisely why
 * assertion 1 checks the FILTER THAT WAS SENT rather than the shape of the response. A test that
 * only fed it completed rows and checked completed rows came out would pass against the bug.
 */
import { getReportData } from '@/lib/reports/get-report-data'

type Row = Record<string, unknown>

/** Every filter applied to the `orders` reads, in order, so the query itself can be asserted. */
let ordersFilters: Array<[string, unknown]>
let ordersSelects: string[]
let ordersRows: Row[]
let unresolvedRows: Row[]
let ordersQueryCount: number

function chain(rowsFor: () => Row[], record?: (m: string, a: unknown[]) => void) {
  const self: Record<string, unknown> = {}
  const passthrough = (name: string) => (...args: unknown[]) => {
    record?.(name, args)
    return self
  }
  for (const m of ['select', 'eq', 'neq', 'gte', 'lt', 'order', 'in', 'limit']) {
    self[m] = passthrough(m)
  }
  // fetchAllRows drives paging with .range(); one short page ends it.
  self.range = async () => ({ data: rowsFor(), error: null })
  self.single = async () => ({ data: rowsFor()[0] ?? null, error: null })
  self.maybeSingle = async () => ({ data: rowsFor()[0] ?? null, error: null })
  self.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rowsFor(), error: null }).then(res, rej)
  return self
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'restaurants') {
        return chain(() => [
          { id: 'r1', name: 'Riviera', logo_url: null, timezone: 'Africa/Windhoek' },
        ])
      }
      if (table === 'orders') {
        ordersQueryCount += 1
        // The FIRST orders query is the report body; the second is the separate unresolved count,
        // which is deliberately measured over a wider, non-cancelled population.
        const isReportQuery = ordersQueryCount === 1
        return chain(
          () => (isReportQuery ? ordersRows : unresolvedRows),
          (method, args) => {
            if (!isReportQuery) return
            if (method === 'select') ordersSelects.push(String(args[0]))
            if (method === 'eq' || method === 'neq') {
              ordersFilters.push([`${method}:${String(args[0])}`, args[1]])
            }
          },
        )
      }
      throw new Error(`unexpected table in test: ${table}`)
    },
  }),
}))

jest.mock('@/lib/payments/get-payment-projection', () => ({
  getPaymentProjections: async () => new Map(),
  sumDistinctRefundedAmounts: () => 0,
}))

const order = (over: Row): Row => ({
  id: `o-${Math.random()}`,
  order_number: 1,
  placed_at: '2026-09-02T10:00:00Z',
  table_number: 4,
  customer_name: null,
  status: 'completed',
  payment_method: 'card',
  payment_channel: 'terminal',
  payment_status: 'paid',
  total: 100,
  items: [],
  ...over,
})

beforeEach(() => {
  ordersFilters = []
  ordersSelects = []
  ordersQueryCount = 0
  ordersRows = []
  unresolvedRows = []
})

const params = { restaurantId: 'r1', startDate: '2026-09-01', endDate: '2026-09-03' }

describe('the export filters at the QUERY, not in the spreadsheet', () => {
  it("restricts the report read to status = 'completed'", async () => {
    ordersRows = [order({ order_number: 10 })]
    await getReportData(params)
    expect(ordersFilters).toContainEqual(['eq:status', 'completed'])
  })

  it("no longer merely excludes cancelled — which is what let pending through", async () => {
    // The exact regression. `.neq('status','cancelled')` admits pending, ready, confirmed and
    // preparing, which is how #84/#76/#75/#74 reached a customer-facing document.
    ordersRows = [order({})]
    await getReportData(params)
    const neqStatus = ordersFilters.filter(([k]) => k === 'neq:status')
    expect(neqStatus).toHaveLength(0)
  })

  it('still scopes to the restaurant — the filter must narrow, never replace', async () => {
    ordersRows = [order({})]
    await getReportData(params)
    expect(ordersFilters).toContainEqual(['eq:restaurant_id', 'r1'])
  })

  it('a caller-supplied status can only narrow, never widen back to pending', async () => {
    ordersRows = []
    await getReportData({ ...params, status: 'pending' })
    // Both filters are applied, so PostgREST returns the intersection: empty.
    expect(ordersFilters).toContainEqual(['eq:status', 'completed'])
    expect(ordersFilters).toContainEqual(['eq:status', 'pending'])
  })
})

describe('the summary reconciles with the exported rows', () => {
  it('Total Orders equals the number of rows exported', async () => {
    ordersRows = [order({ total: 120 }), order({ total: 80 }), order({ total: 35 })]
    const report = await getReportData(params)
    expect(report.orders).toHaveLength(3)
    expect(report.summary.totalOrders).toBe(3)
  })

  it('Total Revenue equals the sum of the exported row totals', async () => {
    ordersRows = [order({ total: 120 }), order({ total: 80 }), order({ total: 35 })]
    const report = await getReportData(params)
    const rowSum = report.orders.reduce((s, o) => s + o.total, 0)
    expect(report.summary.totalRevenue).toBe(rowSum)
    expect(report.summary.totalRevenue).toBe(235)
  })

  it('Average Order Value is Total Revenue over Total Orders', async () => {
    ordersRows = [order({ total: 120 }), order({ total: 80 })]
    const report = await getReportData(params)
    expect(report.summary.averageOrderValue).toBeCloseTo(
      report.summary.totalRevenue / report.summary.totalOrders,
      6,
    )
  })

  it('counts an unpaid COMPLETED order in both the rows and the totals', async () => {
    /**
     * The reconciliation case that the old code got wrong in the other direction. Totals came from
     * a `payment_status === 'paid'` subset, so a completed-but-unpaid order printed as a row and
     * was missing from the total. Production has 3 such orders (N$26 over 90 days) -- small, but
     * it is exactly the shape that makes a document fail to add up.
     */
    ordersRows = [order({ total: 100 }), order({ total: 26, payment_status: 'pending' })]
    const report = await getReportData(params)
    expect(report.orders).toHaveLength(2)
    expect(report.summary.totalOrders).toBe(2)
    expect(report.summary.totalRevenue).toBe(126)
  })

  it('the payment-method split sums to Total Revenue when nothing is refunded', async () => {
    ordersRows = [
      order({ total: 120, payment_method: 'card' }),
      order({ total: 80, payment_method: 'cash' }),
      order({ total: 35, payment_method: 'card' }),
    ]
    const report = await getReportData(params)
    const splitSum = report.summary.paymentMethodSplit.reduce((s, m) => s + m.gross, 0)
    expect(splitSum).toBe(report.summary.totalRevenue)
  })

  it('an empty report reports zero rather than dividing by zero', async () => {
    ordersRows = []
    const report = await getReportData(params)
    expect(report.summary.totalOrders).toBe(0)
    expect(report.summary.totalRevenue).toBe(0)
    expect(report.summary.averageOrderValue).toBe(0)
  })
})

describe('the stranded-payment signal keeps its own, wider population', () => {
  it('counts unpaid orders that the completed-only report does NOT list', async () => {
    /**
     * `unresolvedOrders` exists to surface money nobody has collected. It is NOT part of the
     * revenue summary, and it must not be narrowed to completed orders: on production that would
     * take it from 87 orders (N$11,137) to the 3 completed-but-unpaid ones, while still rendering
     * under the label "stranded/pending". A safety signal switched off by a reporting change is
     * how a stranded payment stops being noticed.
     */
    ordersRows = [order({ total: 100 })]
    unresolvedRows = [
      { id: 'u1', payment_status: 'pending' },
      { id: 'u2', payment_status: 'pending' },
      { id: 'u3', payment_status: 'paid' },
    ]
    const report = await getReportData(params)
    expect(report.orders).toHaveLength(1)
    expect(report.summary.unresolvedOrders).toBe(2)
  })
})
