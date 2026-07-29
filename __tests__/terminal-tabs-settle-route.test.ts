/**
 * Route-level coverage: a cancelled (or otherwise non-claimable) order must never be
 * accepted into a tab settle -- neither its total counted toward expectedAmount, nor
 * any DB row touched -- before the real-world card charge on the terminal device has
 * already happened for the wrong amount.
 */
import { POST } from '@/app/api/terminal/tabs/[tabId]/settle/route'

const requireTerminalAuth = jest.fn(async (..._args: unknown[]) => ({
  terminalId: 'term-1',
  restaurantId: 'rest-1',
  deviceSerial: 'ft-term-1',
  permissions: ['orders:update'],
}))
const validateTerminalRecord = jest.fn(async (..._args: unknown[]) => ({ status: 'active' }))
jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: (...args: unknown[]) => requireTerminalAuth(...args),
  validateTerminalRecord: (...args: unknown[]) => validateTerminalRecord(...args),
}))

const safeIssueReceiptsForOrders = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: (...args: unknown[]) => safeIssueReceiptsForOrders(...args),
}))

jest.mock('@/lib/payment-reference', () => ({
  generatePaymentReference: () => 'PAY-REF-TEST',
}))

// Tracks whether any mutating call (update/insert) on `orders` ever ran, across the whole
// request -- the core property under test is that a rejected settle touches nothing.
let ordersUpdateCalled = false
let ordersInsertCalled = false

type OrderRow = { id: string; total: number; payment_status: string }

function makeSupabaseMock(tabOrders: OrderRow[]) {
  return {
    from: (table: string) => {
      if (table === 'tabs') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: 'tab-1', table_id: 'table-1', total: 100 },
                  error: null,
                }),
              }),
            }),
          }),
          update: (..._args: unknown[]) => {
            throw new Error('tabs.update should not run for a rejected settle')
          },
        }
      }
      if (table === 'orders') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: async () => ({ data: tabOrders, error: null }),
              }),
            }),
          }),
          update: (..._args: unknown[]) => {
            ordersUpdateCalled = true
            throw new Error('orders.update should not run for a rejected settle')
          },
        }
      }
      if (table === 'payments' || table === 'audit_logs') {
        return {
          insert: async (..._args: unknown[]) => {
            ordersInsertCalled = true
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => currentSupabaseMock,
}))

// Set by each test right before calling the route, so the module-level mock above can see it.
let currentSupabaseMock: ReturnType<typeof makeSupabaseMock>

function makeReq(body: Record<string, unknown>) {
  return new Request('https://example.test/api/terminal/tabs/tab-1/settle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: 'Bearer test' },
    body: JSON.stringify(body),
  })
}

describe('terminal tabs settle -- non-claimable order guard', () => {
  beforeEach(() => {
    ordersUpdateCalled = false
    ordersInsertCalled = false
  })

  it('rejects with zero DB mutation when a cancelled order is included, even if the client amount matches its own inflated sum', async () => {
    currentSupabaseMock = makeSupabaseMock([
      { id: 'ord-real', total: 40, payment_status: 'pending' },
      { id: 'ord-cancelled', total: 20, payment_status: 'cancelled' },
    ])

    const res = await POST(
      makeReq({
        order_ids: ['ord-real', 'ord-cancelled'],
        // Client (and, before this fix, the server's own recomputation) would both land on
        // 60 -- the inflated total including the cancelled order's price.
        amount: 60,
        method: 'card',
      }),
      { params: Promise.resolve({ tabId: 'tab-1' }) },
    )

    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.code).toBe('NON_CLAIMABLE_ORDERS_IN_REQUEST')
    expect(json.non_claimable_order_ids).toEqual(['ord-cancelled'])
    expect(ordersUpdateCalled).toBe(false)
    expect(ordersInsertCalled).toBe(false)
  })

  it('does not false-positive the new guard on a legitimate all-unpaid/pending settle', async () => {
    // Generic chainable/thenable stub so every downstream call this test doesn't care about
    // (the atomic claim update, tab total recalc, payments/audit_logs inserts, etc.) just
    // resolves benignly instead of needing to be mocked call-by-call. The only thing under
    // test here is that the new claimability guard itself doesn't reject this request.
    const chainable = (): any => {
      const handler: ProxyHandler<any> = {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
          }
          return (..._args: unknown[]) => chainable()
        },
      }
      return new Proxy(() => {}, handler)
    }

    currentSupabaseMock = {
      from: (table: string) => {
        if (table === 'orders') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: async () => ({
                    data: [
                      { id: 'ord-a', total: 40, payment_status: 'pending' },
                      { id: 'ord-b', total: 20, payment_status: 'unpaid' },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
            update: () => chainable(),
          }
        }
        return chainable()
      },
    } as any

    const res = await POST(
      makeReq({ order_ids: ['ord-a', 'ord-b'], amount: 60, method: 'card' }),
      { params: Promise.resolve({ tabId: 'tab-1' }) },
    )

    const json = await res.json()
    expect(json.code).not.toBe('NON_CLAIMABLE_ORDERS_IN_REQUEST')
    expect(json.code).not.toBe('AMOUNT_MISMATCH')
  })
})
