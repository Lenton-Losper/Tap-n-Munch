/**
 * Issue #122(a) — GET /api/guest/orders/by-payment-ref had no authentication of any kind.
 *
 * It read `?ref=`/`?tn=` and returned up to 15 full order rows — items, totals, customer_name,
 * session ids — to anyone who could name a payment reference. Its sibling guest routes
 * (app/api/guest/orders/[orderId]/receipt) all resolve the restaurant and then gate the row
 * through guestCanAccessOrder; this one did not, so a guessed reference was a complete
 * cross-customer read.
 *
 * These tests drive the real route handler over a PostgREST-shaped stub that actually APPLIES
 * the filters the query layer sets. That matters: if the stub ignored `.eq('restaurant_id', …)`
 * the cross-tenant test would pass for the wrong reason.
 */
import { GET } from '@/app/api/guest/orders/by-payment-ref/route'

type Row = Record<string, unknown>

const REF_A = 'PAY-20260808-ABCDEFGH'
const REF_PAID = 'PAY-20260808-PAIDPAID'

/** Open (unpaid) order at restaurant A. The row an enumerator wants. */
const ROW_OPEN_A: Row = {
  id: 'order-a',
  restaurant_id: 'rest-a',
  table_number: 5,
  session_id: 'sess-a',
  is_closed: false,
  status: 'pending',
  payment_status: 'pending',
  payment_reference: REF_A,
  paycloud_merchant_order_no: null,
  customer_name: 'Alice',
  total: 120,
}

/** Paid order at restaurant A — the shareable receipt-link case the siblings allow. */
const ROW_PAID_A: Row = {
  id: 'order-paid',
  restaurant_id: 'rest-a',
  table_number: 9,
  session_id: 'sess-paid',
  is_closed: false,
  status: 'completed',
  payment_status: 'paid',
  payment_reference: REF_PAID,
  paycloud_merchant_order_no: null,
  customer_name: 'Carol',
  total: 60,
}

const ALL_ROWS = [ROW_OPEN_A, ROW_PAID_A]

jest.mock('@/lib/supabase/restaurants', () => ({
  // The route may pass a slug or a uuid; staging resolves both to the uuid. Identity keeps the
  // test about access control rather than about slug resolution.
  resolveRestaurantUuid: async (input: string) => String(input),
}))

/**
 * Minimal PostgREST-shaped stub over `orders`. Records and APPLIES `.or()` (the
 * payment_reference / paycloud_merchant_order_no disjunction), `.eq()` and `.limit()`.
 */
function makeSupabaseStub(rows: Row[]) {
  const applied: { or: string[]; eq: Array<[string, unknown]>; limit: number | null } = {
    or: [],
    eq: [],
    limit: null,
  }

  const resolve = () => {
    let out = rows
    for (const clause of applied.or) {
      // `col.eq.value,col2.eq.value` — the only shape paymentRefOrFilter produces.
      const wanted = clause.split(',').map((part) => {
        const [column, op, ...rest] = part.split('.')
        if (op !== 'eq') throw new Error(`stub only models .eq inside or(): ${part}`)
        return { column, value: rest.join('.') }
      })
      out = out.filter((row) => wanted.some((w) => String(row[w.column] ?? '') === w.value))
    }
    for (const [column, value] of applied.eq) {
      out = out.filter((row) => String(row[column] ?? '') === String(value))
    }
    if (applied.limit != null) out = out.slice(0, applied.limit)
    return { data: out, error: null }
  }

  const builder = {
    or(clause: string) {
      applied.or.push(clause)
      return builder
    },
    eq(column: string, value: unknown) {
      applied.eq.push([column, value])
      return builder
    },
    limit(n: number) {
      applied.limit = n
      return builder
    },
    then(onFulfilled: (r: ReturnType<typeof resolve>) => unknown) {
      return Promise.resolve(onFulfilled(resolve()))
    },
  }

  return {
    applied,
    client: {
      from(table: string) {
        if (table !== 'orders') throw new Error(`unexpected table ${table}`)
        return { select: () => builder }
      },
    },
  }
}

let stub = makeSupabaseStub(ALL_ROWS)
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => stub.client,
}))

beforeEach(() => {
  stub = makeSupabaseStub(ALL_ROWS)
})

async function call(query: string) {
  const res = await GET(new Request(`https://example.test/api/guest/orders/by-payment-ref?${query}`))
  const body = (await res.json()) as { orders?: Row[]; count?: number; error?: string }
  return { status: res.status, body }
}

describe('GET /api/guest/orders/by-payment-ref — access control', () => {
  it('refuses a bare reference lookup that carries no restaurant context', async () => {
    const { status, body } = await call(`ref=${REF_A}`)
    expect(status).toBe(400)
    expect(body.orders).toBeUndefined()
  })

  it('refuses the same enumeration through the ?tn= alias', async () => {
    const { status, body } = await call(`tn=${REF_A}`)
    expect(status).toBe(400)
    expect(body.orders).toBeUndefined()
  })

  it('does not return another restaurant’s order to a caller scoped elsewhere', async () => {
    const { status, body } = await call(`ref=${REF_A}&restaurantId=rest-b`)
    expect(status).toBe(200)
    expect(body.orders).toEqual([])
    // The restaurant filter must reach the query, not just the post-filter.
    expect(stub.applied.eq).toContainEqual(['restaurant_id', 'rest-b'])
  })

  it('does not return an OPEN order to a caller with no table or session binding', async () => {
    const { status, body } = await call(`ref=${REF_A}&restaurantId=rest-a`)
    expect(status).toBe(200)
    expect(body.orders).toEqual([])
    expect(body.count).toBe(0)
  })

  it('does not return an OPEN order to a caller holding the wrong session', async () => {
    const { body } = await call(`ref=${REF_A}&restaurantId=rest-a&session_id=sess-someone-else`)
    expect(body.orders).toEqual([])
  })

  it('does not return an OPEN order to a caller claiming the wrong table', async () => {
    const { body } = await call(`ref=${REF_A}&restaurantId=rest-a&table_number=6`)
    expect(body.orders).toEqual([])
  })

  it('returns the open order to the session that placed it', async () => {
    const { status, body } = await call(`ref=${REF_A}&restaurantId=rest-a&session_id=sess-a`)
    expect(status).toBe(200)
    expect(body.orders?.map((o) => o.id)).toEqual(['order-a'])
  })

  it('returns the open order to its own table (the hosted-checkout return URL carries rid + table)', async () => {
    const { body } = await call(`ref=${REF_A}&restaurantId=rest-a&table_number=5`)
    expect(body.orders?.map((o) => o.id)).toEqual(['order-a'])
  })

  it('still serves a PAID order on restaurant scope alone (sibling receipt-link pattern)', async () => {
    const { status, body } = await call(`ref=${REF_PAID}&restaurantId=rest-a`)
    expect(status).toBe(200)
    expect(body.orders?.map((o) => o.id)).toEqual(['order-paid'])
  })
})
