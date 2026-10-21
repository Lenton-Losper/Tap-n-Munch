/**
 * GET /api/analytics/payment-methods: authorization, tenant isolation, and what it reads.
 *
 * The data client in this route is the service role, which bypasses RLS, so the only thing keeping
 * restaurant A's takings out of restaurant B's chart is the `restaurant_id` filter on each read.
 * The fake client below genuinely applies eq / gte / lt / overlaps to seeded rows (including another
 * restaurant's), so a dropped filter changes the answer instead of just failing a call-shape check.
 */
import { NextResponse } from 'next/server'
import { GET } from '@/app/api/analytics/payment-methods/route'

const R_A = 'a0000000-0000-4000-8000-00000000000a'
const R_B = 'b0000000-0000-4000-8000-00000000000b'

type Row = Record<string, any>
let tables: Record<string, Row[]> = {}
let reads: Array<{ table: string; filters: Array<[string, string, unknown]> }> = []
let authResult: unknown

jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (r: any) => r instanceof Response,
  requireStaffPermission: jest.fn(async (...args: unknown[]) => {
    ;(global as any).__authArgs = args
    return authResult
  }),
}))

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (id: string) => {
    if (id === 'missing') throw new Error('Restaurant not found for id=missing')
    return id
  },
}))

function makeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = []
      const b: any = {
        select: () => b,
        order: () => b,
        eq: (c: string, v: unknown) => (filters.push([c, 'eq', v]), b),
        gte: (c: string, v: unknown) => (filters.push([c, 'gte', v]), b),
        lt: (c: string, v: unknown) => (filters.push([c, 'lt', v]), b),
        overlaps: (c: string, v: unknown) => (filters.push([c, 'ov', v]), b),
        maybeSingle: async () => ({ data: (tables[table] ?? []).find((r) => matches(r, filters)) ?? null, error: null }),
        range: async (from: number, to: number) => {
          reads.push({ table, filters })
          const rows = (tables[table] ?? []).filter((r) => matches(r, filters))
          return { data: rows.slice(from, to + 1), error: null }
        },
      }
      return b
    },
  }
}

function matches(row: Row, filters: Array<[string, string, unknown]>) {
  return filters.every(([c, op, v]) => {
    const x = row[c]
    if (op === 'eq') return x === v
    if (op === 'gte') return new Date(x).getTime() >= new Date(String(v)).getTime()
    if (op === 'lt') return new Date(x).getTime() < new Date(String(v)).getTime()
    if (op === 'ov') return Array.isArray(x) && x.some((i: string) => (v as string[]).includes(i))
    return true
  })
}

const call = (qs: Record<string, string>) =>
  GET(new Request(`http://t/api/analytics/payment-methods?${new URLSearchParams(qs).toString()}`))

const q = { restaurantId: R_A, startDate: '2026-10-10', endDate: '2026-10-10' }
const T = '2026-10-10T10:00:00Z'

beforeEach(() => {
  reads = []
  authResult = { userId: 'u1', restaurantId: R_A, supabase: makeClient() }
  tables = {
    restaurants: [
      { id: R_A, timezone: 'Africa/Windhoek' },
      { id: R_B, timezone: 'Africa/Windhoek' },
    ],
    payment_events: [
      { id: 'a-sale', restaurant_id: R_A, event_type: 'sale', amount: 50, created_at: T, order_ids: ['oa1'], origin: 'gateway', terminal_id: null },
      { id: 'a-fail', restaurant_id: R_A, event_type: 'refund_failed', amount: 99, created_at: T, order_ids: ['oa1'], origin: null, terminal_id: null },
      { id: 'a-refund', restaurant_id: R_A, event_type: 'refund_succeeded', amount: 5, created_at: T, order_ids: ['oa1'], origin: null, terminal_id: null },
      { id: 'b-sale', restaurant_id: R_B, event_type: 'sale', amount: 777, created_at: T, order_ids: ['ob1'], origin: 'gateway', terminal_id: null },
      { id: 'b-refund', restaurant_id: R_B, event_type: 'refund_succeeded', amount: 88, created_at: T, order_ids: ['ob1'], origin: null, terminal_id: null },
    ],
    non_gateway_payment_events: [
      { id: 'a-cash', restaurant_id: R_A, method: 'cash', amount_cents: 2500, created_at: T, order_ids: ['oa2'], origin: 'terminal_order_payment', terminal_id: 't1' },
      { id: 'b-cash', restaurant_id: R_B, method: 'cash', amount_cents: 999900, created_at: T, order_ids: ['ob2'], origin: 'terminal_order_payment', terminal_id: 't9' },
    ],
    orders: [
      { id: 'oa1', restaurant_id: R_A, payment_status: 'paid', payment_method: 'card', total: 50, paid_at: T },
      { id: 'oa2', restaurant_id: R_A, payment_status: 'paid', payment_method: 'cash', total: 25, paid_at: T },
      { id: 'oa3', restaurant_id: R_A, payment_status: 'paid', payment_method: 'card', total: 10, paid_at: T }, // no ledger row anywhere
      { id: 'oa4', restaurant_id: R_A, payment_status: 'pending', payment_method: 'cash', total: 400, paid_at: T },
      { id: 'ob1', restaurant_id: R_B, payment_status: 'paid', payment_method: 'card', total: 777, paid_at: T },
      { id: 'ob3', restaurant_id: R_B, payment_status: 'paid', payment_method: 'other', total: 5000, paid_at: T },
    ],
  }
})

describe('authorization and validation', () => {
  it('returns the guard\'s 401/403 untouched and reads no data', async () => {
    authResult = NextResponse.json({ error: 'You do not have permission to perform this action.' }, { status: 403 })
    const res = await call(q)
    expect(res.status).toBe(403)
    expect(reads).toHaveLength(0)
  })

  it('authorises against the RESOLVED restaurant with the analytics permission', async () => {
    await call(q)
    const [restaurantId, permission] = (global as any).__authArgs
    expect(restaurantId).toBe(R_A)
    expect(String(permission)).toMatch(/analytics/i)
  })

  it.each([
    [{ ...q, restaurantId: '' }, 400],
    [{ ...q, startDate: '10-10-2026' }, 400],
    [{ ...q, endDate: '2026-02-30' }, 400],
    [{ ...q, startDate: '2026-10-11', endDate: '2026-10-10' }, 400],
    [{ ...q, startDate: '2024-01-01', endDate: '2026-10-10' }, 400],
  ])('rejects bad input %#', async (params, status) => {
    const res = await call(params as Record<string, string>)
    expect(res.status).toBe(status)
    expect(reads).toHaveLength(0)
  })

  it('answers 404, not a crash, for an unknown restaurant', async () => {
    const res = await call({ ...q, restaurantId: 'missing' })
    expect(res.status).toBe(404)
  })
})

describe('tenant isolation', () => {
  it('counts only restaurant A rows, even though B has larger payments at the same time', async () => {
    const body = await (await call(q)).json()
    expect(body.settlement.total.count).toBe(2) // A's gateway sale + A's cash
    expect(body.settlement.total.amountCents).toBe(5000 + 2500)
    expect(body.refunds).toMatchObject({ count: 1, amountCents: -500 })
  })

  it('puts a restaurant_id filter on EVERY ledger and orders read', async () => {
    await call(q)
    expect(reads.length).toBeGreaterThanOrEqual(5)
    for (const r of reads) {
      expect(r.filters).toContainEqual(['restaurant_id', 'eq', R_A])
    }
  })

  it('does not let B\'s order or ledger row cover or count against A\'s orders', async () => {
    const body = await (await call(q)).json()
    expect(body.coverage.uncoveredOrders).toBe(1) // oa3 only
    expect(body.coverage.byOrderMethod).toEqual({ card: { orders: 1, amountCents: 1000 } })
  })

  it('reading B returns B\'s numbers and none of A\'s', async () => {
    authResult = { userId: 'u2', restaurantId: R_B, supabase: makeClient() }
    const body = await (await call({ ...q, restaurantId: R_B })).json()
    expect(body.settlement.total.amountCents).toBe(77700 + 999900)
    expect(body.coverage.uncoveredOrders).toBe(1) // ob3
  })
})

describe('what is read, and what is excluded', () => {
  it('reads only the two settlement ledgers, refunds and orders: never legacy payments or allocation rows', async () => {
    await call(q)
    expect([...new Set(reads.map((r) => r.table))].sort()).toEqual(['non_gateway_payment_events', 'orders', 'payment_events'])
  })

  it('counts sale events as collections and refund_succeeded as refunds; refund_failed is neither', async () => {
    const body = await (await call(q)).json()
    expect(body.settlement.total.count).toBe(2)
    expect(body.refunds.count).toBe(1)
    expect(body.refunds.amountCents).toBe(-500)
  })

  it('maps gateway sales to card and keeps the non-gateway ledger\'s own method', async () => {
    const body = await (await call(q)).json()
    const by = Object.fromEntries(body.settlement.rows.map((r: any) => [r.method, r.count]))
    expect(by).toEqual({ card: 1, cash: 1 })
  })

  it('ignores pending orders when looking for coverage gaps', async () => {
    const body = await (await call(q)).json()
    expect(JSON.stringify(body.coverage)).not.toContain('40000')
  })

  it('looks an unmatched order up directly, so a settlement row dated far away is not a gap', async () => {
    tables.payment_events.push({
      id: 'a-late', restaurant_id: R_A, event_type: 'sale', amount: 10, created_at: '2026-10-25T10:00:00Z',
      order_ids: ['oa3'], origin: 'terminal_device', terminal_id: 't1',
    })
    const body = await (await call(q)).json()
    expect(body.coverage.uncoveredOrders).toBe(0)
    expect(body.settlement.total.count).toBe(2) // the late row is another day's money, not this one's
  })

  it('never returns order ids, references or other identifiers', async () => {
    const text = JSON.stringify(await (await call(q)).json())
    for (const secret of ['oa1', 'oa2', 'oa3', 'ob1', 't1', 'order_ids', 'payment_reference']) {
      expect(text).not.toContain(secret)
    }
  })
})

describe('time zone', () => {
  it('uses the venue\'s stored time zone for the day boundary', async () => {
    tables.restaurants[0].timezone = 'America/New_York'
    tables.payment_events.push({
      id: 'edge', restaurant_id: R_A, event_type: 'sale', amount: 1, created_at: '2026-10-10T23:30:00Z',
      order_ids: ['oe'], origin: 'gateway', terminal_id: null,
    })
    const body = await (await call(q)).json() // 10th in New York; the 11th in Windhoek
    expect(body.timeZone).toBe('America/New_York')
    expect(body.settlement.total.count).toBe(3)
  })

  it('falls back to Africa/Windhoek when the venue has none', async () => {
    tables.restaurants[0].timezone = ''
    expect((await (await call(q)).json()).timeZone).toBe('Africa/Windhoek')
  })
})
