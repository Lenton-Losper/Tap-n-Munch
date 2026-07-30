/**
 * BUG REPRO (bug-hunter): app/api/payments/reconcile/route.ts marks a CANCELLED order
 * paid. This is the same defect commit eb28b9f fixed in the paycloud webhook, surviving
 * in a different endpoint.
 *
 *   loadOrders (:22-27)   .select('*').eq('restaurant_id',..).in('id', orderIds)
 *                         -- fetched purely by id; no payment_status filter.
 *   short-circuit (:83)   rows.every((r) => r.data.payment_status === 'paid')
 *                         -- strict ===, and only fires when EVERY row is already paid,
 *                            so a 'cancelled' row falls straight through.
 *   expectedAmount (:86)  sums ALL rows' totals, cancelled ones included.
 *   patch (:172)          { status: nextStatus, payment_status: 'paid', ... }
 *                         .eq('id', orderId)  -- no payment_status predicate.
 *
 * nextStatus (:170-171) preserves a non-'pending' status verbatim, so a cancelled order
 * lands on status='cancelled' + payment_status='paid'. cancellation_reason / cancelled_at
 * are left intact (markOrderPaidConfirmed, the guarded path, clears both).
 *
 * VERIFIED AGAINST origin/main: `git diff origin/main -- app/api/payments/reconcile/route.ts`
 * is empty, so the working-tree file under test is byte-identical to origin/main.
 *
 * Asserts CURRENT behaviour; should FAIL once a claim guard is added.
 */
import { POST } from '@/app/api/payments/reconcile/route'

type Row = Record<string, any>

let orders: Row[] = []
let updateFilterCols: string[][] = []
let updatePatches: Record<string, unknown>[] = []

function makeSupabaseMock() {
  return {
    from: (table: string) => {
      if (table !== 'orders') throw new Error(`unexpected table ${table}`)
      return {
        select: () => {
          const filters: Array<[string, unknown]> = []
          const b: Record<string, any> = {
            eq(c: string, v: unknown) {
              filters.push([c, v])
              return b
            },
            in(c: string, vs: unknown[]) {
              filters.push([c, vs])
              return b
            },
            then(resolve: (v: unknown) => void) {
              const hit = orders.filter((r) =>
                filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)),
              )
              resolve({ data: hit, error: null })
            },
          }
          return b
        },
        update: (patch: Record<string, unknown>) => {
          const filters: Array<[string, unknown]> = []
          const b: Record<string, any> = {
            eq(c: string, v: unknown) {
              filters.push([c, v])
              return b
            },
            then(resolve: (v: unknown) => void) {
              updateFilterCols.push(filters.map(([c]) => c))
              updatePatches.push(patch)
              const hit = orders.filter((r) => filters.every(([c, v]) => r[c] === v))
              for (const r of hit) Object.assign(r, patch)
              resolve({ error: null })
            },
          }
          return b
        },
      }
    },
  }
}

jest.mock('@/lib/api/require-staff-permission', () => ({
  isAuthError: (v: unknown) => v instanceof Response,
  requireCallerRestaurantPermission: async () => ({
    supabase: makeSupabaseMock(),
    restaurantId: 'rest-uuid-1',
  }),
}))

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async () => 'rest-uuid-1',
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeSupabaseMock(),
}))

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({
    merchantNo: 'M1',
    storeNo: 'S1',
    terminalSn: 'T1',
  }),
}))

// Finatic says PAID. (Also avoids loading the real plain-ESM @/payments/paycloud,
// which ts-jest does not transform.)
let finaticAmount: number = 0
jest.mock('@/payments/paycloud', () => ({
  queryPaymentOrder: async () => ({
    rawResponse: {
      trans_status: 2,
      psn: 'TXN-REAL-123',
      amount: finaticAmount,
    },
  }),
}))

function makeReq(orderIds: string[]) {
  return new Request('https://example.test/api/payments/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: 'rest-1', orderIds }),
  })
}

describe('POST /api/payments/reconcile -- unguarded paid write (same class as eb28b9f)', () => {
  beforeEach(() => {
    updateFilterCols = []
    updatePatches = []
  })

  it('marks a CANCELLED order paid, leaving status=cancelled + payment_status=paid', async () => {
    orders = [
      {
        id: 'ord-cancelled',
        restaurant_id: 'rest-uuid-1',
        status: 'cancelled',
        payment_status: 'cancelled',
        cancellation_reason: 'auto_timeout',
        cancelled_at: '2026-07-30T18:02:00.000Z',
        total: 250,
        paycloud_merchant_order_no: 'FT1785311542',
      },
    ]
    finaticAmount = 250

    const res = await POST(makeReq(['ord-cancelled']))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, paid: true })

    const o = orders[0]
    expect(o.payment_status).toBe('paid')
    // nextStatus preserves 'cancelled' verbatim -> self-contradictory row.
    expect(o.status).toBe('cancelled')
    // Unlike markOrderPaidConfirmed, the cancellation evidence is NOT cleared.
    expect(o.cancellation_reason).toBe('auto_timeout')
    expect(o.cancelled_at).toBe('2026-07-30T18:02:00.000Z')
  })

  it('writes the paid patch filtered on id ONLY -- no payment_status predicate', async () => {
    orders = [
      {
        id: 'ord-x',
        restaurant_id: 'rest-uuid-1',
        status: 'cancelled',
        payment_status: 'cancelled',
        total: 100,
        paycloud_merchant_order_no: 'FT-X',
      },
    ]
    finaticAmount = 100

    await POST(makeReq(['ord-x']))

    expect(updateFilterCols).toEqual([['id']])
    expect(updatePatches[0]).toMatchObject({ payment_status: 'paid' })
    expect(Object.keys(updatePatches[0])).not.toContain('cancellation_reason')
  })

  it('counts a cancelled order total into expectedAmount, so the Finatic amount check passes on an inflated sum', async () => {
    orders = [
      {
        id: 'ord-live',
        restaurant_id: 'rest-uuid-1',
        status: 'ready',
        payment_status: 'pending',
        total: 100,
        paycloud_merchant_order_no: 'FT-MIX',
      },
      {
        id: 'ord-dead',
        restaurant_id: 'rest-uuid-1',
        status: 'cancelled',
        payment_status: 'cancelled',
        total: 400,
        paycloud_merchant_order_no: null,
      },
    ]
    // Only 100 was really owed, but expectedAmount = 100 + 400 = 500 and the check passes.
    finaticAmount = 500

    const res = await POST(makeReq(['ord-live', 'ord-dead']))
    expect(res.status).toBe(200)

    expect(orders[0].payment_status).toBe('paid')
    expect(orders[1].payment_status).toBe('paid')
    expect(orders[1].status).toBe('cancelled')
  })

  it('the :83 short-circuit is strict === , so a non-canonical "Paid" is re-marked', async () => {
    orders = [
      {
        id: 'ord-casing',
        restaurant_id: 'rest-uuid-1',
        status: 'completed',
        payment_status: 'Paid', // strict === 'paid' is false
        paid_at: 'ORIGINAL',
        total: 60,
        paycloud_merchant_order_no: 'FT-CASE',
      },
    ]
    finaticAmount = 60

    await POST(makeReq(['ord-casing']))

    expect(updatePatches).toHaveLength(1)
    expect(orders[0].payment_status).toBe('paid')
  })

  it('CONTROL: an all-paid set short-circuits at :83 and writes nothing', async () => {
    orders = [
      {
        id: 'ord-paid',
        restaurant_id: 'rest-uuid-1',
        status: 'completed',
        payment_status: 'paid',
        paid_at: 'ORIGINAL',
        total: 60,
        paycloud_merchant_order_no: 'FT-PAID',
      },
    ]
    finaticAmount = 60

    const res = await POST(makeReq(['ord-paid']))
    const body = await res.json()

    expect(body).toMatchObject({ ok: true, paid: true, source: 'supabase' })
    expect(updatePatches).toHaveLength(0)
    expect(orders[0].paid_at).toBe('ORIGINAL')
  })
})
