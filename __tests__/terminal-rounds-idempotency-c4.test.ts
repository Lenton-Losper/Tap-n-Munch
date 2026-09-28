/**
 * CONTRACT C4 -- a reused idempotency key is a replay only when the body is the same.
 *
 * Riviera #160: the terminal kept one key through a basket edit after a failed Send. The re-send
 * (item removed) got the ORIGINAL round back as a success, and the kitchen made the removed item.
 * These tests pin the three answers -- first send: created; identical replay: duplicate; edited
 * replay: 409 with what the server has -- on both terminal order-creating routes, and the race
 * where the first send lands between the route's pre-check and its insert.
 */
import { POST as roundsPOST } from '@/app/api/terminal/rounds/route'
import { POST as ordersPOST } from '@/app/api/terminal/orders/route'
import { roundItemFingerprint, sameRoundItems } from '@/lib/orders/round-idempotency'

const RESTAURANT = '99999999-9999-4999-8999-999999999999'
const TAB = '11111111-1111-4111-8111-111111111111'
const OTHER_TAB = '12121212-1212-4121-8121-121212121212'
const PASTA = 'aaaaaaaa-0000-4000-8000-000000000001'
const BEER = 'aaaaaaaa-0000-4000-8000-000000000002'
const KEY = 'key-160'

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    terminalId: 'term-1',
    restaurantId: '99999999-9999-4999-8999-999999999999',
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
  enrichOrderItemsWithRouteTo: async (_s: unknown, items: unknown[]) =>
    items.map((i) => ({ ...(i as object), route_to: 'kitchen' })),
}))
jest.mock('@/lib/orders/check-stock-sufficiency', () => ({
  checkStockSufficiency: async () => ({ ok: true }),
}))
jest.mock('@/lib/stations/realtime-invalidate', () => ({ broadcastLineChanged: async () => undefined }))

const writeCalls: unknown[] = []
jest.mock('@/lib/orders/order-lines', () => {
  const actual = jest.requireActual('@/lib/orders/order-lines')
  return {
    ...actual,
    buildOrderLines: async (_s: unknown, args: { items: unknown[] }) =>
      args.items.map((_i, index) => ({ source_item_index: index, route_to: 'kitchen' })),
    writeOrderLines: async (_s: unknown, lines: unknown[]) => {
      writeCalls.push(lines)
      return { lineCount: lines.length, stationCounts: { kitchen: lines.length, bar: 0, unrouted: 0 } }
    },
  }
})

type Stored = { id: string; order_number: number; tab_id: string | null; items: unknown[] }
/** Successive answers to the route's lookups of the order holding KEY (null = none yet). */
let keyLookups: Array<Stored | null> = []
let storedById: Record<string, Stored> = {}
let existingLines: unknown[] = []
let createResult: { orderId: string; orderNumber: number; duplicate: boolean } = {
  orderId: 'new-order', orderNumber: 170, duplicate: false,
}
const createCalls: unknown[] = []

jest.mock('@/lib/orders/create-order', () => ({
  createOrder: async (params: unknown) => {
    createCalls.push(params)
    return { ...createResult, restaurantId: 'r', paymentStatus: 'pending' }
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    from: (table: string) => {
      let columns = ''
      const eqs: Record<string, unknown> = {}
      const builder: Record<string, unknown> = {
        select: (c: string) => ((columns = c), builder),
        eq: (col: string, v: unknown) => ((eqs[col] = v), builder),
        maybeSingle: async () => {
          if (table === 'tabs') {
            return {
              data: { id: eqs.id, restaurant_id: RESTAURANT, table_id: 't1', table_number: 1, status: 'open', opened_by_user_id: null },
              error: null,
            }
          }
          if (table === 'orders' && 'idempotency_key' in eqs) {
            return { data: keyLookups.length ? keyLookups.shift() : null, error: null }
          }
          if (table === 'orders') {
            return { data: storedById[String(eqs.id)] ?? { id: eqs.id, items: [] }, error: null }
          }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: table === 'order_lines' ? existingLines : [], error: null }),
      }
      void columns
      return builder
    },
  }),
}))

const pasta = (extra: Record<string, unknown> = {}) => ({ menuItemId: PASTA, name: 'Modena Pasta', quantity: 1, ...extra })
const beer = (extra: Record<string, unknown> = {}) => ({ menuItemId: BEER, name: 'Lager', quantity: 2, ...extra })

/** What createOrder persists: the request item, spread, plus pricing and routing fields. */
const persisted = (item: Record<string, unknown>) => ({
  ...item, unitPrice: 120, subtotal: 104.35, tax: 15.65, total: 120, priceSource: 'catalog', route_to: 'kitchen',
})

const ORIGINAL: Stored = {
  id: 'order-160', order_number: 160, tab_id: TAB,
  items: [persisted(pasta({ note: 'no parmesan' })), persisted(beer())],
}

function round(items: unknown[], tabId = TAB) {
  return roundsPOST(
    new Request('https://example.test/api/terminal/rounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': KEY },
      body: JSON.stringify({ tab_id: tabId, items }),
    }),
  )
}

function posOrder(items: unknown[]) {
  return ordersPOST(
    new Request('https://example.test/api/terminal/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': KEY },
      body: JSON.stringify({ restaurantId: RESTAURANT, items, subtotal: 1, total: 1 }),
    }),
  )
}

beforeEach(() => {
  keyLookups = []
  storedById = { 'order-160': ORIGINAL }
  existingLines = []
  createResult = { orderId: 'new-order', orderNumber: 170, duplicate: false }
  createCalls.length = 0
  writeCalls.length = 0
})

describe('POST /api/terminal/rounds', () => {
  it('first send: created, lines written, duplicate false', async () => {
    const res = await round([pasta(), beer()])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, duplicate: false, order_id: 'new-order' })
    expect(createCalls).toHaveLength(1)
    expect(writeCalls).toHaveLength(1)
  })

  it('identical replay (items in another order): duplicate, what is persisted, nothing written', async () => {
    keyLookups = [ORIGINAL]
    createResult = { orderId: 'order-160', orderNumber: 160, duplicate: true }
    existingLines = [
      { id: 'l1', route_to: 'kitchen', name_snapshot: 'Modena Pasta', quantity: 1, kitchen_state: 'cooked', bar_state: null },
      { id: 'l2', route_to: 'bar', name_snapshot: 'Lager', quantity: 2, kitchen_state: null, bar_state: 'outstanding' },
    ]
    const res = await round([beer(), pasta({ note: 'no parmesan' })])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, duplicate: true, order_id: 'order-160', order_number: 160 })
    expect(body.items).toEqual([
      { menuItemId: PASTA, name: 'Modena Pasta', quantity: 1, note: 'no parmesan', selectedVariants: null },
      { menuItemId: BEER, name: 'Lager', quantity: 2, note: null, selectedVariants: null },
    ])
    expect(body.lines).toHaveLength(2)
    expect(writeCalls).toHaveLength(0)
  })

  it('EDITED replay (the #160 shape: an item removed): 409 with what the server has, nothing created', async () => {
    keyLookups = [ORIGINAL]
    const res = await round([beer()])
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('IDEMPOTENCY_KEY_BODY_MISMATCH')
    expect(body.order_id).toBe('order-160')
    expect(body.order_number).toBe(160)
    // The server's truth -- the pasta is still on it -- not the device's basket.
    expect(body.items.map((i: { menuItemId: string }) => i.menuItemId)).toEqual([PASTA, BEER])
    expect(createCalls).toHaveLength(0)
    expect(writeCalls).toHaveLength(0)
  })

  it('edited quantity, note, or variant is a mismatch too', async () => {
    for (const items of [
      [pasta({ note: 'no parmesan', quantity: 2 }), beer()],
      [pasta({ note: 'extra parmesan' }), beer()],
      [pasta({ note: 'no parmesan', selectedVariants: { Size: 'Large' } }), beer()],
    ]) {
      keyLookups = [ORIGINAL]
      const res = await round(items)
      expect(res.status).toBe(409)
    }
    expect(createCalls).toHaveLength(0)
  })

  it('the same key on a different tab is a mismatch', async () => {
    keyLookups = [ORIGINAL]
    const res = await round([pasta({ note: 'no parmesan' }), beer()], OTHER_TAB)
    expect(res.status).toBe(409)
  })

  it('RACE: the first send lands after the pre-check -- caught after createOrder, no lines built from the stored items', async () => {
    keyLookups = [null, ORIGINAL]
    createResult = { orderId: 'order-160', orderNumber: 160, duplicate: true }
    existingLines = [] // the first send has not written its lines yet
    const res = await round([beer()])
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_BODY_MISMATCH')
    expect(writeCalls).toHaveLength(0)
  })

  it('RACE, identical body, lines not yet written: the replay writes them (the recovery path is kept)', async () => {
    keyLookups = [null, ORIGINAL]
    createResult = { orderId: 'order-160', orderNumber: 160, duplicate: true }
    existingLines = []
    const res = await round([pasta({ note: 'no parmesan' }), beer()])
    expect(res.status).toBe(200)
    expect(writeCalls).toHaveLength(1)
  })
})

describe('POST /api/terminal/orders (POS) -- same rule', () => {
  it('a new order is not a duplicate', async () => {
    const body = await (await posOrder([pasta()])).json()
    expect(body).toMatchObject({ success: true, orderId: 'new-order', duplicate: false })
  })

  it('identical replay: 200 duplicate true', async () => {
    createResult = { orderId: 'order-160', orderNumber: 160, duplicate: true }
    keyLookups = [ORIGINAL]
    const res = await posOrder([pasta({ note: 'no parmesan' }), beer()])
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ orderId: 'order-160', duplicate: true })
  })

  it('edited replay: 409, so the device does not charge the original total for an edited basket', async () => {
    createResult = { orderId: 'order-160', orderNumber: 160, duplicate: true }
    keyLookups = [ORIGINAL]
    const res = await posOrder([beer()])
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('IDEMPOTENCY_KEY_BODY_MISMATCH')
  })
})

describe('the fingerprint', () => {
  it('ignores item order and the fields the server adds', () => {
    expect(sameRoundItems([pasta(), beer()], [persisted(beer()), persisted(pasta())])).toBe(true)
  })

  it('treats an absent selectedVariants as an empty one, and compares variants case-insensitively', () => {
    expect(sameRoundItems([pasta()], [pasta({ selectedVariants: {} })])).toBe(true)
    expect(sameRoundItems([pasta({ selectedVariants: { size: ' large ' } })], [pasta({ selected_variants: { Size: 'Large' } })])).toBe(true)
    expect(sameRoundItems([pasta({ selectedVariants: { Size: 'Large' } })], [pasta({ selectedVariants: { Size: 'Small' } })])).toBe(false)
  })

  it('normalises quantity the way pricing does (missing or invalid is 1)', () => {
    expect(sameRoundItems([{ menuItemId: PASTA }], [pasta()])).toBe(true)
    expect(sameRoundItems([{ menuItemId: PASTA, quantity: '2' }], [pasta({ quantity: 2 })])).toBe(true)
  })

  it('counts duplicates: two separate pasta lines are not one', () => {
    expect(roundItemFingerprint([pasta(), pasta()])).toHaveLength(2)
    expect(sameRoundItems([pasta(), pasta()], [pasta()])).toBe(false)
  })
})
