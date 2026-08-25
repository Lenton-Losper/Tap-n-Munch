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
  return filters.every(([col, val]) => {
    if (Array.isArray(val)) return val.includes(row[col])
    // PostgREST `.is(col, null)` matches SQL NULL. An absent property in a fixture is the
    // same thing here, so treat undefined and null as equivalent for a null comparison.
    if (val === null) return row[col] === null || row[col] === undefined
    return row[col] === val
  })
}

/** #120's guard reads these two. Empty by default: an unblocked close, exactly as before. */
let tabsAtTable: Array<{ id: string }> = []
let tabsReadError: { message: string } | null = null
let pendingRequests: Array<Record<string, unknown>> = []

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
              is(col: string, val: unknown) {
                filters.push([col, val])
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
    /**
     * #120 — this route now runs `guardTableClose` before closing, which reads `tabs` and
     * `order_requests`. That is a NEW TABLE ACCESS on a route this suite mocks strictly, so
     * without these two cases EVERY test here fails with `unexpected table tabs` — not because
     * payment safety broke, but because the harness had never seen the query.
     *
     * TAUGHT, NOT SILENCED. `pendingRequests` defaults to empty, so the payment-safety tests run
     * against an unblocked close as they always did; the test at the bottom fills it and asserts
     * the close is REFUSED, so these cases are exercised both ways rather than being a green stub.
     */
    if (table === 'tabs') {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        then(resolve: (v: unknown) => void) {
          resolve({ data: tabsAtTable, error: tabsReadError })
        },
      }
      return b
    }
    if (table === 'order_requests') {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        range: () => b,
        order: () => b,
        then(resolve: (v: unknown) => void) {
          resolve({ data: pendingRequests, error: null })
        },
      }
      return b
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
    tabsAtTable = []
    tabsReadError = null
    pendingRequests = []
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

  it('preserves an EXISTING completed_at instead of re-stamping it to the close time', async () => {
    // An order settled earlier on the terminal already carries its real completion moment.
    // Blanket-setting completed_at on close destroyed it and skewed time-to-complete
    // reporting. Caught on deployed staging, where a terminal payment at 09:50:51.536 was
    // re-stamped to 09:50:55.815 by the close.
    const realCompletion = '2026-07-30T09:50:51.536+00:00'
    orders = [
      baseOrder({
        id: 'ord-already-completed',
        status: 'completed',
        payment_status: 'paid',
        completed_at: realCompletion,
      }),
    ]

    await closeTable()

    expect(orders[0].completed_at).toBe(realCompletion)
    expect(orders[0].is_closed).toBe(true)
  })

  it('DOES stamp completed_at when the paid order has none yet', async () => {
    orders = [baseOrder({ id: 'ord-paid-no-ts', status: 'ready', payment_status: 'paid' })]

    await closeTable()

    expect(orders[0].status).toBe('completed')
    expect(orders[0].completed_at).toEqual(expect.any(String))
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


/**
 * #120 — THE GUARD IS REACHED FROM THIS ROUTE, and these assertions are why the two mock cases
 * above are not a permanent green stub.
 *
 * The dashboard's close was UNGUARDED until 2026-08-25 while the terminal's was not: two routes
 * doing one job with the rule written into only one of them. It closed tables over undecided
 * `order_requests`, which is the original #120 defect — the round is missing from the bill and
 * re-inflates the tab once it is finally accepted.
 */
describe('POST /api/tables/[tableNumber]/close -- #120: it will not close over an undecided round', () => {
  beforeEach(() => {
    updateLog = []
    readError = null
    updateError = null
    closeTableSession.mockClear()
    tabsAtTable = []
    tabsReadError = null
    pendingRequests = []
  })

  it('REFUSES with 409 when a round is waiting for review, and does not close', async () => {
    orders = []
    tabsAtTable = [{ id: 'tab-1' }]
    pendingRequests = [
      { id: 'req-1', tab_id: 'tab-1', table_id: 'table-uuid-1', status: 'waiting_review', total: 60, placed_at: '2026-08-25T10:00:00Z' },
    ]
    const res = await closeTable()
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('PENDING_ORDER_REQUESTS')
    // The close must not have happened at all.
    expect(closeTableSession).not.toHaveBeenCalled()
  })

  it('the 409 names the blocking row AND its status, so a caller can offer the right action', async () => {
    orders = []
    tabsAtTable = [{ id: 'tab-1' }]
    pendingRequests = [
      { id: 'req-stranded', tab_id: 'tab-1', table_id: 'table-uuid-1', status: 'accepting', total: 40, placed_at: '2026-08-25T10:00:00Z' },
    ]
    const body = await (await closeTable()).json()
    expect(body.pending_request_ids).toContain('req-stranded')
    // Without the status a caller cannot tell a stranded claim from a real round, and offering the
    // release button for a `waiting_review` row would be #120's bug from the other side.
    expect(body.pending_requests[0].status).toBe('accepting')
  })

  it('FAILS CLOSED: an unreadable tabs list is not an empty one', async () => {
    orders = []
    tabsReadError = { message: 'connection reset' }
    const res = await closeTable()
    expect(res.status).toBe(503)
    expect(closeTableSession).not.toHaveBeenCalled()
  })

  it('CONTROL: with nothing pending it still closes — the guard is not blocking everything', async () => {
    orders = []
    tabsAtTable = [{ id: 'tab-1' }]
    pendingRequests = []
    const res = await closeTable()
    expect(res.status).toBe(200)
    expect(closeTableSession).toHaveBeenCalled()
  })
})