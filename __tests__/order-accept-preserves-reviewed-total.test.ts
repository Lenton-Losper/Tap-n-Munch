/**
 * Issue #125 — a QR order was priced at submission and then priced AGAIN at Accept.
 *
 * POST /api/orders prices the submission with calculateOrderPricing and stores the result on
 * order_requests. PATCH .../review re-prices staff edits with the same function into
 * *_reviewed. Accept then picks reviewed-if-present and hands those numbers to createOrder --
 * which threw them away and wrote `total: pricing.total` from a THIRD pricing pass taken at
 * Accept time. If the menu moved in between, the order was recorded at a total the customer
 * never confirmed.
 *
 * Which total is authoritative, and why this direction:
 *
 *   - Both candidates are server-computed. order_requests.total and total_reviewed are both
 *     calculateOrderPricing output; nothing client-supplied ever reaches them. So honouring the
 *     stored total does NOT open price tampering -- that is the fear that would justify
 *     re-pricing, and it does not apply here.
 *   - The stored total is the number the customer confirmed: the confirmation screen renders
 *     `total_reviewed ?? total` (lib/guest-orders/queries.ts mapOrderRequestToGuestRow).
 *   - The stored total is the number actually CHARGED: accept/route.ts builds the Finatic
 *     checkout from `Number(total)`. Re-pricing the row therefore made the recorded total
 *     disagree with the amount taken from the customer.
 *
 * The opposite fix -- trusting params.total inside createOrder for everyone -- would be a real
 * hole, because the other caller (app/api/terminal/orders) passes CLIENT-supplied totals. So
 * re-pricing stays the default and Accept opts in explicitly.
 */
import { POST } from '@/app/api/order-requests/[requestId]/accept/route'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const REQUEST_ID = 'req-1'

/** What the customer submitted and staff reviewed: two items, N$85.00 including N$5.00 tax. */
const REVIEWED_ITEMS = [
  { menuItemId: 'item-1', quantity: 1, unitPrice: 50, subtotal: 47.5, tax: 2.5, total: 50 },
  { menuItemId: 'item-2', quantity: 1, unitPrice: 35, subtotal: 32.5, tax: 2.5, total: 35 },
]

/**
 * What a fresh pricing pass at Accept time would say -- the menu moved after the customer
 * confirmed. This is the number that must NOT reach the orders row.
 */
const REPRICED_AT_ACCEPT = {
  items: [{ menuItemId: 'item-1', quantity: 1, unitPrice: 999, subtotal: 999, tax: 0, total: 999 }],
  subtotal: 120,
  tax: 8,
  total: 128,
  warnings: [],
}

jest.mock('@/payments/paycloud', () => ({
  createPaymentRequest: jest.fn(async () => ({ checkoutUrl: 'https://pay.test/s' })),
  paycloudWireMerchantOrderNo: (orderId: string) => String(orderId),
}))

jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({
    checkoutMerchantNo: 'm-1',
    checkoutStoreNo: 's-1',
  }),
}))

jest.mock('@/lib/api/require-staff-permission', () => ({
  requireStaffPermission: async () => ({ userId: 'staff-1' }),
  isAuthError: () => false,
}))

jest.mock('@/lib/order-routing', () => ({
  enrichOrderItemsWithRouteTo: async (_c: unknown, items: unknown[]) =>
    (items as object[]).map((i) => ({ ...i, route_to: 'kitchen' })),
}))

const calculateOrderPricing = jest.fn(async () => REPRICED_AT_ACCEPT)
jest.mock('@/lib/orders/calculate-order-pricing', () => ({
  calculateOrderPricing: (...args: unknown[]) => calculateOrderPricing(...(args as [])),
  UnmatchedMenuItemError: class UnmatchedMenuItemError extends Error {},
}))

let requestRow: Record<string, unknown>
let insertedOrder: Record<string, unknown> | null = null

function makeClient() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {}
      const chain = () => builder

      Object.assign(builder, {
        select: chain,
        eq: chain,
        in: chain,
        gte: chain,
        is: chain,
        not: chain,
        order: chain,
        limit: chain,
        update: chain,
        maybeSingle: async () => {
          if (table === 'order_requests') return { data: requestRow, error: null }
          // The order-number allocator reads the restaurant's high-water mark (#127):
          // `.from('orders').select('order_number').eq(...).not(...).order(...).limit(1)`.
          // 4 here so the allocator issues 5, matching the row the insert stub returns.
          if (table === 'orders') return { data: { order_number: 4 }, error: null }
          return { data: null, error: null }
        },
        single: async () => ({ data: null, error: null }),
        then: (resolve: (r: unknown) => unknown) => Promise.resolve(resolve({ count: 4, error: null })),
        insert: (row: Record<string, unknown>) => {
          if (table === 'orders') insertedOrder = row
          return {
            select: () => ({
              single: async () => ({
                data: {
                  id: 'order-new',
                  restaurant_id: RESTAURANT_UUID,
                  order_number: 5,
                  payment_status: 'pending',
                },
                error: null,
              }),
            }),
          }
        },
      })

      return builder
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => makeClient(),
}))

beforeEach(() => {
  insertedOrder = null
  calculateOrderPricing.mockClear()
  requestRow = {
    id: REQUEST_ID,
    restaurant_id: RESTAURANT_UUID,
    firebase_restaurant_id: RESTAURANT_UUID,
    status: 'waiting_review',
    channel: 'table',
    table_number: 7,
    table_id: 'table-7',
    session_id: 'sess-1',
    member_session_id: null,
    customer_name: 'Dana',
    order_instructions: null,
    payment_method: 'card',
    payment_channel: null,
    tab_id: null,
    tab_settlement_for_tab_id: null,
    idempotency_key: null,
    // Original submission.
    items: REVIEWED_ITEMS,
    subtotal: 80,
    tax: 5,
    total: 85,
    // Staff review saved the same figures back (calculateOrderPricing output).
    items_reviewed: REVIEWED_ITEMS,
    subtotal_reviewed: 80,
    tax_reviewed: 5,
    total_reviewed: 85,
  }
})

async function accept() {
  const res = await POST(new Request('https://example.test/accept', { method: 'POST' }), {
    params: Promise.resolve({ requestId: REQUEST_ID }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('Accept — the reviewed total is what gets recorded', () => {
  it('records the staff-reviewed total, not a total re-priced at Accept', async () => {
    const { status } = await accept()

    expect(status).toBe(200)
    expect(insertedOrder).not.toBeNull()
    expect(insertedOrder!.total).toBe(85)
    expect(insertedOrder!.subtotal).toBe(80)
    expect(insertedOrder!.tax).toBe(5)
  })

  it('records the reviewed line items, not re-priced ones', async () => {
    await accept()

    const items = insertedOrder!.items as Array<Record<string, unknown>>
    expect(items.map((i) => i.menuItemId)).toEqual(['item-1', 'item-2'])
    expect(items.every((i) => i.route_to === 'kitchen')).toBe(true)
    expect(items.map((i) => i.unitPrice)).toEqual([50, 35])
  })

  it('does not re-price at all on the Accept path', async () => {
    // The stored figures already came from calculateOrderPricing at submission/review. A third
    // pass here can only introduce drift between what was quoted, charged, and recorded.
    await accept()
    expect(calculateOrderPricing).not.toHaveBeenCalled()
  })

  it('falls back to the original submission figures when no review was saved', async () => {
    requestRow.items_reviewed = null
    requestRow.subtotal_reviewed = null
    requestRow.tax_reviewed = null
    requestRow.total_reviewed = null

    await accept()

    expect(insertedOrder!.total).toBe(85)
    expect(insertedOrder!.subtotal).toBe(80)
    expect(insertedOrder!.tax).toBe(5)
  })
})
