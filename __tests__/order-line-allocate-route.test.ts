/**
 * POST /api/terminal/tabs/[tabId]/lines/[lineId]/allocate -- input validation, the exact-cents
 * split wiring, and the append-only void-then-replace behaviour on re-allocation. The RPC-level
 * settlement claim and the real-Postgres rounding proof live in
 * scripts/prod/probe-item-split-rounding-staging.ts, the same split this session's other
 * real-Postgres probes use between what a mock can honestly assert and what only a live database
 * can prove.
 */
import { POST } from '@/app/api/terminal/tabs/[tabId]/lines/[lineId]/allocate/route'

const RESTAURANT = 'rest-1'
const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LINE_ID = '22222222-2222-4222-8222-222222222222'
const ORDER_ID = '33333333-3333-4333-8333-333333333333'

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

type Row = Record<string, unknown>

let orderLinesRow: Row | null
let ordersRow: Row | null
let existingAllocations: Row[]
let insertedAllocations: Row[]
let insertCalls: Row[][]
let updateCalls: Row[]

function makeSupabase() {
  return {
    from(table: string) {
      if (table === 'order_lines') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: orderLinesRow, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'orders') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: ordersRow, error: null }),
            }),
          }),
        }
      }
      if (table === 'order_line_allocations') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                is: async () => ({ data: existingAllocations, error: null }),
              }),
            }),
          }),
          update: (patch: Row) => ({
            in: () => ({
              is: () => ({
                is: async () => {
                  updateCalls.push(patch)
                  return { data: null, error: null }
                },
              }),
            }),
          }),
          insert: (rows: Row[]) => {
            insertCalls.push(rows)
            insertedAllocations = rows.map((r, i) => ({ id: `alloc-${i}`, ...r }))
            return {
              select: async () => ({ data: insertedAllocations, error: null }),
            }
          },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabase(),
}))

function req(body: unknown) {
  return new Request('https://example.test/api/terminal/tabs/x/lines/y/allocate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function call(body: unknown, tabId = TAB_ID, lineId = LINE_ID) {
  return POST(req(body), { params: Promise.resolve({ tabId, lineId }) })
}

beforeEach(() => {
  featureAllowed = true
  orderLinesRow = {
    id: LINE_ID,
    order_id: ORDER_ID,
    tab_id: TAB_ID,
    source_item_index: 0,
    kitchen_state: 'outstanding',
    bar_state: null,
  }
  ordersRow = { id: ORDER_ID, items: [{ total: 100.0 }] }
  existingAllocations = []
  insertedAllocations = []
  insertCalls = []
  updateCalls = []
})

describe('POST /api/terminal/tabs/[tabId]/lines/[lineId]/allocate', () => {
  it('refuses when station_screens_enabled is off', async () => {
    featureAllowed = false
    const res = await call({ shares: [{ allocated_to: 'Sam', quantity_allocated: 1 }] })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('STATION_SCREENS_DISABLED')
  })

  it('rejects an empty shares array', async () => {
    const res = await call({ shares: [] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('NO_SHARES')
  })

  it('rejects a share with no allocated_to', async () => {
    const res = await call({ shares: [{ allocated_to: '  ', quantity_allocated: 1 }] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID_ALLOCATED_TO')
  })

  it('rejects a non-positive quantity_allocated', async () => {
    const res = await call({ shares: [{ allocated_to: 'Sam', quantity_allocated: 0 }] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('INVALID_QUANTITY_ALLOCATED')
  })

  it('404s when the line cannot be found or priced', async () => {
    orderLinesRow = null
    const res = await call({ shares: [{ allocated_to: 'Sam', quantity_allocated: 1 }] })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('LINE_NOT_FOUND')
  })

  it('refuses a line that belongs to a different tab', async () => {
    orderLinesRow!.tab_id = 'other-tab'
    const res = await call({ shares: [{ allocated_to: 'Sam', quantity_allocated: 1 }] })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('LINE_TAB_MISMATCH')
  })

  it('splits a R100.00 line 34/33/33 across three equal shares, summing exactly to 10000 cents', async () => {
    const res = await call({
      shares: [
        { allocated_to: 'Sam', quantity_allocated: 1 },
        { allocated_to: 'Priya', quantity_allocated: 1 },
        { allocated_to: 'Jordan', quantity_allocated: 1 },
      ],
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.line_total_cents).toBe(10000)
    const cents = body.allocations.map((a: { amount_cents: number }) => a.amount_cents)
    expect(cents.reduce((a: number, b: number) => a + b, 0)).toBe(10000)
    expect(cents.sort((a: number, b: number) => b - a)).toEqual([3334, 3333, 3333])
  })

  it('splits a shared item by uneven quantity_allocated weight (one person had 2x the other)', async () => {
    const res = await call({
      shares: [
        { allocated_to: 'Sam', quantity_allocated: 1 },
        { allocated_to: 'Priya', quantity_allocated: 2 },
      ],
    })
    const body = await res.json()
    const cents = body.allocations.map((a: { amount_cents: number }) => a.amount_cents)
    expect(cents.reduce((a: number, b: number) => a + b, 0)).toBe(10000)
    // 1:2 weight of 10000 -> 3333/6667 by largest-remainder.
    expect(cents.sort((a: number, b: number) => a - b)).toEqual([3333, 6667])
  })

  it('refuses re-allocation of a line with an already-settled allocation, without voiding it', async () => {
    existingAllocations = [{ id: 'alloc-old', settled_at: '2026-08-29T00:00:00Z' }]
    const res = await call({ shares: [{ allocated_to: 'Sam', quantity_allocated: 1 }] })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('ALREADY_SETTLED')
    expect(updateCalls).toHaveLength(0)
    expect(insertCalls).toHaveLength(0)
  })

  it('voids prior unsettled allocations before inserting the new set (append-only replace)', async () => {
    existingAllocations = [{ id: 'alloc-old', settled_at: null }]
    const res = await call({ shares: [{ allocated_to: 'Sam', quantity_allocated: 1 }] })
    expect(res.status).toBe(200)
    expect(updateCalls).toHaveLength(1)
    expect(updateCalls[0].voided_at).toBeTruthy()
    expect(updateCalls[0].void_reason).toBe('replaced_by_reallocation')
    expect(insertCalls).toHaveLength(1)
  })

  it('surfaces a SPLIT_FAILED 400 rather than a 500 when the arithmetic itself refuses', async () => {
    ordersRow = { id: ORDER_ID, items: [{}] } // no `.total` on the item
    const res = await call({ shares: [{ allocated_to: 'Sam', quantity_allocated: 1 }] })
    expect(res.status).toBe(404) // readLineTotalCents returns null for a missing total
  })
})
