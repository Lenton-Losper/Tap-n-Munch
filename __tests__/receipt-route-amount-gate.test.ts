/**
 * #223 — the eighth gate. POST /api/payments/receipt compared a client-submitted amount
 * against the order sum with `Math.abs(Math.round(sum*100)/100 - Math.round(clientAmount*100)/100) > 0.02`.
 * Two defects in one line:
 *   - raw floats: a genuine one-cent difference is refused or accepted depending on binary
 *     representation, not on the actual amounts (#180's shape).
 *   - NaN passthrough: when `body.amount` was missing/unparseable, `clientAmount` was `NaN`,
 *     `Math.abs(NaN - x)` is `NaN`, and `NaN > 0.02` is `false` — so an ABSENT client amount
 *     silently passed instead of being refused.
 *
 * This is a CLIENT leg (validates before the PayCloud checkout is created; nothing has been
 * charged yet), so it takes PAYMENT_AMOUNT_TOLERANCE_CENTS (one cent), not the gateway's zero.
 *
 * No baseline suite existed for this route before this test — empty, stated rather than implied.
 */
import { POST } from '@/app/api/payments/receipt/route'

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async (id: string) => id,
}))

jest.mock('@/payments/paycloud', () => ({
  createPaymentRequest: jest.fn(async () => ({
    paymentStatus: 'pending',
    requires3ds: false,
    checkoutUrl: null,
  })),
}))

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({
    checkoutMerchantNo: 'M1',
    checkoutStoreNo: 'S1',
  }),
}))

jest.mock('@/lib/session-guard', () => ({
  requireSessionToken: async () => ({ error: null, tabId: null }),
  assertSessionMatchesResource: () => null,
}))

type Row = Record<string, unknown>

const order: Row = {
  id: 'ord-1',
  restaurant_id: 'rest-1',
  table_number: 5,
  is_closed: false,
  tab_id: null,
  total: 100,
  payment_status: 'pending',
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      if (table !== 'orders') throw new Error(`unexpected table ${table}`)
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        update: () => ({ eq: async () => ({ error: null }) }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          Promise.resolve({ data: [order], error: null }).then(resolve),
      }
      return builder
    },
  }),
}))

function makeReq(amount: unknown) {
  return new Request('https://example.test/api/payments/receipt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ restaurantId: 'rest-1', tableNumber: 5, orderIds: ['ord-1'], amount }),
  })
}

describe('#223 — POST /api/payments/receipt amount gate', () => {
  test('exact agreement: proceeds past the gate (control)', async () => {
    const res = await POST(makeReq(100))
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.ok).toBe(true)
  })

  test('one cent apart: within CLIENT tolerance, proceeds', async () => {
    const res = await POST(makeReq(100.01))
    expect(res.status).toBe(201)
  })

  test('two cents apart: refused', async () => {
    const res = await POST(makeReq(100.02))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.ok).toBe(false)
  })

  test('absent amount (NaN passthrough): now refused, previously silently accepted', async () => {
    const res = await POST(makeReq(undefined))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.ok).toBe(false)
  })

  test('garbage amount string: refused', async () => {
    const res = await POST(makeReq('not-a-number'))
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.ok).toBe(false)
  })
})
