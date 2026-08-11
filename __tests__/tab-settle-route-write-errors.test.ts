/**
 * #195 at the ROUTE level — POST /api/terminal/tabs/[tabId]/settle discarded the result of three
 * writes that happen AFTER the orders have already been claimed as paid.
 *
 *   :342  orders.paycloud_merchant_order_no   — the gateway reference stamp
 *   :366  tabs.total                          — the recalculated balance the response reports
 *   :375  payments INSERT                     — the money record itself
 *
 * The payments insert is the consequential one: if it fails, the tab is settled, the orders are
 * paid, receipts have been issued, and there is no payment row -- and the route answered
 * `success: true` with nothing anywhere saying otherwise.
 *
 * None of the three may ABORT the request. By the time they run the card has been charged and the
 * orders are claimed; throwing lands in the route's generic catch, which answers 401 Unauthorized,
 * telling staff a settlement that actually took money was an auth failure. So the contract these
 * pin is the same one `lib/tabs/settle-tab-state.ts` states for its own post-payment writes:
 * logged and surfaced, never escalated.
 *
 * Driven through the real exported handler over a real Request, mocked at the same boundary as
 * __tests__/terminal-payment-cent-tolerance-routes.test.ts. Hermetic; no live rows.
 */
import { NextRequest } from 'next/server'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const ORDER_ID = '133ffc3a-106b-4076-bf23-2dd55cba8d9c'
const TAB_ID = '7c2f9a51-3f0e-4a6d-9a3e-1f5c2b8d4e77'
const MERCHANT_ORDER_NO = 'FT17863184148250674'
const TOTAL = 78.35

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
      /** The claim reads its result back with .select('id') AFTER .update(). */
      let selectedAfterUpdate = false
      const b: Record<string, unknown> = {}

      const settle = () => {
        ops.push({ ...state })
        const error = failOp(state)
        if (error) return { data: null, error }
        if (state.op === 'update') {
          // Only the atomic claim reads rows back; the rest resolve to nothing.
          return { data: selectedAfterUpdate ? [{ id: ORDER_ID }] : null, error: null }
        }
        if (state.table === 'orders') {
          // Both post-claim orders reads ("what is still unpaid", "what remains") are empty:
          // the one order on this tab has just been paid.
          return {
            data: ops.filter((o) => o.table === 'orders' && o.op === 'update').length
              ? []
              : [
                  {
                    id: ORDER_ID,
                    total: TOTAL,
                    payment_status: 'pending',
                    terminal_pushed_at: null,
                  },
                ],
            error: null,
          }
        }
        return { data: [], error: null }
      }

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
          data: { id: TAB_ID, table_id: 'table-uuid-1', total: TOTAL, status: 'open', settled_at: null },
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) => resolve(settle()),
      })
      return b
    },
  }),
}))

const PG_ERROR = { message: 'insert into payments failed', code: '23503' }

/** The three writes under test, identified by what they write rather than by call order. */
const isMerchantStamp = (o: Op) =>
  o.table === 'orders' && o.op === 'update' && !!o.payload?.paycloud_merchant_order_no
const isTabTotal = (o: Op) => o.table === 'tabs' && o.op === 'update' && 'total' in (o.payload ?? {})
const isPaymentInsert = (o: Op) => o.table === 'payments' && o.op === 'insert'

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
        amount: TOTAL,
        method: 'card',
        gateway_reference: 'GW-1',
        business_order_no: MERCHANT_ORDER_NO,
      }),
    }),
    { params: Promise.resolve({ tabId: TAB_ID }) },
  )
  return { res, body: await res.json() }
}

const logged = (needle: string) =>
  errorLog.mock.calls.some((c) => String(c[0] ?? '').includes(needle))

describe('POST /api/terminal/tabs/[tabId]/settle — post-claim write failures', () => {
  it('reports the settlement healthy when every write lands', async () => {
    // Two-sided control: the guards must not report a failure that did not happen.
    const { res, body } = await settle()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      success: true,
      new_tab_total: 0,
      tab_total_stale: false,
      payment_record_written: true,
    })
  })

  it('surfaces a failed payments insert instead of answering a clean success', async () => {
    failOp = (o) => (isPaymentInsert(o) ? PG_ERROR : null)

    const { res, body } = await settle()

    // The money moved and the orders are paid, so this stays a 200 -- a 401/500 here would tell
    // staff the settlement failed and invite a retry against orders that are already claimed.
    // What must not survive is the silence: the missing payment row has to be visible.
    expect(res.status).toBe(200)
    expect(body.payment_record_written).toBe(false)
    expect(logged('[terminal/tabs/settle] payment record insert failed')).toBe(true)
  })

  it('records the missing payment row in the audit trail', async () => {
    failOp = (o) => (isPaymentInsert(o) ? PG_ERROR : null)

    await settle()

    const audit = ops.find((o) => o.table === 'audit_logs')
    expect((audit?.payload?.metadata as Record<string, unknown>).payment_record_written).toBe(false)
  })

  it('reports the tab total as stale when the tab total write fails', async () => {
    failOp = (o) => (isTabTotal(o) ? PG_ERROR : null)

    const { body } = await settle()

    // The stored total is unchanged, so returning the recalculated figure asserts a balance the
    // database does not hold -- the same reasoning the route already applies to a failed READ.
    expect(body).toMatchObject({ new_tab_total: null, tab_total_stale: true })
    expect(logged('[terminal/tabs/settle] tab total write failed')).toBe(true)
  })

  it('logs a failed merchant-order-number stamp without failing the settlement', async () => {
    failOp = (o) => (isMerchantStamp(o) ? PG_ERROR : null)

    const { res, body } = await settle()

    expect({ status: res.status, success: body.success }).toEqual({ status: 200, success: true })
    expect(logged('[terminal/tabs/settle] merchant order number stamp failed')).toBe(true)
  })
})
