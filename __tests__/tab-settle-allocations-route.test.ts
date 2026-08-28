/**
 * POST /api/terminal/tabs/[tabId]/settle-allocations -- the settle-by-allocation route wrapping
 * settle_order_line_allocations() and order_is_fully_paid_by_allocations(). What a mock can
 * honestly assert: input validation, the RPC call shape, that an order is only flipped to paid
 * when order_is_fully_paid_by_allocations() says so, and that it is flipped exactly once (the
 * UPDATE... WHERE payment_status <> 'paid' guard). The claim/race-safety of the underlying SQL
 * function is proven for real in scripts/prod/probe-item-split-rounding-staging.ts, the same
 * split every other real-Postgres probe in this session uses.
 */
import { POST } from '@/app/api/terminal/tabs/[tabId]/settle-allocations/route'

const RESTAURANT = 'rest-1'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const TABLE_ID = 'table-1'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    terminalId: 'term-1',
    deviceSerial: 'dev-1',
    restaurantId: RESTAURANT,
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => ({ id: 'term-1', status: 'active' }),
}))

let featureAllowed = true
jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: featureAllowed }),
}))

jest.mock('@/lib/receipts/safeIssueReceipt', () => ({
  safeIssueReceiptsForOrders: jest.fn(async () => {}),
}))

jest.mock('@/lib/tabs/settle-tab-state', () => ({
  clearReadyToPayAndReopenTab: jest.fn(async () => ({ reopened: false, readyToPayPreserved: false })),
}))

type Row = Record<string, unknown>

let tabRow: Row | null
let rpcSettleResponse: { data: unknown; error: unknown }
let fullyPaidResponses: Record<string, boolean>
let appliedAllocationRows: Row[]
let orderUpdateCalls: Row[]
let orderUpdateShouldClaim: boolean
let tabOrderRows: Row[]
let rpcCalls: Array<{ name: string; args: unknown }>

function makeSupabase() {
  return {
    from(table: string) {
      if (table === 'tabs') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: tabRow, error: tabRow ? null : { message: 'not found' } }),
              }),
            }),
          }),
          update: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        }
      }
      if (table === 'order_line_allocations') {
        return {
          select: () => ({
            in: async () => ({ data: appliedAllocationRows, error: null }),
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  is: () => ({
                    is: async () => ({ data: [{ id: 'alloc-1' }], error: null }),
                  }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'orders') {
        return {
          select: () => ({
            eq: async () => ({ data: tabOrderRows, error: null }),
          }),
          update: (patch: Row) => ({
            eq: () => ({
              eq: () => ({
                not: () => ({
                  select: async () => {
                    orderUpdateCalls.push(patch)
                    return { data: orderUpdateShouldClaim ? [{ id: 'order-1' }] : [], error: null }
                  },
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'audit_logs') {
        return { insert: async () => ({ data: null, error: null }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args })
      if (name === 'settle_order_line_allocations') return rpcSettleResponse
      if (name === 'order_is_fully_paid_by_allocations') {
        const orderId = (args as { p_order_id: string }).p_order_id
        return { data: fullyPaidResponses[orderId] ?? false, error: null }
      }
      throw new Error(`unexpected rpc ${name}`)
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabase(),
}))

function req(body: unknown) {
  return new Request('https://example.test/api/terminal/tabs/x/settle-allocations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function call(body: unknown, tabId = TAB_ID) {
  return POST(req(body), { params: Promise.resolve({ tabId }) })
}

beforeEach(() => {
  featureAllowed = true
  tabRow = { id: TAB_ID, table_id: TABLE_ID, status: 'open', settled_at: null }
  rpcSettleResponse = {
    data: { applied: [{ allocation_id: 'alloc-1', amount_cents: 3334 }], refused: [] },
    error: null,
  }
  fullyPaidResponses = {}
  appliedAllocationRows = [{ id: 'alloc-1', order_id: 'order-1' }]
  orderUpdateCalls = []
  orderUpdateShouldClaim = true
  tabOrderRows = []
  rpcCalls = []
})

describe('POST /api/terminal/tabs/[tabId]/settle-allocations', () => {
  it('refuses when station_screens_enabled is off', async () => {
    featureAllowed = false
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(403)
  })

  it('rejects an unsupported method', async () => {
    const res = await call({ allocation_ids: ['alloc-1'], method: 'bitcoin' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('UNSUPPORTED_PAYMENT_METHOD')
  })

  it('404s when the tab is not found', async () => {
    tabRow = null
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(404)
  })

  it('rejects when neither allocation_ids nor allocated_to resolve to anything', async () => {
    const res = await call({ allocation_ids: [], method: 'cash' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('NO_ALLOCATIONS')
  })

  it('calls settle_order_line_allocations with the tab, restaurant and allocation ids', async () => {
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(200)
    const settleCall = rpcCalls.find((c) => c.name === 'settle_order_line_allocations')!
    const args = settleCall.args as Record<string, unknown>
    expect(args.p_restaurant_id).toBe(RESTAURANT)
    expect(args.p_tab_id).toBe(TAB_ID)
    expect(args.p_allocation_ids).toEqual(['alloc-1'])
    expect(args.p_method).toBe('cash')
  })

  it('returns 409 when nothing could be settled', async () => {
    rpcSettleResponse = {
      data: { applied: [], refused: [{ allocation_id: 'alloc-1', reason: 'already_settled' }] },
      error: null,
    }
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('NOTHING_SETTLED')
  })

  it('does NOT flip the order to paid when order_is_fully_paid_by_allocations says false', async () => {
    fullyPaidResponses = { 'order-1': false }
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(200)
    expect(orderUpdateCalls).toHaveLength(0)
    const body = await res.json()
    expect(body.completed_order_ids).toEqual([])
  })

  it('flips the order to paid exactly once when order_is_fully_paid_by_allocations says true', async () => {
    fullyPaidResponses = { 'order-1': true }
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    expect(res.status).toBe(200)
    expect(orderUpdateCalls).toHaveLength(1)
    expect(orderUpdateCalls[0].payment_status).toBe('paid')
    expect(orderUpdateCalls[0].status).toBe('completed')
    const body = await res.json()
    expect(body.completed_order_ids).toEqual(['order-1'])
  })

  it('does not report an order as completed if the guarded UPDATE claimed nothing (already paid)', async () => {
    fullyPaidResponses = { 'order-1': true }
    orderUpdateShouldClaim = false
    const res = await call({ allocation_ids: ['alloc-1'], method: 'cash' })
    const body = await res.json()
    expect(body.completed_order_ids).toEqual([])
  })

  it('resolves allocated_to to that member\'s live unsettled allocations when allocation_ids is omitted', async () => {
    const res = await call({ allocated_to: 'Sam', method: 'cash' })
    expect(res.status).toBe(200)
    // The member lookup path used .eq chains, not .in -- reaching settle at all proves it resolved.
    const settleCall = rpcCalls.find((c) => c.name === 'settle_order_line_allocations')!
    expect(settleCall).toBeTruthy()
  })
})
