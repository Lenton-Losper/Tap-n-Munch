/**
 * #240 — the POS repricing control had no test.
 *
 * `app/api/terminal/orders/route.ts` passes CLIENT-supplied `subtotal`/`total` into
 * `createOrder`. What stops a modified till from setting its own prices is one branch:
 * `lib/orders/create-order.ts:69-89` re-prices from the catalog whenever `preauthorizedPricing`
 * is absent, and the terminal leg never sets it. `CreateOrderParams.preauthorizedPricing`'s own
 * doc comment calls that recompute "the anti-tampering control" and says it "must not be
 * bypassed" — and nothing downstream would notice if it were: `lib/receipts/issueReceipt.ts`
 * :266-271 copies `order.subtotal`/`tax`/`total` straight into the receipt snapshot rather than
 * re-deriving them.
 *
 * Measured before writing this: replacing ONLY that default branch with the caller's own
 * numbers left five pricing/order suites at 43/43 green, identical to baseline. The control
 * deleted clean.
 *
 * WHY calculateOrderPricing IS NOT MOCKED HERE. The point is coverage on the real money path,
 * so the pricing function runs for real against a fake `menu_items` row. Only Supabase is
 * faked. A mock of the pricer would move the assertion onto the mock and prove nothing about
 * what a till can charge.
 *
 * WHY createOrder AND NOT THE ROUTE. `lib/terminal-auth.ts` imports `jose`, which is ESM-only
 * and cannot be loaded by ts-jest — importing the route makes the suite fail to load, which
 * looks like a failing test and is not one. So this binds one frame below the route, and the
 * route's use of it is covered by reading plus `tsc`, not by this test.
 *
 * BOTH BRANCHES, deliberately. A test that only pinned the terminal leg could be satisfied by
 * forcing repricing everywhere, which would silently undo #125 — the Accept leg must still
 * persist its pre-authorised figures verbatim.
 */
import { createOrder } from '@/lib/orders/create-order'

const RESTAURANT_UUID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const MENU_ITEM_ID = 'e0cce45c-1b65-4a1f-8c20-939bbbfe7c31'

/**
 * The catalog. Unit price for the line below is 25 (base) + 10 (Large) + 5 (Oat milk) = 40,
 * so three of them is 120.00. No tax_rates rows, so tax is 0 and total == subtotal
 * (apply-tax.ts:47-50) -- VAT arithmetic is covered by receipt-vat-arithmetic.test.ts and is
 * deliberately kept out of the way here.
 */
const MENU_ITEM_ROW = {
  id: MENU_ITEM_ID,
  base_price: 25,
  sizes: [{ name: 'Large', price_modifier: 10 }],
  addons: [{ name: 'Oat milk', price: 5 }],
  tax_rate_id: null,
  status: 'active',
}

const CATALOG_TOTAL = 120

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
        order: chain,
        /*
         * Every read in this path ends by awaiting the builder itself:
         *   orders     -> .select('*', { count: 'exact', head: true }).eq(...)  (order number)
         *   menu_items -> .select(...).eq(...).in(...)                          (pricing)
         *   tax_rates  -> .select(...).eq(...).order(...)                       (pricing)
         */
        then: (resolve: (r: unknown) => unknown) => {
          if (table === 'menu_items') {
            return Promise.resolve(resolve({ data: [MENU_ITEM_ROW], error: null }))
          }
          if (table === 'tax_rates') {
            return Promise.resolve(resolve({ data: [], error: null }))
          }
          return Promise.resolve(resolve({ count: 41, error: null }))
        },
        insert: (row: Record<string, unknown>) => {
          if (table === 'orders') insertedOrder = row
          return {
            select: () => ({
              single: async () => ({
                data: {
                  id: 'order-new',
                  restaurant_id: RESTAURANT_UUID,
                  order_number: 42,
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

/** Exactly the shape app/api/terminal/orders/route.ts:122-142 builds. */
function terminalCall(clientSubtotal: number, clientTotal: number) {
  return {
    restaurantId: RESTAURANT_UUID,
    firebaseRestaurantId: RESTAURANT_UUID,
    tableNumber: 0,
    tableId: null,
    sessionId: null,
    memberSessionId: null,
    items: [
      {
        menuItemId: MENU_ITEM_ID,
        name: 'Americano',
        quantity: 3,
        size: 'Large',
        // A client-supplied PRICE on a matched addon. priceCatalogLine reads the catalog's
        // own price for a name it matches, so this number must never reach the total.
        // "Free caviar" is not in the catalog at all: matched by NAME, found missing, dropped
        // with a warning and never priced (calculate-order-pricing.ts:106-113).
        addons: [
          { name: 'Oat milk', price: -100 },
          { name: 'Free caviar', price: -9999 },
        ],
        specialInstructions: '',
        route_to: 'kitchen',
      },
    ],
    subtotal: clientSubtotal,
    total: clientTotal,
    paymentMethod: 'card',
    paymentChannel: 'card_manual',
    paymentStatus: 'pending',
    orderInstructions: null,
    tabId: null,
    tabSettlementForTabId: null,
    channel: 'pos',
    customerName: null,
    idempotencyKey: null,
    isClosed: true,
  }
}

beforeEach(() => {
  insertedOrder = null
  jest.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('#240: createOrder re-prices the terminal/POS leg from the catalog', () => {
  it('discards a client-supplied total and stores the catalog figure', async () => {
    await createOrder(terminalCall(0.01, 0.01) as never)

    expect(insertedOrder).not.toBeNull()
    expect(insertedOrder!.total).toBe(CATALOG_TOTAL)
    expect(insertedOrder!.subtotal).toBe(CATALOG_TOTAL)
    expect(insertedOrder!.tax).toBe(0)
    expect(insertedOrder!.channel).toBe('pos')
  })

  it('discards an inflated client total the same way', async () => {
    await createOrder(terminalCall(99999, 99999) as never)

    expect(insertedOrder!.total).toBe(CATALOG_TOTAL)
  })

  it('prices the line from the catalog, not from client-supplied addon prices', async () => {
    await createOrder(terminalCall(0.01, 0.01) as never)

    const lines = insertedOrder!.items as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    // 25 base + 10 Large + 5 Oat milk. The client's -100 on that same addon is ignored.
    expect(lines[0].unitPrice).toBe(40)
    expect(lines[0].quantity).toBe(3)
    expect(lines[0].subtotal).toBe(CATALOG_TOTAL)
    expect(lines[0].priceSource).toBe('catalog')
  })

  it('still lets the Accept leg persist pre-authorised pricing verbatim', async () => {
    // #125: those figures are already calculateOrderPricing output, they are what the customer
    // confirmed, and they are what the checkout charged. Re-pricing them here would make the
    // recorded total drift from the amount actually taken. So this must NOT become 120.
    await createOrder({
      ...terminalCall(85, 85),
      channel: 'table',
      preauthorizedPricing: {
        items: [{ menuItemId: MENU_ITEM_ID, quantity: 1, unitPrice: 85 }],
        subtotal: 80,
        tax: 5,
        total: 85,
      },
    } as never)

    expect(insertedOrder!.total).toBe(85)
    expect(insertedOrder!.subtotal).toBe(80)
    expect(insertedOrder!.tax).toBe(5)
  })

  /**
   * The reverse link (20260816090000). The point of putting it on the order row is that it is
   * written by the SAME INSERT that creates the order -- there is no window in which the order
   * exists without knowing where it came from, and no transaction is needed to achieve that.
   *
   * Asserting it on the insert PAYLOAD is what proves that: a later UPDATE would satisfy a test
   * that only checked the stored row, and would reintroduce exactly the gap this closes.
   */
  it('writes source_request_id in the SAME insert that creates the order', async () => {
    await createOrder({
      ...terminalCall(85, 85),
      channel: 'table',
      sourceRequestId: 'req-abc',
      preauthorizedPricing: {
        items: [{ menuItemId: MENU_ITEM_ID, quantity: 1, unitPrice: 85 }],
        subtotal: 80,
        tax: 5,
        total: 85,
      },
    } as never)

    expect(insertedOrder!.source_request_id).toBe('req-abc')
  })

  it('writes NULL when there is no request — terminal/POS never has one', async () => {
    // NULL must mean "not from a request", never "link missing", so the column is always present
    // in the payload rather than omitted.
    await createOrder(terminalCall(0.01, 0.01) as never)

    expect(insertedOrder!).toHaveProperty('source_request_id')
    expect(insertedOrder!.source_request_id).toBeNull()
  })
})
