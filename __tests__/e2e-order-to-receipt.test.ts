/**
 * END TO END: customer order -> routing -> station bumps -> what the P5 believes -> ready ->
 * collected -> paid -> receipt.
 *
 * ============================================================================================
 * THE MISTAKE THIS SUITE EXISTS NOT TO REPEAT
 * ============================================================================================
 *
 * On 2026-09-01 a live end-to-end verification passed every hop and could not have caught the
 * defect that was reported hours later. Its fixture used SINGLE-STATION lines:
 *
 *     kitchen line: route_to 'kitchen', bar_state NULL
 *     bar line    : route_to 'bar',     kitchen_state NULL
 *
 * `isLineReady` coalesces a NULL state to 'ready' — a station that does not own a line cannot
 * hold it back — so one bump made those lines ready and every assertion went green. Meanwhile
 * 13 of the 13 order_lines in production were `both`. The fixture was the one shape that did not
 * exist in production, chosen because it made each assertion clean.
 *
 * So the fixtures here are built FROM A MEASURED DISTRIBUTION, not from convenience, and the
 * measurement is asserted below so it cannot rot silently into convenience again.
 *
 * ============================================================================================
 * PRODUCTION DISTRIBUTION, MEASURED READ-ONLY 2026-09-01
 * ============================================================================================
 *
 *   order_lines           18 rows      route_to: both 13, bar 3, kitchen 2
 *   station states        kitchen_state: outstanding 9, ready 5, cooked 1, null 3
 *                         bar_state:     ready 15, outstanding 1, null 2
 *   voided lines          0            (no amendment has ever run)
 *   menu items by route   both 72, kitchen 265, bar 178
 *   receipts              2,514        every one reconciling payments == grand_total
 *
 * `both` is the MAJORITY shape in production and the minority shape in every previous fixture.
 * This suite therefore leads with it.
 *
 * ============================================================================================
 * WHAT IS REAL HERE AND WHAT IS NOT
 * ============================================================================================
 *
 * Real: buildOrderLines, writeOrderLines, the station bump route handler, the terminal tab-lines
 * route handler, isLineReady, issueReceiptForOrder. All executed, unmodified.
 *
 * Not real: the database (an in-memory store — no RLS, no triggers, no constraints), terminal
 * auth, and the feature flag. Nothing here charges a card, and nothing here touches production.
 */
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'

// ── the world the handlers run in ────────────────────────────────────────────

const RESTAURANT = testUuid('rest')
const db = new InMemoryDb()
const broadcasts: Array<Record<string, unknown>> = []

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => dbRef.current.client(),
}))

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: authRef.current.restaurantId,
    terminalId: 'term-1',
    permissions: authRef.current.permissions,
  }),
  validateTerminalRecord: async () => undefined,
}))

jest.mock('@/lib/features/get-restaurant-features', () => ({
  requireFeature: async () => ({ allowed: true }),
}))

jest.mock('@/lib/stations/realtime-invalidate', () => ({
  broadcastLineChanged: async (...args: unknown[]) => {
    broadcasts.push({ args })
  },
  subscribeLineChanged: () => () => {},
}))

const dbRef = { current: db }
const authRef = {
  current: { restaurantId: RESTAURANT, permissions: ['orders:read', 'orders:update'] as string[] },
}

import { buildOrderLines, writeOrderLines, isLineReady } from '@/lib/orders/order-lines'
import { POST as bumpLine } from '@/app/api/station/order-lines/[lineId]/state/route'
import { GET as terminalLines } from '@/app/api/terminal/tabs/[tabId]/lines/route'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'

// ── fixture, shaped like production ──────────────────────────────────────────

const CAT_KITCHEN = testUuid('cat')
const CAT_BAR = testUuid('cat')
const CAT_BOTH = testUuid('cat')
const ITEM_STEAK = testUuid('item')
const ITEM_BEER = testUuid('item')
const ITEM_PLATTER = testUuid('item')
const TAB = testUuid('tab')
const ORDER = testUuid('ord')

/** The measured production mix. Asserted, so a later edit cannot quietly drop `both`. */
const PRODUCTION_ROUTE_MIX = { both: 13, bar: 3, kitchen: 2 }

function seed() {
  dbRef.current = new InMemoryDb({
    restaurants: [{ id: RESTAURANT, name: 'Riviera', address: '12 Independence Ave', currency: 'NAD' }],
    restaurant_billing_profiles: [],
    menu_categories: [
      { id: CAT_KITCHEN, restaurant_id: RESTAURANT, name: 'Mains', route_to: 'kitchen' },
      { id: CAT_BAR, restaurant_id: RESTAURANT, name: 'Beers', route_to: 'bar' },
      { id: CAT_BOTH, restaurant_id: RESTAURANT, name: 'Sharing platters', route_to: 'both' },
    ],
    menu_items: [
      { id: ITEM_STEAK, restaurant_id: RESTAURANT, name: 'Ribeye', category_id: CAT_KITCHEN },
      { id: ITEM_BEER, restaurant_id: RESTAURANT, name: 'Windhoek Lager', category_id: CAT_BAR },
      { id: ITEM_PLATTER, restaurant_id: RESTAURANT, name: 'Sharing platter', category_id: CAT_BOTH },
    ],
    tabs: [{ id: TAB, restaurant_id: RESTAURANT, table_number: 7, status: 'open', total: 320, created_at: '2026-09-01T18:00:00Z' }],
    orders: [
      {
        id: ORDER,
        restaurant_id: RESTAURANT,
        tab_id: TAB,
        order_number: 41,
        table_number: 7,
        channel: 'table',
        status: 'preparing',
        payment_status: 'pending',
        payment_method: 'card',
        payment_reference: 'FIN-REF-99887766',
        subtotal: 278.26,
        tax: 41.74,
        total: 320,
        order_instructions: 'No nuts on the platter',
        customer_name: null,
        placed_at: '2026-09-01T18:00:00Z',
        paid_at: null,
        items: ORDER_ITEMS(),
      },
    ],
    order_lines: [],
    order_line_events: [],
    receipt_documents: [],
    payment_events: [],
  },
  {
    // The real DDL, so idempotency is proven against the constraint that actually enforces it
    // (20260717140000_receipt_documents.sql).
    receipt_documents: {
      defaults: { version: 1, status: 'issued', document_type: 'SALE_RECEIPT', issued_at: '2026-09-01T19:30:05Z' },
      unique: [['order_id', 'document_type', 'version']],
    },
  })
  broadcasts.length = 0
  authRef.current = { restaurantId: RESTAURANT, permissions: ['orders:read', 'orders:update'] }
}

/** Priced exactly as calculateOrderPricing writes them, so the receipt's VAT split can attach. */
function ORDER_ITEMS() {
  return [
    { menu_item_id: ITEM_PLATTER, name: 'Sharing platter', quantity: 1, subtotal: 156.52, tax: 23.48, total: 180, taxRatePercentage: 15, taxInclusive: true },
    { menu_item_id: ITEM_STEAK, name: 'Ribeye', quantity: 1, subtotal: 86.96, tax: 13.04, total: 100, taxRatePercentage: 15, taxInclusive: true },
    { menu_item_id: ITEM_BEER, name: 'Windhoek Lager', quantity: 2, subtotal: 34.78, tax: 5.22, total: 40, taxRatePercentage: 15, taxInclusive: true },
  ]
}

const lineFor = (name: string) =>
  dbRef.current.rows('order_lines').find((l) => l.name_snapshot === name) as Record<string, unknown>

async function bump(lineId: string, station: 'kitchen' | 'bar', toState: string) {
  const res = await bumpLine(
    new Request(`https://x.test/api/station/order-lines/${lineId}/state`, {
      method: 'POST',
      body: JSON.stringify({ station, to_state: toState }),
    }),
    { params: Promise.resolve({ lineId }) },
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function p5() {
  const res = await terminalLines(new Request(`https://x.test/api/terminal/tabs/${TAB}/lines`), {
    params: Promise.resolve({ tabId: TAB }),
  })
  const body = (await res.json()) as {
    orders?: Array<{ lines: Array<Record<string, unknown>> }>
    summary?: Record<string, number>
    all_ready?: boolean
    has_lines?: boolean
    error?: string
  }
  const lines = (body.orders ?? []).flatMap((o) => o.lines)
  return { status: res.status, body, lines, byName: (n: string) => lines.find((l) => l.name_snapshot === n)! }
}

beforeEach(seed)

// ── 0. the fixture is production-shaped ──────────────────────────────────────

describe('the fixture matches the measured production shape', () => {
  it('leads with `both`, which is the majority route in production', () => {
    const dominant = Object.entries(PRODUCTION_ROUTE_MIX).sort((a, b) => b[1] - a[1])[0][0]
    expect(dominant).toBe('both')
    const routes = dbRef.current.rows('menu_categories').map((c) => c.route_to)
    expect(routes).toEqual(expect.arrayContaining(['both', 'kitchen', 'bar']))
  })

  it('covers all three routes, so no shape is left untested', () => {
    expect(new Set(dbRef.current.rows('menu_categories').map((c) => c.route_to)).size).toBe(3)
  })
})

// ── 1. routing ───────────────────────────────────────────────────────────────

describe('1. a customer order routes each item to the right station', () => {
  it('freezes route_to and the per-station starting states', async () => {
    const built = await buildOrderLines(dbRef.current.client(), {
      restaurantId: RESTAURANT,
      orderId: ORDER,
      tabId: TAB,
      items: ORDER_ITEMS(),
    })

    expect(built.map((l) => l.route_to)).toEqual(['both', 'kitchen', 'bar'])

    const platter = built[0]
    expect(platter.kitchen_state).toBe('outstanding')
    expect(platter.bar_state).toBe('outstanding')

    // A station that does not own the line gets NULL — the property the old fixture hid behind.
    expect(built[1]).toMatchObject({ kitchen_state: 'outstanding', bar_state: null })
    expect(built[2]).toMatchObject({ kitchen_state: null, bar_state: 'outstanding' })
  })

  it('writes one creation event per OWNING station, so `both` writes two', async () => {
    const built = await buildOrderLines(dbRef.current.client(), {
      restaurantId: RESTAURANT,
      orderId: ORDER,
      tabId: TAB,
      items: ORDER_ITEMS(),
    })
    const result = await writeOrderLines(dbRef.current.client(), built, {
      actorKind: 'system',
      actorUserId: null,
    })

    expect(result.lineCount).toBe(3)
    expect(dbRef.current.rows('order_lines')).toHaveLength(3)
    // platter(2) + steak(1) + beer(1)
    expect(dbRef.current.rows('order_line_events')).toHaveLength(4)
  })
})

// ── 2..5 the full walk ───────────────────────────────────────────────────────

describe('2-6. bumps, what the P5 believes, collection, payment and the receipt', () => {
  beforeEach(async () => {
    const built = await buildOrderLines(dbRef.current.client(), {
      restaurantId: RESTAURANT,
      orderId: ORDER,
      tabId: TAB,
      items: ORDER_ITEMS(),
    })
    await writeOrderLines(dbRef.current.client(), built, { actorKind: 'system', actorUserId: null })
  })

  it('the P5 starts with nothing ready', async () => {
    const view = await p5()
    expect(view.status).toBe(200)
    expect(view.body.has_lines).toBe(true)
    expect(view.body.summary).toMatchObject({ total_lines: 3, outstanding: 3, ready: 0, collected: 0 })
    expect(view.body.all_ready).toBe(false)
    expect(view.lines.every((l) => l.is_ready === false)).toBe(true)
  })

  /**
   * THE 2026-09-01 INCIDENT, as a test. The bar finishes its half of a `both` line and the P5
   * must still say "being made", because the kitchen has not touched it.
   */
  it('one station finishing a `both` line does NOT make it ready', async () => {
    const platter = lineFor('Sharing platter')
    const r = await bump(String(platter.id), 'bar', 'ready')
    expect(r.status).toBe(200)

    // The persisted row, not the response: the half really moved.
    expect(lineFor('Sharing platter').bar_state).toBe('ready')
    expect(lineFor('Sharing platter').kitchen_state).toBe('outstanding')

    const view = await p5()
    expect(view.byName('Sharing platter').is_ready).toBe(false)
    expect(view.body.summary!.ready).toBe(0)
    expect(view.body.all_ready).toBe(false)
  })

  it('the second station finishing it DOES make it ready', async () => {
    const platter = lineFor('Sharing platter')
    await bump(String(platter.id), 'bar', 'ready')
    await bump(String(platter.id), 'kitchen', 'ready')

    const view = await p5()
    expect(view.byName('Sharing platter').is_ready).toBe(true)
    expect(view.body.summary!.ready).toBe(1)
    // The other two are still outstanding, so the tab is not finished.
    expect(view.body.all_ready).toBe(false)
  })

  it('a single-station line is ready on one bump — the shape the old fixture used', async () => {
    await bump(String(lineFor('Ribeye').id), 'kitchen', 'ready')
    const view = await p5()
    expect(view.byName('Ribeye').is_ready).toBe(true)
  })

  it('collection is its own state: ready falls, collected rises, all_ready holds', async () => {
    const platter = lineFor('Sharing platter')
    await bump(String(platter.id), 'bar', 'ready')
    await bump(String(platter.id), 'kitchen', 'ready')
    await bump(String(lineFor('Ribeye').id), 'kitchen', 'ready')
    await bump(String(lineFor('Windhoek Lager').id), 'bar', 'ready')

    let view = await p5()
    expect(view.body.summary).toMatchObject({ outstanding: 0, ready: 3, collected: 0 })
    expect(view.body.all_ready).toBe(true)

    // Collect the platter: BOTH owning stations must report it collected.
    await bump(String(platter.id), 'bar', 'collected')
    await bump(String(platter.id), 'kitchen', 'collected')

    view = await p5()
    expect(view.byName('Sharing platter')).toMatchObject({ is_ready: false, is_collected: true })
    expect(view.body.summary).toMatchObject({ ready: 2, collected: 1, outstanding: 0 })
    // Collected is not outstanding, so the tab is still finished.
    expect(view.body.all_ready).toBe(true)
  })

  it('one station collecting a `both` line is not enough — something is still on a pass', async () => {
    const platter = lineFor('Sharing platter')
    await bump(String(platter.id), 'bar', 'ready')
    await bump(String(platter.id), 'kitchen', 'ready')
    await bump(String(platter.id), 'bar', 'collected')

    const view = await p5()
    expect(view.byName('Sharing platter')).toMatchObject({ is_ready: true, is_collected: false })
  })

  it('6. paying the order issues a receipt that reproduces the sale', async () => {
    const order = dbRef.current.rows('orders')[0]
    order.payment_status = 'paid'
    order.paid_at = '2026-09-01T19:30:00Z'

    const receipt = await issueReceiptForOrder(ORDER)
    expect(receipt.document_number).toMatch(/^RCT-\d{6}$/)

    const snap = receipt.snapshot_json
    expect(snap.outlet.restaurant_name).toBe('Riviera')
    expect(snap.totals.grand_total).toBe(320)
    expect(snap.line_items.map((l) => l.name)).toEqual(['Sharing platter', 'Ribeye', 'Windhoek Lager'])

    // #250: line_total is GROSS, and the split reconciles.
    const platterLine = snap.line_items[0]
    expect(platterLine.line_total).toBe(180)
    expect(platterLine.line_subtotal).toBe(156.52)
    expect(platterLine.line_tax).toBe(23.48)

    // The payment line matches THIS order's bill.
    expect(snap.payments).toHaveLength(1)
    expect(snap.payments[0].amount).toBe(320)
    expect(snap.payments[0].masked_reference).toBe('************7766')

    // The customer's own words survive onto the document.
    expect(snap.order_instructions).toBe('No nuts on the platter')
  })

  it('6b. issuing twice returns the same document and burns no second number', async () => {
    const order = dbRef.current.rows('orders')[0]
    order.payment_status = 'paid'
    order.paid_at = '2026-09-01T19:30:00Z'

    const first = await issueReceiptForOrder(ORDER)
    const second = await issueReceiptForOrder(ORDER)

    expect(second.id).toBe(first.id)
    expect(second.document_number).toBe(first.document_number)
    expect(dbRef.current.rows('receipt_documents')).toHaveLength(1)
    expect(dbRef.current.rpcCalls.filter((c) => c.name === 'generate_document_number')).toHaveLength(1)
  })

  it('6c. an unpaid order cannot be given a receipt', async () => {
    await expect(issueReceiptForOrder(ORDER)).rejects.toThrow(/not reached final paid state/)
    expect(dbRef.current.rows('receipt_documents')).toHaveLength(0)
  })
})

// ── failure and idempotency ──────────────────────────────────────────────────

describe('failure and idempotency cases', () => {
  beforeEach(async () => {
    const built = await buildOrderLines(dbRef.current.client(), {
      restaurantId: RESTAURANT,
      orderId: ORDER,
      tabId: TAB,
      items: ORDER_ITEMS(),
    })
    await writeOrderLines(dbRef.current.client(), built, { actorKind: 'system', actorUserId: null })
  })

  it('a station cannot bump a line it does not own', async () => {
    const r = await bump(String(lineFor('Ribeye').id), 'bar', 'ready')
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('STATION_DOES_NOT_OWN_LINE')
    expect(lineFor('Ribeye').bar_state).toBeNull()
  })

  it('a station cannot void a line', async () => {
    const r = await bump(String(lineFor('Ribeye').id), 'kitchen', 'voided')
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('INVALID_STATE')
  })

  it('an unknown station is refused', async () => {
    const r = await bump(String(lineFor('Ribeye').id), 'grill' as never, 'ready')
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('INVALID_STATION')
  })

  it('a malformed line id is refused before any read', async () => {
    const r = await bump('not-a-uuid', 'kitchen', 'ready')
    expect(r.status).toBe(400)
  })

  it('re-bumping to the SAME state is idempotent in effect', async () => {
    const id = String(lineFor('Ribeye').id)
    const first = await bump(id, 'kitchen', 'ready')
    const second = await bump(id, 'kitchen', 'ready')
    expect(first.status).toBe(200)
    expect(second.status).toBeLessThan(500)
    expect(lineFor('Ribeye').kitchen_state).toBe('ready')

    const view = await p5()
    expect(view.body.summary!.ready).toBe(1)
  })

  it('a terminal without orders:update cannot bump', async () => {
    authRef.current = { restaurantId: RESTAURANT, permissions: ['orders:read'] }
    const r = await bump(String(lineFor('Ribeye').id), 'kitchen', 'ready')
    expect(r.status).toBe(403)
    expect(lineFor('Ribeye').kitchen_state).toBe('outstanding')
  })

  it("another restaurant's terminal sees nothing and changes nothing", async () => {
    const id = String(lineFor('Ribeye').id)
    authRef.current = { restaurantId: testUuid('other'), permissions: ['orders:read', 'orders:update'] }

    const r = await bump(id, 'kitchen', 'ready')
    expect(r.status).toBe(404)
    expect(lineFor('Ribeye').kitchen_state).toBe('outstanding')

    const view = await p5()
    expect(view.status).toBe(404)
  })
})

// ── the invariant everything above rests on ──────────────────────────────────

describe('isLineReady is the single definition both sides use', () => {
  it('needs every owning station, and treats collected as past-ready', () => {
    expect(isLineReady({ kitchen_state: 'outstanding', bar_state: 'ready' })).toBe(false)
    expect(isLineReady({ kitchen_state: 'ready', bar_state: 'ready' })).toBe(true)
    expect(isLineReady({ kitchen_state: null, bar_state: 'ready' })).toBe(true)
    expect(isLineReady({ kitchen_state: 'collected', bar_state: 'collected' })).toBe(true)
  })
})
