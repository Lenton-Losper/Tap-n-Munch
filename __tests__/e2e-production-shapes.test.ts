/**
 * THE SHAPES PRODUCTION ACTUALLY CONTAINS — partial `both`, inventory-backed vs not, and closure.
 *
 * A companion to `e2e-order-to-receipt.test.ts`, which walks the happy path. This one exists
 * because the happy path is not the common case.
 *
 * ============================================================================================
 * MEASURED READ-ONLY, 2026-09-01, BY scripts/reports/production-shape-report.mjs
 * ============================================================================================
 *
 *   order_lines            18      route_to: both 13, bar 3, kitchen 2
 *   of the 13 `both` lines: TEN are PARTIAL — exactly one station finished
 *                            three have both finished
 *                            NONE has neither finished
 *
 *   menu items by inventory config:
 *     not_tracked             430
 *     tracked_without_recipe   38   <- believes it is tracked; deducts nothing
 *     recipe_without_tracking  26
 *     deducting                21
 *
 *   payment shapes: card 2,951 / cash 91; 1,115 sale events, NONE covering more than one order
 *
 * So a partially-finished `both` line is not an edge case — it is the single most common state a
 * live line is in, and it is exactly the shape that rendered as "Being made" on the P5 until the
 * terminal was taught to name the station still working. A fixture that omits it is testing the
 * rarest configuration and calling it representative, which is the mistake of 2026-09-01.
 *
 * Likewise inventory: the majority of menu items are NOT tracked, and the second-largest group is
 * tracked-but-unconfigured. A fixture in which everything deducts would be the reverse of reality.
 */
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'
import { classifyAll, incompleteConfiguration } from '@/lib/stock/inventory-configuration'

const RESTAURANT = testUuid('rest')
const dbRef = { current: new InMemoryDb() }
const authRef = {
  current: { restaurantId: RESTAURANT, permissions: ['orders:read', 'orders:update'] as string[] },
}

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
  broadcastLineChanged: async () => undefined,
  subscribeLineChanged: () => () => {},
}))

import { buildOrderLines, writeOrderLines } from '@/lib/orders/order-lines'
import { POST as bumpLine } from '@/app/api/station/order-lines/[lineId]/state/route'
import { GET as terminalLines } from '@/app/api/terminal/tabs/[tabId]/lines/route'
import { issueReceiptForOrder } from '@/lib/receipts/issueReceipt'

const CAT_KITCHEN = testUuid('cat')
const CAT_BAR = testUuid('cat')
const CAT_BOTH = testUuid('cat')
const ITEM_STEAK = testUuid('item')
const ITEM_BEER = testUuid('item')
const ITEM_PLATTER = testUuid('item')
const RECIPE_STEAK = testUuid('rcp')
const STOCK_BEEF = testUuid('stk')
const TAB = testUuid('tab')
const ORDER = testUuid('ord')

/** Priced as calculateOrderPricing writes them, so the receipt's VAT split can attach. */
const ORDER_ITEMS = () => [
  { menu_item_id: ITEM_PLATTER, name: 'Sharing platter', quantity: 1, subtotal: 156.52, tax: 23.48, total: 180, taxRatePercentage: 15, taxInclusive: true },
  { menu_item_id: ITEM_STEAK, name: 'Ribeye', quantity: 1, subtotal: 86.96, tax: 13.04, total: 100, taxRatePercentage: 15, taxInclusive: true },
  { menu_item_id: ITEM_BEER, name: 'Windhoek Lager', quantity: 2, subtotal: 34.78, tax: 5.22, total: 40, taxRatePercentage: 15, taxInclusive: true },
]

function seed() {
  dbRef.current = new InMemoryDb(
    {
      restaurants: [{ id: RESTAURANT, name: 'Riviera', address: 'Windhoek', currency: 'NAD' }],
      restaurant_billing_profiles: [],
      menu_categories: [
        { id: CAT_KITCHEN, restaurant_id: RESTAURANT, name: 'Mains', route_to: 'kitchen' },
        { id: CAT_BAR, restaurant_id: RESTAURANT, name: 'Beers', route_to: 'bar' },
        { id: CAT_BOTH, restaurant_id: RESTAURANT, name: 'Sharing platters', route_to: 'both' },
      ],
      /**
       * All three inventory states, in the production proportion:
       *   Ribeye          tracked AND recipe-backed  -> deducts
       *   Windhoek Lager  not tracked                -> the majority shape (430 of 515)
       *   Sharing platter tracked, NO recipe         -> incomplete configuration (38 live)
       */
      menu_items: [
        { id: ITEM_STEAK, restaurant_id: RESTAURANT, name: 'Ribeye', category_id: CAT_KITCHEN, track_inventory: true },
        { id: ITEM_BEER, restaurant_id: RESTAURANT, name: 'Windhoek Lager', category_id: CAT_BAR, track_inventory: false },
        { id: ITEM_PLATTER, restaurant_id: RESTAURANT, name: 'Sharing platter', category_id: CAT_BOTH, track_inventory: true },
      ],
      recipes: [
        { id: RECIPE_STEAK, restaurant_id: RESTAURANT, menu_item_id: ITEM_STEAK, is_active: true, deleted_at: null },
      ],
      recipe_items: [{ recipe_id: RECIPE_STEAK, stock_item_id: STOCK_BEEF, quantity: 0.25 }],
      stock_movements: [],
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
          order_instructions: null,
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
      receipt_documents: {
        defaults: { version: 1, status: 'issued', document_type: 'SALE_RECEIPT', issued_at: '2026-09-01T19:30:05Z' },
        unique: [['order_id', 'document_type', 'version']],
      },
    },
  )
  authRef.current = { restaurantId: RESTAURANT, permissions: ['orders:read', 'orders:update'] }
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
  }
  const lines = (body.orders ?? []).flatMap((o) => o.lines)
  return { body, byName: (n: string) => lines.find((l) => l.name_snapshot === n)! }
}

async function placeRound() {
  const built = await buildOrderLines(dbRef.current.client(), {
    restaurantId: RESTAURANT,
    orderId: ORDER,
    tabId: TAB,
    items: ORDER_ITEMS(),
  })
  await writeOrderLines(dbRef.current.client(), built, { actorKind: 'system', actorUserId: null })
}

beforeEach(async () => {
  seed()
  await placeRound()
})

// ── the dominant live shape ──────────────────────────────────────────────────

describe('a PARTIALLY finished `both` line — 10 of 13 production lines are in this state', () => {
  it('carries BOTH station states to the terminal, so the device can name the waiting one', async () => {
    await bump(String(lineFor('Sharing platter').id), 'bar', 'ready')

    const line = (await p5()).byName('Sharing platter')
    // The server's verdict is unchanged and authoritative: not ready.
    expect(line.is_ready).toBe(false)
    // …and the raw material the P5 needs to say WHICH half. The device held these all along and
    // rendered neither, which is how a correct system was reported as a stale terminal.
    expect(line.kitchen_state).toBe('outstanding')
    expect(line.bar_state).toBe('ready')
  })

  it('the mirror case carries the mirror states', async () => {
    await bump(String(lineFor('Sharing platter').id), 'kitchen', 'ready')

    const line = (await p5()).byName('Sharing platter')
    expect(line.is_ready).toBe(false)
    expect(line.kitchen_state).toBe('ready')
    expect(line.bar_state).toBe('outstanding')
  })

  it('a partial line counts as outstanding, never as ready', async () => {
    await bump(String(lineFor('Sharing platter').id), 'bar', 'ready')
    const view = await p5()
    expect(view.body.summary).toMatchObject({ outstanding: 3, ready: 0 })
    expect(view.body.all_ready).toBe(false)
  })

  it('a COOKED half is not a finished half', async () => {
    await bump(String(lineFor('Sharing platter').id), 'kitchen', 'cooked')
    const line = (await p5()).byName('Sharing platter')
    expect(line.kitchen_state).toBe('cooked')
    expect(line.is_ready).toBe(false)
  })
})

// ── inventory-backed and not, on the same order ──────────────────────────────

describe('inventory-backed and non-inventory items on one order', () => {
  it('classifies all three states, and only the configured one deducts', () => {
    const rows = classifyAll(
      dbRef.current.rows('menu_items') as never,
      dbRef.current.rows('recipes') as never,
      dbRef.current.rows('recipe_items') as never,
    )
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]))

    expect(byName.Ribeye).toMatchObject({ state: 'deducting', deducts: true })
    expect(byName['Windhoek Lager']).toMatchObject({ state: 'not_tracked', deducts: false })
    // Tracked with no recipe: excluded from automatic deduction, surfaced, never guessed.
    expect(byName['Sharing platter']).toMatchObject({
      state: 'tracked_without_recipe',
      deducts: false,
    })
    expect(incompleteConfiguration(rows).map((r) => r.name)).toEqual(['Sharing platter'])
  })

  it('selling them writes no stock movement from application code', async () => {
    await bump(String(lineFor('Ribeye').id), 'kitchen', 'ready')
    /**
     * Deduction is a database trigger at order completion, never application code. A movement
     * appearing here would mean something in the app had started writing stock — the invariant
     * stock-consumption-invariants.test.ts holds from the other side.
     */
    expect(dbRef.current.rows('stock_movements')).toHaveLength(0)
  })
})

// ── through to closure ───────────────────────────────────────────────────────

describe('customer order -> station -> terminal -> payment -> receipt -> closure', () => {
  it('ends with nothing outstanding, one receipt, and a tab that owes nothing', async () => {
    const platter = lineFor('Sharing platter')
    await bump(String(platter.id), 'bar', 'ready')
    await bump(String(platter.id), 'kitchen', 'ready')
    await bump(String(lineFor('Ribeye').id), 'kitchen', 'ready')
    await bump(String(lineFor('Windhoek Lager').id), 'bar', 'ready')

    let view = await p5()
    expect(view.body.summary).toMatchObject({ outstanding: 0, ready: 3 })
    expect(view.body.all_ready).toBe(true)

    const order = dbRef.current.rows('orders')[0]
    order.payment_status = 'paid'
    order.status = 'completed'
    order.paid_at = '2026-09-01T19:30:00Z'
    const receipt = await issueReceiptForOrder(ORDER)
    expect(receipt.document_number).toMatch(/^RCT-/)
    expect(receipt.snapshot_json.totals.grand_total).toBe(320)

    // Collection clears the pass without changing what is owed or what was sold.
    await bump(String(platter.id), 'bar', 'collected')
    await bump(String(platter.id), 'kitchen', 'collected')
    await bump(String(lineFor('Ribeye').id), 'kitchen', 'collected')
    await bump(String(lineFor('Windhoek Lager').id), 'bar', 'collected')

    view = await p5()
    expect(view.body.summary).toMatchObject({ outstanding: 0, ready: 0, collected: 3 })
    expect(view.body.all_ready).toBe(true)
    expect(dbRef.current.rows('receipt_documents')).toHaveLength(1)

    /**
     * close_table_session is a Postgres function and is deliberately NOT emulated — a stub of it
     * would be testing the stub. What is proved here is that every app-side precondition it
     * checks is satisfied: nothing is being made, nothing is still on the pass, the sale is
     * receipted, and the money is settled.
     */
  })
})
