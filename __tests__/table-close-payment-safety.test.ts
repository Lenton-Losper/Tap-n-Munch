/**
 * Regression tests: POST /api/tables/[tableNumber]/close must never fabricate a payment.
 *
 * Closing a table is a housekeeping action. Previously it bulk-wrote
 * status='completed', payment_status='paid', paid_at on every order matching only
 * (restaurant_id, table_number, is_closed=false) -- with no payment guard -- so any
 * unpaid or cancelled order at that table was recorded as revenue that was never
 * collected. The three automated cancel paths never set is_closed
 * (auto-cancel-stale-pos-orders.ts, handle-terminal-payment-failed.ts,
 * expire-hosted-pending-orders.ts), so cron-cancelled orders were swept too.
 *
 * Required behaviour now:
 *   - genuinely paid orders  -> closed AND completed
 *   - everything else        -> detached from the table only (is_closed/table_closed),
 *                               payment_status / paid_at / status left untouched
 */
import { POST } from '@/app/api/tables/[tableNumber]/close/route'

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (id: string) => `uuid-${id}`,
}))

jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (v: unknown) => v instanceof Response,
  requireStaffPermission: async () => ({ userId: 'staff-1' }),
}))

const closeTableSession = jest.fn(async (..._args: unknown[]) => ({
  success: true,
  tabs_settled: 1,
}))
jest.mock('@/lib/session-manager', () => ({
  closeTableSession: (...args: unknown[]) => closeTableSession(...args),
}))

type OrderRow = Record<string, unknown> & { id: string }
type UpdateLog = { patch: Record<string, unknown>; filterCols: string[] }

let orders: OrderRow[] = []
let updateLog: UpdateLog[] = []
let readError: unknown = null
let updateError: unknown = null

function matches(row: OrderRow, filters: Array<[string, unknown]>): boolean {
  return filters.every(([col, val]) =>
    Array.isArray(val) ? val.includes(row[col]) : row[col] === val,
  )
}

function makeSupabaseMock() {
  return {
    from: (table: string) => {
      if (table === 'restaurant_tables') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { id: 'table-uuid-1' }, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'orders') {
        return {
          select: () => {
            const filters: Array<[string, unknown]> = []
            const b: Record<string, unknown> = {
              eq(col: string, val: unknown) {
                filters.push([col, val])
                return b
              },
              then(resolve: (v: unknown) => void) {
                if (readError) return resolve({ data: null, error: readError })
                resolve({ data: orders.filter((r) => matches(r, filters)), error: null })
              },
            }
            return b
          },
          update: (patch: Record<string, unknown>) => {
            const filters: Array<[string, unknown]> = []
            const b: Record<string, unknown> = {
              eq(col: string, val: unknown) {
                filters.push([col, val])
                return b
              },
              in(col: string, vals: unknown[]) {
                filters.push([col, vals])
                return b
              },
              then(resolve: (v: unknown) => void) {
                updateLog.push({ patch, filterCols: filters.map(([c]) => c) })
                if (updateError) return resolve({ data: null, error: updateError })
                const hit = orders.filter((r) => matches(r, filters))
                for (const r of hit) Object.assign(r, patch)
                resolve({ data: hit, error: null })
              },
            }
            return b
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabaseMock(),
}))

function makeReq() {
  return new Request('https://example.test/api/tables/7/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: 'rest-1' }),
  })
}

const closeTable = () => POST(makeReq(), { params: Promise.resolve({ tableNumber: '7' }) })

const baseOrder = (over: Partial<OrderRow>): OrderRow => ({
  id: 'ord',
  restaurant_id: 'uuid-rest-1',
  table_number: 7,
  is_closed: false,
  total: 100,
  ...over,
}) as OrderRow

describe('POST /api/tables/[tableNumber]/close -- must not fabricate payment', () => {
  beforeEach(() => {
    updateLog = []
    readError = null
    updateError = null
    closeTableSession.mockClear()
  })

  it('does NOT mark a cron-cancelled order as paid', async () => {
    orders = [
      baseOrder({
        id: 'ord-cancelled-by-cron',
        status: 'cancelled',
        payment_status: 'cancelled',
        cancellation_reason: 'auto_timeout',
      }),
    ]

    const res = await closeTable()
    expect(res.status).toBe(200)

    const o = orders[0]
    expect(o.payment_status).toBe('cancelled')
    expect(o.status).toBe('cancelled')
    expect(o.paid_at).toBeUndefined()
    // still detached from the table
    expect(o.is_closed).toBe(true)
    expect(o.table_closed).toBe(true)
  })

  it('does NOT fabricate revenue from a never-paid order', async () => {
    orders = [baseOrder({ id: 'ord-never-paid', status: 'ready', payment_status: 'unpaid' })]

    await closeTable()

    expect(orders[0].payment_status).toBe('unpaid')
    expect(orders[0].status).toBe('ready')
    expect(orders[0].paid_at).toBeUndefined()
    expect(orders[0].is_closed).toBe(true)
  })

  it('completes an order that was genuinely paid', async () => {
    orders = [baseOrder({ id: 'ord-paid', status: 'ready', payment_status: 'paid' })]

    await closeTable()

    expect(orders[0].status).toBe('completed')
    expect(orders[0].payment_status).toBe('paid')
    expect(orders[0].completed_at).toEqual(expect.any(String))
    expect(orders[0].is_closed).toBe(true)
  })

  it('MIXED table: completes only the paid order, detaches the rest untouched', async () => {
    orders = [
      baseOrder({ id: 'ord-paid', status: 'ready', payment_status: 'paid', total: 100 }),
      baseOrder({ id: 'ord-unpaid', status: 'ready', payment_status: 'unpaid', total: 250 }),
      baseOrder({ id: 'ord-cancelled', status: 'cancelled', payment_status: 'cancelled', total: 80 }),
    ]

    const res = await closeTable()
    const body = await res.json()

    expect(body.completed).toBe(1)
    expect(body.closedUnpaid).toBe(2)

    const byId = Object.fromEntries(orders.map((o) => [o.id, o]))
    expect(byId['ord-paid'].status).toBe('completed')
    expect(byId['ord-unpaid'].payment_status).toBe('unpaid')
    expect(byId['ord-unpaid'].status).toBe('ready')
    expect(byId['ord-cancelled'].payment_status).toBe('cancelled')
    // every order is detached from the table regardless of payment state
    expect(orders.every((o) => o.is_closed === true && o.table_closed === true)).toBe(true)
  })

  it('CASING: a capitalised "Paid" is recognised as paid, not swept as unpaid', async () => {
    // A byte-exact SQL .eq('payment_status','paid') would misclassify this row.
    orders = [baseOrder({ id: 'ord-capital-paid', status: 'ready', payment_status: 'Paid' })]

    await closeTable()

    expect(orders[0].status).toBe('completed')
    expect(orders[0].payment_status).toBe('Paid')
  })

  it('never issues an UPDATE whose patch sets payment_status or paid_at', async () => {
    orders = [
      baseOrder({ id: 'a', payment_status: 'paid', status: 'ready' }),
      baseOrder({ id: 'b', payment_status: 'unpaid', status: 'ready' }),
    ]

    await closeTable()

    expect(updateLog.length).toBeGreaterThan(0)
    for (const u of updateLog) {
      expect(u.patch).not.toHaveProperty('payment_status')
      expect(u.patch).not.toHaveProperty('paid_at')
    }
  })

  it('issues NO order write at all when the table has no open orders', async () => {
    orders = []
    await closeTable()
    expect(updateLog).toHaveLength(0)
  })

  it('fails loudly (500) if reading the open orders errors, instead of reporting success', async () => {
    orders = []
    readError = { message: 'boom' }

    const res = await closeTable()
    expect(res.status).toBe(500)
  })

  it('fails loudly (500) if the write errors, instead of reporting success', async () => {
    orders = [baseOrder({ id: 'ord-paid', payment_status: 'paid', status: 'ready' })]
    updateError = { message: 'boom' }

    const res = await closeTable()
    expect(res.status).toBe(500)
  })
})
