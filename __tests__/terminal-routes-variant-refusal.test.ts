/**
 * Sprint 2026-09-28, contracts C5 + C6, at the ROUTE: `/api/terminal/orders` (Sale) and
 * `/api/terminal/rounds` (Add a Round).
 *
 * Before: both routes called createOrder without any variant requirement, so a variant item with
 * no selection was priced at base_price (often the schema default, N$0); and both turned every
 * pricing refusal into a 500, which the terminal retries -- a round the server will never accept,
 * re-sent forever.
 *
 * The real createOrder and calculateOrderPricing run here; auth, feature flags, stock, routing
 * and Supabase are faked. `lib/terminal-auth` is mocked because it imports `jose`, which ts-jest
 * cannot load.
 */
import { POST as postOrder } from '@/app/api/terminal/orders/route'
import { POST as postRound } from '@/app/api/terminal/rounds/route'

const RESTAURANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TAB_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    terminalId: 'term-1',
    restaurantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => ({ id: 'term-1', status: 'active' }),
}))
jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: true }),
}))
jest.mock('@/lib/supabase/restaurants', () => ({
  resolveOrderRestaurantScope: async (id: string) => ({ restaurantId: id, firebaseRestaurantId: id }),
}))
jest.mock('@/lib/order-routing', () => ({
  enrichOrderItemsWithRouteTo: async (_s: unknown, items: unknown[]) => items,
}))
jest.mock('@/lib/orders/check-stock-sufficiency', () => ({
  checkStockSufficiency: async () => ({ ok: true, unavailable: [] }),
}))
jest.mock('@/lib/orders/auto-cancel-stale-pos-orders', () => ({
  autoCancelStalePosOrders: async () => undefined,
}))
jest.mock('@/lib/payments/get-payment-projection', () => ({
  getPaymentProjections: async () => new Map(),
}))
jest.mock('@/lib/stations/realtime-invalidate', () => ({
  broadcastLineChanged: async () => undefined,
}))

const LATTE = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Latte',
  base_price: 0,
  sizes: [],
  addons: [],
  variants: null,
  variant_groups: [
    {
      name: 'Size',
      required: true,
      type: 'price',
      options: [
        { label: 'Small', price: 30 },
        { label: 'Large', price: 40 },
      ],
    },
  ],
  category_id: null,
  tax_rate_id: null,
  status: 'available',
}

let insertedOrder: Record<string, unknown> | null = null
let insertedLines: Array<Record<string, unknown>> = []

/** One chainable builder per call; the terminal op (await / single / maybeSingle) decides the answer. */
function makeClient() {
  return {
    from(table: string) {
      let op: 'select' | 'insert' = 'select'
      let payload: unknown = null
      const answer = (single: boolean) => {
        if (table === 'menu_items') return { data: [LATTE], error: null }
        if (table === 'tabs') {
          return {
            data: { id: TAB_ID, restaurant_id: RESTAURANT, table_id: null, table_number: 7, status: 'open', opened_by_user_id: null },
            error: null,
          }
        }
        if (table === 'orders') {
          if (op === 'insert') {
            insertedOrder = payload as Record<string, unknown>
            return { data: { id: 'order-new', restaurant_id: RESTAURANT, order_number: 42, payment_status: 'pending' }, error: null }
          }
          if (single) return { data: { id: 'order-new', items: insertedOrder?.items ?? [] }, error: null }
          return { data: [{ order_number: 41 }], error: null }
        }
        if (table === 'order_lines') {
          if (op === 'insert') {
            insertedLines = payload as Array<Record<string, unknown>>
            return { data: insertedLines.map((l, i) => ({ id: `line-${i}`, route_to: l.route_to })), error: null }
          }
          return { data: [], error: null }
        }
        return { data: [], error: null }
      }
      const b: Record<string, unknown> = {}
      const chain = () => b
      Object.assign(b, {
        select: chain, eq: chain, in: chain, not: chain, neq: chain, is: chain, order: chain, limit: chain,
        insert: (row: unknown) => {
          op = 'insert'
          payload = row
          return b
        },
        single: async () => answer(true),
        maybeSingle: async () => answer(true),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(answer(false)).then(resolve, reject),
      })
      return b
    },
  }
}

jest.mock('@/lib/supabase/server', () => ({ createServerSupabaseClient: () => makeClient() }))

function orderReq(items: unknown[]) {
  return new Request('https://example.test/api/terminal/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RESTAURANT, items, subtotal: 1, total: 1 }),
  })
}
function roundReq(items: unknown[]) {
  return new Request('https://example.test/api/terminal/rounds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-idempotency-key': 'key-1' },
    body: JSON.stringify({ tab_id: TAB_ID, items, subtotal: 1, total: 1 }),
  })
}

beforeEach(() => {
  insertedOrder = null
  insertedLines = []
  jest.spyOn(console, 'error').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

const routes: Array<[string, (items: unknown[]) => Promise<Response>]> = [
  ['POST /api/terminal/orders', (items) => postOrder(orderReq(items))],
  ['POST /api/terminal/rounds', (items) => postRound(roundReq(items))],
]

describe.each(routes)('%s', (_name, send) => {
  it('refuses a missing required variant with 400 MENU_ITEM_VARIANT_REQUIRED, and writes nothing', async () => {
    const res = await send([{ menuItemId: LATTE.id, name: 'Latte', quantity: 1, price: 0 }])
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('MENU_ITEM_VARIANT_REQUIRED')
    expect(body.unavailableItems).toEqual([{ menuItemId: LATTE.id, name: 'Latte', groups: ['Size'] }])
    expect(body.error).toMatch(/Latte.*Size/)
    expect(insertedOrder).toBeNull()
  })

  it('refuses an invalid option with 400 MENU_ITEM_UNPRICEABLE_SELECTION', async () => {
    const res = await send([{ menuItemId: LATTE.id, quantity: 1, selectedVariants: { Size: 'Medium' } }])
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('MENU_ITEM_UNPRICEABLE_SELECTION')
  })

  it('refuses an unknown group with 400 MENU_ITEM_UNPRICEABLE_SELECTION', async () => {
    const res = await send([
      { menuItemId: LATTE.id, quantity: 1, selectedVariants: { Size: 'Large', Syrup: 'Vanilla' } },
    ])
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('MENU_ITEM_UNPRICEABLE_SELECTION')
    expect(body.unavailableItems[0].groups).toEqual(['Syrup'])
  })

  it('an unknown menu item is a 400 too, never a 500', async () => {
    const res = await send([{ menuItemId: '99999999-9999-4999-8999-999999999999', name: 'Ghost', quantity: 1 }])
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('MENU_ITEM_NOT_FOUND')
  })

  it('prices a variant server-side and persists it with its name; the order total is the variant price', async () => {
    const res = await send([
      { menuItemId: LATTE.id, name: 'Latte', quantity: 2, selectedVariants: { Size: 'Large' }, price: 1 },
    ])
    expect(res.status).toBe(200)
    const items = insertedOrder!.items as Array<Record<string, unknown>>
    expect(items[0].unitPrice).toBe(40)
    expect(items[0].name).toBe('Latte - Large')
    expect(items[0].selectedVariants).toEqual({ Size: 'Large' })
    // orders.total is what prepare-payment charges (it re-reads it; the device never sets it).
    expect(insertedOrder!.total).toBe(80)
  })
})

it('Add a Round: the station line name_snapshot carries the variant', async () => {
  const res = await postRound(
    roundReq([{ menuItemId: LATTE.id, name: 'Latte', quantity: 1, selectedVariants: { Size: 'Small' } }]),
  )
  expect(res.status).toBe(200)
  expect(insertedOrder!.total).toBe(30)
  expect(insertedLines).toHaveLength(1)
  expect(insertedLines[0].name_snapshot).toBe('Latte - Small')
})
