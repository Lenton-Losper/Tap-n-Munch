/**
 * The tab-total recalculation in POST /api/terminal/tabs/[tabId]/settle is the UNION of two
 * fixes that arrived on different branches and collided in a merge. This suite pins both halves
 * SEPARATELY, so that a future change to either one announces itself on its own.
 *
 *   HALF 1 (#104) -- WHAT the total should be.
 *     The rows are partitioned with owesMoney(), not with `.neq('payment_status','paid')`.
 *     "Not paid" is true of a CANCELLED order, so a cancelled order's money kept being
 *     reported as still owed on the tab.
 *
 *   HALF 2 (#195) -- WHETHER the write landed.
 *     The `tabs.total` UPDATE discarded its error, so a failed write left the stored total
 *     stale while the terminal was handed a figure the database does not hold.
 *
 * Deliberately two tests rather than one. They fail for different reasons and a single combined
 * assertion would let one half regress while the other kept the test green -- which is exactly
 * how the merge that produced this code could have dropped one of them silently.
 *
 * __tests__/tab-settle-route-write-errors.test.ts covers half 2 among the three post-claim
 * writes generally. This pins it at the union site, next to half 1, so the two are read together.
 *
 * Hermetic: mocked at the same boundary as that suite. No live rows.
 */
import { NextRequest } from 'next/server'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const TAB_ID = '7c2f9a51-3f0e-4a6d-9a3e-1f5c2b8d4e77'

/** The order being settled now. */
const SETTLING_TOTAL = 40
/** Still genuinely owed by someone else on the same tab. */
const STILL_OWED_TOTAL = 25
/** Cancelled: never served, never owed. `payment_status` is 'pending' -- it is the ORDER
 *  status that is cancelled, which is precisely why `.neq('payment_status','paid')` counted it. */
const CANCELLED_TOTAL = 999

type Op = {
  table: string
  op: 'select' | 'update' | 'insert'
  payload: Record<string, unknown> | null
}

let ops: Op[] = []
let failOp: (op: Op) => { message: string; code: string } | null = () => null

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_UUID,
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0001',
    permissions: ['orders:update', 'orders:read'],
  }),
  validateTerminalRecord: async () => undefined,
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: async () => undefined,
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      const state: Op = { table, op: 'select', payload: null }
      let selectedAfterUpdate = false

      const settle = () => {
        ops.push({ ...state })
        const error = failOp(state)
        if (error) return { data: null, error }
        if (state.op === 'update') {
          return { data: selectedAfterUpdate ? [{ id: ORDER_ID }] : null, error: null }
        }
        if (state.table === 'orders') {
          const claimed = ops.filter((o) => o.table === 'orders' && o.op === 'update').length > 0
          if (!claimed) {
            // Pre-claim read: the order the terminal is settling.
            return {
              data: [
                {
                  id: ORDER_ID,
                  total: SETTLING_TOTAL,
                  payment_status: 'pending',
                  terminal_pushed_at: null,
                },
              ],
              error: null,
            }
          }
          // Post-claim recalc: what is left on the tab. The settled order is now paid; one order
          // is genuinely still owed; one is CANCELLED and must not be counted.
          return {
            data: [
              { total: SETTLING_TOTAL, payment_status: 'paid' },
              { total: STILL_OWED_TOTAL, payment_status: 'pending' },
              { total: CANCELLED_TOTAL, payment_status: 'cancelled' },
            ],
            error: null,
          }
        }
        return { data: [], error: null }
      }

      Object.assign(state ? {} : {}, {})
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => {
          if (state.op === 'update') selectedAfterUpdate = true
          return b
        },
        update: (payload: Record<string, unknown>) => {
          state.op = 'update'
          state.payload = payload
          return b
        },
        insert: async (payload: Record<string, unknown>) => {
          state.op = 'insert'
          state.payload = payload
          ops.push({ ...state })
          return { data: null, error: failOp(state) }
        },
        eq: () => b,
        neq: () => b,
        in: () => b,
        is: () => b,
        or: () => b,
        single: async () => ({
          data: {
            id: TAB_ID,
            table_id: 'table-uuid-1',
            total: SETTLING_TOTAL + STILL_OWED_TOTAL,
            status: 'open',
            settled_at: null,
          },
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) => resolve(settle()),
      })
      return b
    },
  }),
}))

const PG_ERROR = { message: 'update on tabs failed', code: '23503' }

const isTabTotal = (o: Op) => o.table === 'tabs' && o.op === 'update' && 'total' in (o.payload ?? {})

let errorLog: jest.SpyInstance

beforeEach(() => {
  ops = []
  failOp = () => null
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorLog.mockRestore()
})

async function settle() {
  const { POST } = await import('@/app/api/terminal/tabs/[tabId]/settle/route')
  const res = await POST(
    new NextRequest('https://staging.test/api/terminal/tabs/x/settle', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: JSON.stringify({
        order_ids: [ORDER_ID],
        amount: SETTLING_TOTAL,
        method: 'card',
        gateway_reference: 'GW-1',
        business_order_no: 'FT17863184148250674',
      }),
    }),
    { params: Promise.resolve({ tabId: TAB_ID }) },
  )
  return { res, body: await res.json() }
}

describe('settle — tab total recalculation holds BOTH halves of the merge', () => {
  it('HALF 1 (#104): a cancelled order is excluded from the recalculated tab total', async () => {
    const { res, body } = await settle()

    expect(res.status).toBe(200)
    // 25 = the one order genuinely still owed. NOT 1024 (25 + 999), which is what
    // `.neq('payment_status','paid')` produced: a cancelled order billed to the next customer.
    expect(body.new_tab_total).toBe(STILL_OWED_TOTAL)
    expect(body.tab_total_stale).toBe(false)

    // And the figure WRITTEN matches the figure REPORTED -- the response must not be computed
    // from a different set of rows than the update.
    const written = ops.find(isTabTotal)
    expect(written?.payload?.total).toBe(STILL_OWED_TOTAL)
  })

  it('HALF 2 (#195): a failed tab-total write is surfaced, not discarded', async () => {
    failOp = (o) => (isTabTotal(o) ? PG_ERROR : null)

    const { res, body } = await settle()

    // Stays 200: the card was charged and the orders are claimed, so a 4xx/5xx here would tell
    // staff a settlement that took money had failed, and invite a retry.
    expect(res.status).toBe(200)
    // The figure is WITHHELD rather than reported -- returning it would show the terminal a
    // number the database does not hold.
    expect(body.tab_total_stale).toBe(true)
    expect(body.new_tab_total).toBeNull()
    expect(
      errorLog.mock.calls.some((c) =>
        String(c[0] ?? '').includes('[terminal/tabs/settle] tab total write failed'),
      ),
    ).toBe(true)
  })
})
