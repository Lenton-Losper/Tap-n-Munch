/**
 * Issue #123 — settling a tab left it 'open', and a closed-out tab could be resurrected.
 *
 * The issue named app/api/.../settle/route.ts, but that route was already hardened (c87bf27 /
 * dfb2325): its reopen is split into two statements and guarded with `.is('settled_at', null)`,
 * and the error is captured. The sibling that pays a SINGLE order from the terminal,
 * app/api/terminal/orders/[orderId]/payment/route.ts, never received that fix and still had
 * both defects, in two places (the success path and the corrected_to_paid path):
 *
 *   1. UNCONDITIONAL. `update({ status: 'open', ... }).eq('id', tabId)` with no settled_at
 *      guard. A tab closed out via close_table_session carries status='settled' with
 *      settled_at set; flipping it back to 'open' re-arms the partial unique index
 *      idx_tabs_one_open_per_table (restaurant_id, table_number) WHERE status='open'. With a
 *      stray 'open' row present, POST /api/tabs hits 23505 and degrades into a JOIN -- handing
 *      the NEXT party the previous customer's tab, itemised orders and receipt, and bypassing
 *      the tab PIN because that path believes it is creating rather than joining. That is also
 *      what puts "Tab open -- Tap to settle" back on a customer's phone after they have paid.
 *
 *   2. UNCHECKED, AND FUSED. status and the ready-to-pay flags were one statement whose result
 *      was discarded. When the status write hits 23505 the whole statement fails, so the flags
 *      are never cleared and a fully paid tab is parked on the ready-to-pay queue for good --
 *      and nothing is logged.
 */
import { POST } from '@/app/api/terminal/orders/[orderId]/payment/route'

const RESTAURANT_ID = 'rest-1'
const ORDER_ID = 'order-1'
const TAB_ID = 'tab-1'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: RESTAURANT_ID,
    terminalId: 'term-1',
    deviceSerial: 'SN-1',
    permissions: ['orders:update'],
  }),
  validateTerminalRecord: async () => undefined,
}))

jest.mock('@/lib/payments/mark-order-paid-confirmed', () => ({
  markOrderPaidConfirmed: async () => ({ claimed: true, orderId: ORDER_ID, tabId: TAB_ID }),
}))

jest.mock('@/lib/payments/handle-terminal-payment-failed', () => ({
  handleTerminalPaymentFailed: async () => ({ outcome: 'corrected_to_paid', tabId: TAB_ID }),
}))

type TabUpdate = { patch: Record<string, unknown>; filters: Array<[string, unknown]> }

let tabUpdates: TabUpdate[] = []
/** Set to make the status write fail the way the unique index does. */
let statusWriteError: { code: string; message: string } | null = null

function makeClient() {
  return {
    from(table: string) {
      const api: Record<string, unknown> = {}

      Object.assign(api, {
        select: () => api,
        eq: () => api,
        neq: () => api,
        in: () => api,
        is: () => api,
        single: async () => {
          if (table === 'orders') {
            return {
              data: {
                id: ORDER_ID,
                tab_id: TAB_ID,
                restaurant_id: RESTAURANT_ID,
                status: 'pending',
                total: 100,
                payment_status: 'pending',
                paycloud_merchant_order_no: 'MON-1',
              },
              error: null,
            }
          }
          return { data: null, error: null }
        },
        // `.from('orders').select('id').eq(...).neq(...)` is awaited directly.
        then: (resolve: (r: unknown) => unknown) =>
          Promise.resolve(resolve({ data: [], error: null })),
        update(patch: Record<string, unknown>) {
          const filters: Array<[string, unknown]> = []
          const upd: Record<string, unknown> = {}
          Object.assign(upd, {
            eq: (column: string, value: unknown) => {
              filters.push([column, value])
              return upd
            },
            is: (column: string, value: unknown) => {
              filters.push([`is:${column}`, value])
              return upd
            },
            then: (resolve: (r: unknown) => unknown) => {
              if (table === 'tabs') {
                tabUpdates.push({ patch, filters })
                const guarded = filters.some(([c]) => c === 'is:settled_at')
                // The unique index only bites the status write.
                if ('status' in patch && statusWriteError && !guarded) {
                  return Promise.resolve(resolve({ data: null, error: statusWriteError }))
                }
              }
              return Promise.resolve(resolve({ data: null, error: null }))
            },
          })
          return upd
        },
      })

      return api
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeClient(),
}))

beforeEach(() => {
  tabUpdates = []
  statusWriteError = null
})

async function payOrder(status: 'success' | 'failed') {
  const res = await POST(
    new Request('https://example.test/pay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status, amount: 100, reference: 'REF-1' }),
    }),
    { params: Promise.resolve({ orderId: ORDER_ID }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const statusWrites = () => tabUpdates.filter((u) => 'status' in u.patch)
const flagWrites = () =>
  tabUpdates.filter((u) => 'ready_to_pay_at' in u.patch && !('status' in u.patch))

describe.each([
  ['success path', 'success' as const],
  ['corrected_to_paid path', 'failed' as const],
])('terminal single-order payment (%s) — tab reopen safety', (_label, requestStatus) => {
  it('guards the reopen on settled_at so a closed-out tab is never resurrected', async () => {
    await payOrder(requestStatus)

    expect(statusWrites()).toHaveLength(1)
    expect(statusWrites()[0].patch.status).toBe('open')
    expect(statusWrites()[0].filters).toContainEqual(['is:settled_at', null])
  })

  it('clears the ready-to-pay flags in a SEPARATE, unguarded statement', async () => {
    await payOrder(requestStatus)

    expect(flagWrites()).toHaveLength(1)
    const flags = flagWrites()[0]
    expect(flags.patch).toEqual({ payment_preference: null, ready_to_pay_at: null })
    // Deliberately not guarded: a paid tab must come off the ready-to-pay queue even when the
    // status write cannot land.
    expect(flags.filters.some(([c]) => c === 'is:settled_at')).toBe(false)
    // And it must not be fused with the status write.
    expect(statusWrites()[0].patch).not.toHaveProperty('ready_to_pay_at')
  })

  it('still clears the ready-to-pay flags when the status write hits 23505', async () => {
    statusWriteError = { code: '23505', message: 'duplicate key value violates unique constraint' }

    const { status } = await payOrder(requestStatus)

    // The payment itself is recorded; a failed reopen must not fail the request.
    expect(status).toBe(200)
    expect(flagWrites()).toHaveLength(1)
  })
})
