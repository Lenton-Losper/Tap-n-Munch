/**
 * A VARIANT, FROM THE MENU THE TERMINAL IS SHOWN TO THE INVOICE THE CUSTOMER IS SENT -- one store,
 * every real module in between (Sprint 2026-09-29, Phase 4; contracts C5/C6).
 *
 *   GET /api/menu/{rid}/category/{cid}      resolved_variant_groups, computed by the server's own
 *                                           getVariantGroups -- what the terminal offers
 *   POST /api/terminal/orders | rounds      the terminal's request, built FROM that payload
 *   calculateOrderPricing (via createOrder) validation, authoritative price, canonical selection
 *   orders.items                            name "Latte - Large", selectedVariants, unitPrice
 *   order_lines.name_snapshot               what the kitchen/bar reads
 *   GET /api/orders/history                 what the office reads
 *   GET /api/terminal/tabs/{id}/lines       what the P5 bills from
 *   POST prepare-payment                    the card charge
 *   POST /api/terminal/tabs/{id}/settle     the payment, and the ledger row it writes
 *   POST /api/admin/documents/from-order    the invoice line, and the PDF it renders
 *
 * THE INVARIANT under every case: a client price is never authoritative. Every request below sends
 * a wrong one (`price`, `unitPrice`, `total`, the order `subtotal`/`total`) and every figure asserted
 * is the catalog's.
 *
 * The per-module suites (terminal-variant-selection-pricing, terminal-routes-variant-refusal) fake
 * everything around calculateOrderPricing; this file is the chain between them. Mutations:
 * scripts/mutate-e2e-chain.mjs (MV1-MV4).
 */
import { NextRequest } from 'next/server'
import { InMemoryDb } from './helpers/in-memory-postgrest'
import { extractPdfText } from './helpers/extract-pdf-text'

const RV = '7a7a7a7a-0000-4000-8000-000000000001'
const TABV = '7a7a7a7a-0000-4000-8000-0000000000ab'
const TABLE = '7a7a7a7a-0000-4000-8000-0000000000cd'
const CAT = '7a7a7a7a-0000-4000-8000-0000000000ca'
const VAT = '7a7a7a7a-0000-4000-8000-000000000015'
const LATTE = '7a7a7a7a-0000-4000-8000-00000000017a'
const FLAT_WHITE = '7a7a7a7a-0000-4000-8000-0000000001fb'
const WATER = '7a7a7a7a-0000-4000-8000-00000000011e'

let mockDb: InMemoryDb

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async () => ({
    restaurantId: '7a7a7a7a-0000-4000-8000-000000000001',
    terminalId: 'c103a8bd-759a-4a61-bc79-5043adae50c7',
    deviceSerial: 'TESTSN0239',
    permissions: ['orders:read', 'orders:update'],
  }),
  validateTerminalRecord: async () => undefined,
}))
jest.mock('@/lib/features/get-restaurant-features', () => ({ requireFeature: async () => ({ allowed: true }) }))
jest.mock('@/lib/stations/realtime-invalidate', () => ({ broadcastLineChanged: async () => undefined }))
jest.mock('@/lib/orders/check-stock-sufficiency', () => ({
  checkStockSufficiency: async () => ({ ok: true, unavailable: [] }),
}))
jest.mock('@/lib/cache/menu-cache', () => ({
  getCachedMenu: async () => null,
  setCachedMenu: async () => undefined,
}))
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'M', storeNo: 'S' }),
}))
jest.mock('@/lib/payments/terminal-merchant-order', () => ({
  ensureTerminalMerchantOrderNo: async () => ({ merchantOrderNo: 'MO-VAR-1', created: true }),
}))
jest.mock('@/lib/payments/payment-intents', () => ({
  ensureOrdersIntent: async () => ({ id: 'intent-var' }),
}))
jest.mock('@/lib/receipts/safeIssueReceipt', () => ({ safeIssueReceiptsForOrders: async () => undefined }))
jest.mock('@/lib/api/require-staff-permission', () => ({
  requireUrlRestaurantPermission: async () => ({ userId: 'staff-1' }),
  isAuthError: () => false,
}))
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  getUserFromRequest: async () => ({ id: 'staff-1' }),
  requireCallerRestaurantId: async (_s: unknown, _u: string, requested: string) => requested,
}))
jest.mock('@/lib/permissions/authorize', () => ({ requirePermission: async () => null }))
jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => {
    const base = mockDb.client()
    let docNumber = mockDb.rows('business_documents').length
    return {
      ...base,
      async rpc(name: string, args: unknown) {
        if (name === 'get_next_document_number') {
          docNumber += 1
          return { data: 5000 + docNumber, error: null }
        }
        return base.rpc(name, args)
      },
    }
  },
}))
jest.mock('@/lib/supabase/client', () => ({
  supabase: new Proxy({}, { get: (_t, key) => (mockDb.client() as Record<string | symbol, unknown>)[key] }),
}))

import { GET as menuRoute } from '@/app/api/menu/[restaurantId]/category/[categoryId]/route'
import { POST as posRoute } from '@/app/api/terminal/orders/route'
import { POST as roundsRoute } from '@/app/api/terminal/rounds/route'
import { GET as linesRoute } from '@/app/api/terminal/tabs/[tabId]/lines/route'
import { POST as prepareRoute } from '@/app/api/terminal/orders/[orderId]/prepare-payment/route'
import { POST as settleRoute } from '@/app/api/terminal/tabs/[tabId]/settle/route'
import { GET as historyRoute } from '@/app/api/orders/history/route'
import { POST as invoiceRoute } from '@/app/api/admin/documents/from-order/route'
import { POST as sendRoute } from '@/app/api/admin/documents/[id]/send/route'

type Json = Record<string, any>
type Row = Record<string, unknown>

const LATTE_ROW: Row = {
  id: LATTE,
  name: 'Latte',
  base_price: 0, // the schema default: a variant-only item. Priced at N$0 before C6.
  sizes: [],
  addons: [],
  variants: null,
  variant_groups: [
    { name: 'Size', required: true, type: 'price', options: [{ label: 'Small', price: 30 }, { label: 'Large', price: 40 }] },
  ],
}
const FLAT_WHITE_ROW: Row = {
  id: FLAT_WHITE,
  name: 'Flat White',
  base_price: 38,
  sizes: [],
  addons: [],
  variants: null,
  variant_groups: [
    { name: 'Size', required: true, type: 'price', options: [{ label: 'Regular', price: 38 }, { label: 'Large', price: 42 }] },
    { name: 'Milk', required: true, type: 'text', options: ['Full cream', 'Oat'] },
  ],
}
const WATER_ROW: Row = { id: WATER, name: 'Still Water', base_price: 20, sizes: [], addons: [], variants: null, variant_groups: [] }

function world() {
  mockDb = new InMemoryDb({
    restaurants: [{ id: RV, name: 'Riviera', phone: '+264 61 000000', address: '1 Sam Nujoma Ave', logo_url: null, timezone: 'Africa/Windhoek' }],
    restaurant_tables: [{ id: TABLE, restaurant_id: RV, table_number: 5, status: 'occupied' }],
    tabs: [{ id: TABV, restaurant_id: RV, table_id: TABLE, table_number: 5, status: 'open', total: 0, created_at: '2026-09-29T09:00:00.000Z', opened_by_user_id: null, settled_at: null }],
    menu_categories: [{ id: CAT, restaurant_id: RV, name: 'Coffee', route_to: 'bar' }],
    menu_subcategories: [],
    menu_items: [LATTE_ROW, FLAT_WHITE_ROW, WATER_ROW].map((r) => ({
      ...r,
      restaurant_id: RV,
      category_id: CAT,
      subcategory_id: null,
      tax_rate_id: VAT,
      status: 'available',
    })),
    tax_rates: [{ id: VAT, restaurant_id: RV, name: 'VAT', percentage: 15, is_inclusive: true, is_default: true }],
    restaurant_billing_profiles: [{ restaurant_id: RV, registration_number: 'CC/2019/04471', vat_number: '8123456-01-5', bank_name: 'Bank Windhoek', bank_account_name: 'Riviera Trading CC', bank_account_number: '8009112233', bank_branch_code: '481972' }],
    orders: [],
    order_lines: [],
    order_line_events: [],
    order_line_allocations: [],
    order_line_allocation_settlements: [],
    order_requests: [],
    payment_events: [],
    payments: [],
    payment_tips: [],
    audit_logs: [],
    business_documents: [],
    document_payments: [],
    restaurant_users: [],
  }, {
    business_documents: {
      defaults: { issued_at: '2026-09-29T08:00:00.000Z', currency: 'NAD', status: 'draft', sent_at: null },
    },
  })
}

const PROTOCOL = { 'X-FlashTap-Variant-Protocol': '1' }

async function menu() {
  const res = await menuRoute(new Request(`https://x.test/api/menu/${RV}/category/${CAT}`), {
    params: Promise.resolve({ restaurantId: RV, categoryId: CAT }),
  })
  const body = (await res.json()) as Record<string, { items: Json[] }>
  return Object.values(body).flatMap((g) => g.items)
}

/**
 * What the terminal does with the payload: find the item, answer each group with an option LABEL
 * taken from `resolved_variant_groups`, and send `{ group: label }`. The stale `price` it carries is
 * the one the payload showed -- a client figure the server must ignore.
 */
async function pick(itemId: string, answers: Record<string, string>) {
  const item = (await menu()).find((i) => i.id === itemId)!
  const selectedVariants: Record<string, string> = {}
  let shown = Number(item.base_price)
  for (const [group, label] of Object.entries(answers)) {
    const g = (item.resolved_variant_groups as Json[]).find((x) => x.name === group)
    const o = g?.options.find((x: Json) => x.label === label)
    selectedVariants[group] = label
    if (g?.type === 'price' && o) shown = Number(o.price)
  }
  return { menuItemId: itemId, name: item.name as string, quantity: 1, selectedVariants, price: shown, unitPrice: shown, total: shown }
}

async function sale(items: unknown[], headers: Record<string, string> = PROTOCOL) {
  const res = await posRoute(
    new Request('https://x.test/api/terminal/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ restaurantId: RV, items, subtotal: 1, total: 1 }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Json }
}

async function round(items: unknown[], key: string, headers: Record<string, string> = PROTOCOL) {
  const res = await roundsRoute(
    new Request('https://x.test/api/terminal/rounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-idempotency-key': key, ...headers },
      body: JSON.stringify({ tab_id: TABV, items, subtotal: 1, total: 1 }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Json }
}

async function prepare(orderId: string, orderIds: string[]) {
  const res = await prepareRoute(
    new NextRequest(`http://localhost/api/terminal/orders/${orderId}/prepare-payment`, {
      method: 'POST',
      body: JSON.stringify({ order_ids: orderIds }),
    }),
    { params: Promise.resolve({ orderId }) },
  )
  return { status: res.status, body: (await res.json()) as Json }
}

async function settleCard(orderIds: string[], amount: number) {
  const res = await settleRoute(
    new NextRequest(`http://localhost/api/terminal/tabs/${TABV}/settle`, {
      method: 'POST',
      body: JSON.stringify({
        order_ids: orderIds,
        amount,
        method: 'card',
        gateway_reference: 'TXN-VAR-1',
        voucher_no: 'TXN-VAR-1',
        business_order_no: 'MO-VAR-1',
      }),
    }),
    { params: Promise.resolve({ tabId: TABV }) },
  )
  return { status: res.status, body: (await res.json()) as Json }
}

async function lines() {
  const res = await linesRoute(new Request(`https://x.test/api/terminal/tabs/${TABV}/lines`), {
    params: Promise.resolve({ tabId: TABV }),
  })
  return (await res.json()) as Json
}

async function history() {
  // A window either side of now: the route reads days in the venue's timezone, not UTC.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const res = await historyRoute(
    new Request(`https://x.test/api/orders/history?restaurantId=${RV}&startDate=${day(-1)}&endDate=${day(1)}`),
  )
  return (await res.json()) as Json
}

async function invoiceTab() {
  const res = await invoiceRoute(
    new Request('https://x.test/api/admin/documents/from-order', {
      method: 'POST',
      body: JSON.stringify({ tab_id: TABV, restaurant_id: RV, bill_to: { name: 'Acme CC', email: 'ap@acme.test' } }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Json }
}

const onlyOrder = () => {
  expect(mockDb.rows('orders')).toHaveLength(1)
  return mockDb.rows('orders')[0] as Json
}
const nothingWritten = () => {
  expect(mockDb.rows('orders')).toHaveLength(0)
  expect(mockDb.rows('order_lines')).toHaveLength(0)
  expect(mockDb.rows('order_line_events')).toHaveLength(0)
}

beforeEach(() => {
  world()
  jest.spyOn(console, 'log').mockImplementation(() => {})
  jest.spyOn(console, 'warn').mockImplementation(() => {})
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

describe('the catalog payload is what the server prices', () => {
  it('every item carries resolved_variant_groups -- the pricer\'s own reading; [] when it has none', async () => {
    const items = await menu()
    const by = (id: string) => items.find((i) => i.id === id)!
    expect(by(LATTE).resolved_variant_groups).toEqual([
      { name: 'Size', required: true, type: 'price', options: [{ label: 'Small', price: 30 }, { label: 'Large', price: 40 }] },
    ])
    expect(by(FLAT_WHITE).resolved_variant_groups).toEqual([
      { name: 'Size', required: true, type: 'price', options: [{ label: 'Regular', price: 38 }, { label: 'Large', price: 42 }] },
      { name: 'Milk', required: true, type: 'text', options: [{ label: 'Full cream', price: null }, { label: 'Oat', price: null }] },
    ])
    expect(by(WATER).resolved_variant_groups).toEqual([])
  })
})

describe('Sale (POST /api/terminal/orders) -- cases 1, 2, 6, 7', () => {
  it('1+7. a valid variant on a base_price-0 item: N$40 from the catalog, persisted with its name and selection', async () => {
    const r = await sale([await pick(LATTE, { Size: 'Large' })])
    expect(r.status).toBe(200)
    const order = onlyOrder()
    expect(order.total).toBe(40)
    expect(order.items[0]).toMatchObject({
      menuItemId: LATTE,
      name: 'Latte - Large',
      displayName: 'Latte - Large',
      selectedVariants: { Size: 'Large' },
      unitPrice: 40,
      total: 40,
      price: 40,
      priceSource: 'catalog',
    })
    // The card charge is the persisted figure -- never the client's `total: 1`.
    const p = await prepare(String(order.id), [String(order.id)])
    expect(p.status).toBe(200)
    expect(p.body.chargeCents).toBe(4000)
  })

  it('2. multiple groups: the price group sets the price, the text group is carried, canonical group order', async () => {
    const item = await pick(FLAT_WHITE, { Milk: 'Oat', Size: 'Large' })
    const r = await sale([item])
    expect(r.status).toBe(200)
    const order = onlyOrder()
    expect(order.items[0]).toMatchObject({ name: 'Flat White - Large / Oat', unitPrice: 42 })
    expect(Object.keys(order.items[0].selectedVariants)).toEqual(['Size', 'Milk'])
    expect(order.total).toBe(42)
  })

  it('6. a STALE client price is ignored: the venue repriced Large after the terminal loaded the menu', async () => {
    const item = await pick(LATTE, { Size: 'Large' }) // the payload said 40; the device carries 40
    const row = mockDb.rows('menu_items').find((m) => m.id === LATTE)!
    row.variant_groups = [
      { name: 'Size', required: true, type: 'price', options: [{ label: 'Small', price: 30 }, { label: 'Large', price: 45 }] },
    ]
    const r = await sale([{ ...item, price: 40, unitPrice: 40, total: 40 }])
    expect(r.status).toBe(200)
    const order = onlyOrder()
    expect(order.items[0]).toMatchObject({ unitPrice: 45, total: 45, price: 45 })
    expect(order.total).toBe(45)
  })

  it('6b. a client price that is simply WRONG (N$1) never reaches the order, the charge or the line', async () => {
    const item = await pick(LATTE, { Size: 'Small' })
    const r = await sale([{ ...item, price: 1, unitPrice: 1, total: 1, subtotal: 1 }])
    expect(r.status).toBe(200)
    const order = onlyOrder()
    expect(order.total).toBe(30)
    expect(JSON.stringify(order.items)).not.toMatch(/"(price|unitPrice|total)":1[,}]/)
  })
})

describe('refusals write nothing -- cases 3, 4, 5', () => {
  it.each([
    { label: '3. required variant missing', code: 'MENU_ITEM_VARIANT_REQUIRED', groups: ['Size'],
      build: async () => ({ menuItemId: LATTE, name: 'Latte', quantity: 1, price: 40 }) },
    { label: '4. unknown group', code: 'MENU_ITEM_UNPRICEABLE_SELECTION', groups: ['Syrup'],
      build: async () => ({ ...(await pick(LATTE, { Size: 'Large' })), selectedVariants: { Size: 'Large', Syrup: 'Vanilla' } }) },
    { label: '5. unknown option', code: 'MENU_ITEM_UNPRICEABLE_SELECTION', groups: ['Size'],
      build: async () => ({ ...(await pick(LATTE, { Size: 'Large' })), selectedVariants: { Size: 'Venti' } }) },
  ])('$label: 400 $code on BOTH terminal routes, no order, no line, no event', async ({ build, code, groups }) => {
    const item = await build()
    for (const send of [() => sale([item]), () => round([item], 'key-refused')]) {
      const r = await send()
      expect(r.status).toBe(400)
      expect(r.body.code).toBe(code)
      expect(r.body.unavailableItems).toEqual([expect.objectContaining({ menuItemId: LATTE, groups })])
      nothingWritten()
    }
  })

  it('a text-group-only miss is refused too: Flat White with a size but no milk', async () => {
    const item = await pick(FLAT_WHITE, { Size: 'Large' })
    const r = await round([item], 'key-milk')
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ code: 'MENU_ITEM_VARIANT_REQUIRED', unavailableItems: [expect.objectContaining({ groups: ['Milk'] })] })
    nothingWritten()
  })
})

describe('Add a Round -> kitchen -> history -> charge -> ledger -> invoice -- cases 8, 9, 10, 11', () => {
  async function sendRound() {
    const items = [
      await pick(LATTE, { Size: 'Small' }),
      await pick(LATTE, { Size: 'Large' }),
      await pick(FLAT_WHITE, { Size: 'Large', Milk: 'Oat' }),
    ]
    const r = await round(items, 'key-round-1')
    expect(r.status).toBe(200)
    return onlyOrder()
  }

  it('8+9. one round, two variants of the SAME product: two lines, two prices, two names for the bar', async () => {
    const order = await sendRound()
    expect(order.items.map((i: Json) => [i.name, i.unitPrice])).toEqual([
      ['Latte - Small', 30],
      ['Latte - Large', 40],
      ['Flat White - Large / Oat', 42],
    ])
    expect(order.total).toBe(112)
    const stationLines = mockDb.rows('order_lines').sort((a, b) => Number(a.source_item_index) - Number(b.source_item_index))
    expect(stationLines.map((l) => [l.name_snapshot, l.route_to, l.bar_state])).toEqual([
      ['Latte - Small', 'bar', 'outstanding'],
      ['Latte - Large', 'bar', 'outstanding'],
      ['Flat White - Large / Oat', 'bar', 'outstanding'],
    ])
    // The P5 bills from the lines route: each line carries its own server price.
    const view = await lines()
    expect(view.tab.total).toBe(112)
    expect(view.orders[0].lines.map((l: Json) => [l.name_snapshot, l.total_cents])).toEqual([
      ['Latte - Small', 3000],
      ['Latte - Large', 4000],
      ['Flat White - Large / Oat', 4200],
    ])
    // The office reads the same names and the same live figure.
    const h = await history()
    const row = h.orders.find((o: Json) => o.id === order.id)
    expect(row.items.map((i: Json) => i.name)).toEqual(['Latte - Small', 'Latte - Large', 'Flat White - Large / Oat'])
    expect(row).toMatchObject({ order_amount: 112, live_amount: 112 })
  })

  it('10. payment: the charge is N$112, the card settlement expects it, and the ledger row records it', async () => {
    const order = await sendRound()
    const id = String(order.id)
    const p = await prepare(id, [id])
    expect(p.body.chargeCents).toBe(11200)
    expect(mockDb.rows('orders')[0].pending_charge_cents).toBe(11200)

    // A device that sent the payload's figures (or anything else) cannot move what is expected.
    const wrong = await settleCard([id], 100)
    expect(wrong.status).toBe(400)
    expect(wrong.body).toMatchObject({ code: 'AMOUNT_MISMATCH', expected: 112 })

    const ok = await settleCard([id], 112)
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ success: true, method: 'card', sale_event: 'recorded' })
    expect(mockDb.rows('payment_events')).toEqual([
      expect.objectContaining({ event_type: 'sale', amount: 112, business_order_no: 'MO-VAR-1', order_ids: [id] }),
    ])
    expect(mockDb.rows('orders')[0]).toMatchObject({ payment_status: 'paid', settled_charge_cents: 11200 })
  })

  it('11. the invoice bills each variant line at its catalog price, and the PDF says so', async () => {
    const order = await sendRound()
    const id = String(order.id)
    await prepare(id, [id])
    expect((await settleCard([id], 112)).status).toBe(200)

    const inv = await invoiceTab()
    expect(inv.status).toBe(201)
    const doc = inv.body.document as Json
    expect(doc.line_items.map((l: Json) => [l.description, l.quantity, l.unit_price, l.line_total])).toEqual([
      ['Latte - Small', 1, 30, 30],
      ['Latte - Large', 1, 40, 40],
      ['Flat White - Large / Oat', 1, 42, 42],
    ])
    expect(doc).toMatchObject({ total: 112, balance: 0, status: 'paid' })
    // Invoice paid = ledger = the settled charge.
    const paid = mockDb.rows('document_payments').reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0)
    expect(paid).toBe(11200)
    expect(paid).toBe(Math.round(Number(mockDb.rows('payment_events')[0].amount) * 100))
    expect(paid).toBe(Number(mockDb.rows('orders')[0].settled_charge_cents))

    // Emailed through the real send route; Resend is stopped at the network and the attachment the
    // customer would open is the PDF read below.
    process.env.RESEND_API_KEY = 're_test_variant'
    const outbound: Json[] = []
    jest.spyOn(global, 'fetch').mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (!String(input).startsWith('https://api.resend.com/')) throw new Error(`unexpected fetch ${String(input)}`)
      outbound.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(JSON.stringify({ id: 're_variant' }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const sent = await sendRoute(new Request(`https://x.test/api/admin/documents/${doc.id}/send`, { method: 'POST' }), {
      params: Promise.resolve({ id: String(doc.id) }),
    })
    expect(sent.status).toBe(200)
    expect(outbound).toHaveLength(1)
    const pdf = Buffer.from(String(outbound[0].attachments[0].content), 'base64')
    const text = (await extractPdfText(new Uint8Array(pdf))).replace(/\s+/g, ' ')
    expect(text).toContain('Latte - Small')
    expect(text).toContain('Latte - Large')
    expect(text).toContain('Flat White - Large / Oat')
    expect(text).toContain('Total NAD 112.00')
  })
})

describe('2.39 compatibility: no X-FlashTap-Variant-Protocol header', () => {
  it('a missing required variant is priced as before (base), NOT refused, and the gap is logged naming the item', async () => {
    const warn = console.warn as jest.Mock
    const r = await round([{ menuItemId: LATTE, name: 'Latte', quantity: 1, price: 40 }], 'key-239', {})
    expect(r.status).toBe(200)
    const order = onlyOrder()
    expect(order.items[0]).toMatchObject({ name: 'Latte', unitPrice: 0 })
    expect(order.items[0]).not.toHaveProperty('variantResolution')
    const gap = warn.mock.calls.find((c) => c[0] === '[TERMINAL VARIANT GAP]')
    expect(gap?.[1]).toMatchObject({ restaurantId: RV, menuItemId: LATTE, itemName: 'Latte', missingRequired: ['Size'] })
  })

  it('a 2.39 terminal that DID pick a size is still charged the option, not base -- #117 is not gated on the header', async () => {
    const r = await sale([{ menuItemId: LATTE, name: 'Latte', quantity: 1, selectedVariants: { Size: 'Large' }, price: 1 }], {})
    expect(r.status).toBe(200)
    expect(onlyOrder().total).toBe(40)
  })
})
