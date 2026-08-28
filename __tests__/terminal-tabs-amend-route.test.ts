/**
 * POST /api/terminal/tabs/[tabId]/amend -- the route wrapper around amend_order_lines().
 * The RPC's own atomicity and race behaviour is proven for real against staging Postgres in
 * scripts/prod/probe-amend-cook-race-staging.ts (20/20 trials, kitchen wins, mutual exclusion
 * held) -- this file covers what a mock CAN answer honestly: input validation, and that the
 * route retries the whole call on an order-number collision, the same bounded pattern
 * insertWithOrderNumber() uses elsewhere, and does not retry on any other error.
 */
import { POST } from '@/app/api/terminal/tabs/[tabId]/amend/route'

const RESTAURANT = 'rest-1'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LINE_ID = '22222222-2222-4222-8222-222222222222'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    terminalId: 'term-1',
    restaurantId: RESTAURANT,
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => ({ id: 'term-1', status: 'active' }),
}))

let featureAllowed = true
jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: featureAllowed }),
}))

let nextNumber = 100
jest.mock('@/lib/orders/order-number', () => {
  const actual = jest.requireActual('@/lib/orders/order-number')
  return {
    ...actual,
    nextOrderNumber: async () => nextNumber++,
  }
})

let rpcCalls: unknown[] = []
let rpcResponses: Array<{ data: unknown; error: unknown }> = []

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    rpc: async (name: string, args: unknown) => {
      rpcCalls.push({ name, args })
      const next = rpcResponses.shift()
      return next ?? { data: null, error: { message: 'no mock response queued' } }
    },
  }),
}))

function req(body: unknown) {
  return new Request('https://example.test/api/terminal/tabs/x/amend', {
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
  nextNumber = 100
  rpcCalls = []
  rpcResponses = []
})

describe('POST /api/terminal/tabs/[tabId]/amend', () => {
  it('refuses when station_screens_enabled is off, before any RPC call', async () => {
    featureAllowed = false
    const res = await call({ amendments: [{ line_id: LINE_ID, new_quantity: 3 }] })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('STATION_SCREENS_DISABLED')
    expect(rpcCalls).toHaveLength(0)
  })

  it('rejects an empty amendments array', async () => {
    const res = await call({ amendments: [] })
    expect(res.status).toBe(400)
    expect(rpcCalls).toHaveLength(0)
  })

  it('rejects a non-UUID line_id', async () => {
    const res = await call({ amendments: [{ line_id: 'not-a-uuid', new_quantity: 3 }] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID_LINE_ID')
  })

  it('rejects a negative quantity', async () => {
    const res = await call({ amendments: [{ line_id: LINE_ID, new_quantity: -1 }] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID_QUANTITY')
  })

  it('calls the RPC with the tab, restaurant, a fresh order number, and the cleaned amendments', async () => {
    rpcResponses.push({
      data: { order_id: 'order-1', order_number: 100, applied: [{ line_id: LINE_ID, action: 'replaced', new_line_id: 'new-line' }], refused: [] },
      error: null,
    })

    const res = await call({ amendments: [{ line_id: LINE_ID, new_quantity: 5 }] })
    expect(res.status).toBe(200)

    expect(rpcCalls).toHaveLength(1)
    const [{ name, args }] = rpcCalls as Array<{ name: string; args: Record<string, unknown> }>
    expect(name).toBe('amend_order_lines')
    expect(args.p_restaurant_id).toBe(RESTAURANT)
    expect(args.p_tab_id).toBe(TAB_ID)
    expect(args.p_order_number).toBe(100)
    expect(args.p_amendments).toEqual([{ line_id: LINE_ID, new_quantity: 5 }])
  })

  it('retries the whole call on an order-number collision, with a freshly read number', async () => {
    const collision = {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "orders_firebase_restaurant_id_order_number_key"',
    }
    rpcResponses.push({ data: null, error: collision })
    rpcResponses.push({
      data: { order_id: 'order-2', order_number: 101, applied: [{ line_id: LINE_ID, action: 'replaced' }], refused: [] },
      error: null,
    })

    const res = await call({ amendments: [{ line_id: LINE_ID, new_quantity: 5 }] })
    expect(res.status).toBe(200)
    expect(rpcCalls).toHaveLength(2)
    const numbers = (rpcCalls as Array<{ args: { p_order_number: number } }>).map(
      (c) => c.args.p_order_number,
    )
    expect(numbers).toEqual([100, 101])
  })

  it('does not retry on a non-collision error', async () => {
    rpcResponses.push({ data: null, error: { code: '42P01', message: 'relation does not exist' } })

    const res = await call({ amendments: [{ line_id: LINE_ID, new_quantity: 5 }] })
    expect(res.status).toBe(502)
    expect(rpcCalls).toHaveLength(1)
  })

  it('reports refused lines from the RPC result verbatim', async () => {
    rpcResponses.push({
      data: { order_id: null, order_number: null, applied: [], refused: [{ line_id: LINE_ID, reason: 'window_closed' }] },
      error: null,
    })

    const res = await call({ amendments: [{ line_id: LINE_ID, new_quantity: 5 }] })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.refused).toEqual([{ line_id: LINE_ID, reason: 'window_closed' }])
    expect(body.order_id).toBeNull()
  })
})
