/**
 * Issue #124 — the payment-method allowlist was bypassed whenever the client omitted the field.
 *
 * POST /api/orders reads the raw `paymentMethod`, which is `undefined` when unset, and guards
 * with `if (paymentMethod && !allowedMethods.includes(paymentMethod))`. That short-circuits on
 * undefined, so the check never runs. But `resolvedPaymentMethod` has already defaulted to
 * 'cash' further up, and IT is what gets written to order_requests.payment_method /
 * orders.payment_method. A card-only restaurant therefore booked cash orders from any client
 * that simply left the field out.
 *
 * The test drives the real route handler and asserts on the WRITE, not just the status code:
 * the bug is that a row was persisted with a payment method the restaurant does not accept.
 */
import { POST } from '@/app/api/orders/route'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

// payments/paycloud.js is plain ESM and is not transformed by ts-jest, so importing the route
// unmocked fails at parse time with "Cannot use import statement outside a module" -- a broken
// suite, not a behavioural result. Mocked the same way __tests__/webhook-sig-fallback-route
// handles @/payments/webhook. Neither export is reached on the table/kiosk path under test:
// hosted checkout is deferred to Accept.
jest.mock('@/payments/paycloud', () => ({
  createPaymentRequest: jest.fn(async () => ({ checkoutUrl: 'https://pay.test/session' })),
  paycloudWireMerchantOrderNo: (orderId: string) => String(orderId),
}))

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({
    checkoutMerchantNo: 'merchant-1',
    checkoutStoreNo: 'store-1',
  }),
}))

jest.mock('@/lib/supabase/restaurants', () => ({
  resolveRestaurantUuid: async () => RESTAURANT_UUID,
  resolveOrderRestaurantScope: async () => ({
    restaurantId: RESTAURANT_UUID,
    firebaseRestaurantId: RESTAURANT_UUID,
  }),
}))

jest.mock('@/lib/orders/check-stock-sufficiency', () => ({
  checkStockSufficiency: async () => ({ ok: true, unavailable: [] }),
}))

jest.mock('@/lib/orders/calculate-order-pricing', () => ({
  calculateOrderPricing: async () => ({
    items: [{ menuItemId: 'item-1', quantity: 1, subtotal: 50, tax: 0, total: 50 }],
    subtotal: 50,
    tax: 0,
    total: 50,
    warnings: [],
  }),
  UnmatchedMenuItemError: class UnmatchedMenuItemError extends Error {},
}))

jest.mock('@/lib/order-routing', () => ({
  enrichOrderItemsWithRouteTo: async (_c: unknown, items: unknown[]) => items,
}))

// A tab order carries a session token (route.ts:98). Only the tab path reaches this, so the
// direct-order cases below are unaffected by the mock.
jest.mock('@/lib/session-guard', () => ({
  requireSessionToken: async () => ({
    tabId: 'tab-1',
    restaurantId: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
  }),
  assertSessionMatchesResource: () => null,
}))

/** Rows inserted by the route, so a test can assert what was actually persisted. */
let inserted: Array<{ table: string; row: Record<string, unknown> }> = []
let allowedPaymentMethods: string[] = ['cash', 'card']

function makeClient() {
  return {
    from(table: string) {
      return {
        select(columns: string) {
          const builder = {
            eq: () => builder,
            maybeSingle: async () => {
              if (table === 'restaurant_tables') {
                return columns.includes('is_view_only')
                  ? { data: { is_view_only: false }, error: null }
                  : { data: { id: 'table-uuid', active: true, is_kiosk: false }, error: null }
              }
              if (table === 'tabs') {
                // An open tab exists for the table, so the "table has been closed" guard passes.
                return { data: { id: 'tab-1', status: 'open', total: 0, members: [] }, error: null }
              }
              if (table === 'restaurant_settings') {
                return {
                  data: { payment_methods: allowedPaymentMethods, settings_version: 3 },
                  error: null,
                }
              }
              return { data: null, error: null }
            },
            single: async () => ({ data: null, error: null }),
          }
          return builder
        },
        insert(row: Record<string, unknown>) {
          inserted.push({ table, row })
          return {
            select: () => ({
              single: async () => ({
                data: { id: 'new-row-id', restaurant_id: RESTAURANT_UUID },
                error: null,
              }),
            }),
          }
        },
      }
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeClient(),
}))

beforeEach(() => {
  inserted = []
  allowedPaymentMethods = ['cash', 'card']
})

function orderBody(extra: Record<string, unknown> = {}) {
  return {
    restaurantId: RESTAURANT_UUID,
    channel: 'table',
    tableNumber: 5,
    sessionId: 'sess-1',
    items: [{ menuItemId: 'item-1', quantity: 1 }],
    subtotal: 50,
    total: 50,
    ...extra,
  }
}

async function postOrder(extra: Record<string, unknown> = {}) {
  const res = await POST(
    new Request('https://example.test/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(orderBody(extra)),
    }),
  )
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body }
}

const persistedPaymentMethods = () =>
  inserted.map((i) => i.row.payment_method).filter((m) => m !== undefined)

describe('POST /api/orders — payment method allowlist', () => {
  it('rejects the DEFAULTED cash method at a card-only restaurant when the client omits the field', async () => {
    allowedPaymentMethods = ['card']

    const { status, body } = await postOrder() // no paymentMethod at all

    // Asserted first because it is the actual harm: before the fix this route persisted an
    // order_requests row carrying payment_method 'cash' at a restaurant that only takes card.
    expect(persistedPaymentMethods()).toEqual([])
    expect(inserted).toHaveLength(0)
    expect(status).toBe(403)
    expect(String(body.error)).toMatch(/does not accept cash/i)
  })

  it('rejects an explicit cash method at a card-only restaurant', async () => {
    allowedPaymentMethods = ['card']

    const { status } = await postOrder({ paymentMethod: 'cash' })

    expect(status).toBe(403)
    expect(inserted).toHaveLength(0)
  })

  it('accepts an allowed method at a card-only restaurant', async () => {
    allowedPaymentMethods = ['card']

    const { status } = await postOrder({ paymentMethod: 'card' })

    expect(status).toBe(200)
    expect(persistedPaymentMethods()).toEqual(['card'])
  })

  it('still defaults to cash when the restaurant accepts cash', async () => {
    allowedPaymentMethods = ['cash', 'card']

    const { status } = await postOrder()

    expect(status).toBe(200)
    expect(persistedPaymentMethods()).toEqual(['cash'])
  })

  it('rejects a method the restaurant does not list at all', async () => {
    allowedPaymentMethods = ['cash']

    const { status } = await postOrder({ paymentMethod: 'card' })

    expect(status).toBe(403)
    expect(inserted).toHaveLength(0)
  })
})

/**
 * Issue #202 — a TAB order has no payment method yet, so the allowlist has nothing to check.
 *
 * The cart's handleAddToTab sends no paymentMethod at all (it cannot: on a tab the method is
 * chosen later, at settlement). route.ts:109 then defaults resolvedPaymentMethod to 'cash', and
 * the #124 guard above — correctly, for a direct order — validates that DEFAULTED value. At a
 * card-only restaurant the result was a 403 PAYMENT_METHOD_REQUIRED on every QR tab submission.
 * Riviera and FNB ChowNow both sit at payment_methods=["card"] in production, and Riviera is the
 * venue the whole QR path exists to serve.
 *
 * The defect is not the guard. It is that the guard is being asked a question that has no answer
 * yet, and the server invents 'cash' to answer it — the same shape of invented value #124 closed.
 * So the exemption is explicit and scoped to the tab path, and #124's guard is untouched.
 *
 * THE CONTROL IS THE DESCRIBE BLOCK ABOVE. Every test in it is a direct order; all five passed
 * BEFORE this change and must still pass after. That is what proves the exemption did not reopen
 * #124 — they are the "still rejects" half, and they were never red.
 *
 * Of the two tests below, only the CARD-ONLY one was red before (403 PAYMENT_METHOD_REQUIRED).
 * The cash-only one passed already, because the invented default happens to be 'cash' and 'cash'
 * happens to be allowed there — which is precisely the accident this exemption removes reliance
 * on. It is kept as a control showing the exemption is not card-specific, not as failing-first
 * evidence.
 */
describe('POST /api/orders — tab orders are exempt from the allowlist (#202)', () => {
  const postTabOrder = (extra: Record<string, unknown> = {}) =>
    postOrder({ tabId: 'tab-1', memberSessionId: 'sess-1', ...extra })

  it('accepts a tab order at a CARD-ONLY restaurant, where the cart sends no method', async () => {
    // The exact production shape: Riviera at payment_methods=["card"], cart omits paymentMethod.
    allowedPaymentMethods = ['card']

    const { status, body } = await postTabOrder()

    expect({ status, code: body.code }).toEqual({ status: 200, code: undefined })
    expect(inserted.length).toBeGreaterThan(0)
  })

  it('accepts a tab order at a CASH-ONLY restaurant too — the method is simply not yet known', async () => {
    // Not a special case for 'card'. The point is that NO method has been chosen, so no value
    // of payment_methods can make the question answerable at submission time.
    allowedPaymentMethods = ['cash']

    const { status } = await postTabOrder()

    expect(status).toBe(200)
    expect(inserted.length).toBeGreaterThan(0)
  })
})
