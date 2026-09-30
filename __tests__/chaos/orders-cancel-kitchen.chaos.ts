/**
 * ORDERS, CANCELLATION, KITCHEN, VARIANTS AND IDEMPOTENCY AT THE SERVER BOUNDARY -- driven through
 * the REAL route handlers against a REAL PostgREST and a REAL Postgres built from the production
 * migration set (Sprint 2026-09-30, agent RC-ORDERS).
 *
 * Launched only by `node supabase/tests/chaos-e2e.mjs --scenario=orders-cancel-kitchen` (the file
 * name does not match jest's testMatch, so the offline suite never picks it up). See that script's
 * header for what is and is not real, and for the safety rules; this file repeats the same mocks
 * as tab-lifecycle.chaos.ts, and nothing else is mocked.
 *
 * WHAT THIS SCENARIO OWNS, and what tab-lifecycle already proves (not repeated here):
 *   A  order sending / retry      A1 normal, A2 lost response, A3 changed basket (sequential AND
 *                                 concurrent), A4 double-tap (same key with both requests past
 *                                 the replay check; two keys for one basket), A5 a round in flight
 *   B  cancellation (server)      B1 unpaid, B2 applied-but-lost, B5 changed:false, B6 cooked,
 *                                 B7 paid, B8 partial payment / allocation rules, B9 cancel+re-add
 *   G  kitchen vs order vs money  station states, whole-order cancel from terminal and dashboard,
 *                                 station screens and broadcast, payment never cooks
 *   H  variants                   validation, two groups, two variants of one product, note,
 *                                 cancel, reduction, partial payment, invoice
 *   M  idempotency                rounds, POS orders, amend PIN, settle-allocations, invoice
 *
 * CONCURRENCY IS REAL. Every "at once" step fires two route calls with Promise.all against the one
 * PostgREST, each on its own HTTP connection and its own Postgres session. Where the interleaving
 * that matters is narrow, `hold()` below pins it: the named request of EACH call is held until
 * both have arrived, so both have passed every earlier read before either writes -- the worst case,
 * made deterministic rather than hoped for. Nothing is sequenced by the test.
 *
 * Every checkpoint asserts SERVER state (psql rows and the read routes' JSON). Step titles are the
 * names the mutation runner matches on; renaming one means updating MUTATIONS in chaos-e2e.mjs.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// ------------------------------------------------------------------------------------------------
// SAFETY: refuse to run against anything but the harness's own loopback proxy.
// ------------------------------------------------------------------------------------------------
const REST_URL = process.env.FT_CHAOS_REST_URL ?? ''
const SERVICE_KEY = process.env.FT_CHAOS_SERVICE_KEY ?? ''
const DB = process.env.FT_CHAOS_DB ?? ''
const CONTAINER = process.env.FT_CHAOS_CONTAINER ?? ''
if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(REST_URL)) {
  throw new Error(`chaos: FT_CHAOS_REST_URL must be the harness's 127.0.0.1 proxy, got "${REST_URL}". Run supabase/tests/chaos-e2e.mjs.`)
}
if (!/^[a-z][a-z0-9_]{0,40}$/.test(DB) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/.test(CONTAINER)) {
  throw new Error('chaos: FT_CHAOS_DB / FT_CHAOS_CONTAINER missing or malformed')
}
// jest.setup-env.ts loaded .env.test (staging!) with override; replace every Supabase variable.
process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'chaos-anon-key-unused'
process.env.RESEND_API_KEY = ''

/**
 * Every outbound request goes through here. Non-loopback hosts throw. `hold` is the interleaving
 * pin described in the header: a request matching the active hold waits until `expected` matching
 * requests have arrived (or 4 s pass), then all are released together.
 */
const realFetch = globalThis.fetch
type Hold = {
  match: (method: string, path: string, search: string, body: string) => boolean
  expected: number
  waiting: Array<() => void>
  timer: NodeJS.Timeout | null
  arrived: number
}
let activeHold: Hold | null = null
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname !== '127.0.0.1') {
    throw new Error(`chaos: refused a request to ${url.origin} -- only the loopback proxy may be reached`)
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const body = typeof init?.body === 'string' ? init.body : ''
  const hold = activeHold
  // One-shot: once the pinned requests are released, later matching requests pass straight through.
  if (hold && hold.arrived < hold.expected && hold.match(method, url.pathname, decodeURIComponent(url.search), body)) {
    hold.arrived += 1
    await new Promise<void>((release) => {
      hold.waiting.push(release)
      if (hold.waiting.length >= hold.expected) {
        if (hold.timer) clearTimeout(hold.timer)
        hold.waiting.splice(0).forEach((r) => r())
      } else if (!hold.timer) {
        hold.timer = setTimeout(() => {
          hold.arrived = hold.expected
          hold.waiting.splice(0).forEach((r) => r())
        }, 4000)
      }
    })
  }
  const res = await realFetch(input as RequestInfo, init)
  if (res.status >= 400) {
    const text = await res.clone().text()
    console.warn(`[chaos] PostgREST ${res.status} for ${method} ${decodeURIComponent(url.pathname + url.search).slice(0, 600)}: ${text.slice(0, 300)}`)
  }
  return res
}) as typeof fetch

/** Run `fn` with `match`ing requests held until `expected` of them have arrived. */
async function withHold<T>(
  match: Hold['match'],
  expected: number,
  fn: () => Promise<T>,
): Promise<{ result: T; arrived: number }> {
  const hold: Hold = { match, expected, waiting: [], timer: null, arrived: 0 }
  activeHold = hold
  try {
    const result = await fn()
    return { result, arrived: hold.arrived }
  } finally {
    activeHold = null
    if (hold.timer) clearTimeout(hold.timer)
    hold.waiting.splice(0).forEach((r) => r())
  }
}

// ------------------------------------------------------------------------------------------------
// FIXTURE IDS (supabase/tests/chaos/seed.sql, plus two items this scenario adds in beforeAll)
// ------------------------------------------------------------------------------------------------
const R = 'c4a05000-0000-4000-8000-000000000001'
const TABLE = 'c4a05000-0000-4000-8000-0000000000a7'
const TERM = 'c4a05000-0000-4000-8000-00000000e001'
const MANAGER = 'c4a05000-0000-4000-8000-000000005001'
const WAITER = 'c4a05000-0000-4000-8000-000000005002'
const ITEM = {
  pasta: 'c4a05000-0000-4000-8000-000000001001',
  ribeye: 'c4a05000-0000-4000-8000-000000001002',
  burger: 'c4a05000-0000-4000-8000-000000001003',
  chips: 'c4a05000-0000-4000-8000-000000001004',
  salad: 'c4a05000-0000-4000-8000-000000001005',
  cheesecake: 'c4a05000-0000-4000-8000-000000001006',
  lager: 'c4a05000-0000-4000-8000-000000002001',
  wine: 'c4a05000-0000-4000-8000-000000002002',
  espresso: 'c4a05000-0000-4000-8000-000000002003',
  // Added by this scenario (beforeAll): a plain kitchen item, and a BASE-0 item whose price comes
  // only from a required priced group, with a second, optional text group.
  salmon: 'c4a05000-0000-4000-8000-000000001007',
  pizza: 'c4a05000-0000-4000-8000-000000001008',
} as const
type ItemKey = keyof typeof ITEM
const NAME: Record<ItemKey, string> = {
  pasta: 'Modena Pasta', ribeye: 'Ribeye', burger: 'Burger', chips: 'Chips', salad: 'Caesar Salad',
  cheesecake: 'Cheesecake', lager: 'Lager', wine: 'House Wine', espresso: 'Espresso',
  salmon: 'Grilled Salmon', pizza: 'Pizza',
}

/** THE ORACLE: unit price in cents, written from the menu, not the code. */
function priceCents(key: ItemKey, v: Record<string, string> = {}): number {
  switch (key) {
    case 'pasta': return v.Size === 'Large' ? 15500 : 12000
    case 'ribeye': return 24500
    case 'burger': return 9850
    case 'chips': return 3500
    case 'salad': return 7200
    case 'cheesecake': return 5500
    case 'lager': return 3200
    case 'wine': return v.Glass === 'Large' ? 6800 : 4500
    case 'espresso': return 2600
    case 'salmon': return 18500
    case 'pizza': return v.Size === 'Large' ? 14000 : 9000
  }
}

// ------------------------------------------------------------------------------------------------
// MOCKS -- the same edges as tab-lifecycle.chaos.ts, and the realtime broadcast RECORDS its calls
// so G6 can assert that a cancellation told the station screens.
// ------------------------------------------------------------------------------------------------
jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async (req: Request) => {
    if (req.headers.get('authorization') !== 'Bearer chaos-terminal') {
      throw new Response(JSON.stringify({ error: 'Missing terminal token' }), { status: 401 })
    }
    return {
      terminalId: 'c4a05000-0000-4000-8000-00000000e001',
      restaurantId: 'c4a05000-0000-4000-8000-000000000001',
      deviceSerial: 'CHAOS-P5-0001',
      permissions: ['orders:read', 'orders:update', 'payments:process'],
    }
  },
  validateTerminalRecord: async (
    supabase: { from: (t: string) => any },
    terminal: { terminalId: string; restaurantId: string },
  ) => {
    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select('id, status, restaurant_id, device_serial')
      .eq('id', terminal.terminalId)
      .eq('restaurant_id', terminal.restaurantId)
      .single()
    if (error || !data) throw new Response(JSON.stringify({ error: 'Terminal not recognized', detail: error }), { status: 401 })
    if (data.status !== 'active') throw new Response(JSON.stringify({ error: 'Terminal is not active' }), { status: 403 })
    return data
  },
}))
const broadcasts: string[] = []
jest.mock('@/lib/stations/realtime-invalidate', () => ({
  ...jest.requireActual('@/lib/stations/realtime-invalidate'),
  broadcastLineChanged: async (_supabase: unknown, restaurantId: string) => {
    broadcasts.push(restaurantId)
  },
}))
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  ...jest.requireActual('@/lib/payments/finatic-restaurant-credentials'),
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'CHAOS-MERCHANT', storeNo: 'CHAOS-STORE' }),
}))
jest.mock('@/lib/payments/query-finatic-order-paid', () => ({
  ...jest.requireActual('@/lib/payments/query-finatic-order-paid'),
  queryFinaticOrderPaid: async (p: { merchantOrderNo: string }) => ({
    paid: false, statusRecognised: true, merchantOrderNo: p.merchantOrderNo, status: 'PENDING',
    transactionId: null, amount: null, raw: { simulated: true },
  }),
}))
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  ...jest.requireActual('@/lib/supabase/admin-restaurant-auth'),
  getUserFromRequest: async (req: Request) => {
    if (req.headers.get('authorization') !== 'Bearer chaos-manager') throw new Error('Missing authorization')
    return { id: 'c4a05000-0000-4000-8000-000000005001', email: 'manager@chaos.invalid' }
  },
}))

import { POST as openTable } from '@/app/api/terminal/tables/[tableId]/open/route'
import { POST as postRound } from '@/app/api/terminal/rounds/route'
import { POST as postPosOrder } from '@/app/api/terminal/orders/route'
import { GET as getLines } from '@/app/api/terminal/tabs/[tabId]/lines/route'
import { POST as amendTab } from '@/app/api/terminal/tabs/[tabId]/amend/route'
import { POST as allocateLine } from '@/app/api/terminal/tabs/[tabId]/lines/[lineId]/allocate/route'
import { POST as settleAllocations } from '@/app/api/terminal/tabs/[tabId]/settle-allocations/route'
import { POST as settleTab } from '@/app/api/terminal/tabs/[tabId]/settle/route'
import { PATCH as terminalOrderStatus } from '@/app/api/terminal/orders/[orderId]/status/route'
import { PATCH as dashboardOrderStatus } from '@/app/api/orders/[orderId]/status/route'
import { POST as stationLineState } from '@/app/api/station/order-lines/[lineId]/state/route'
import { GET as stationLines } from '@/app/api/station/lines/route'
import { POST as invoiceFromOrder } from '@/app/api/admin/documents/from-order/route'
import { POST as prepareSplitPayment } from '@/app/api/terminal/tabs/[tabId]/prepare-split-payment/route'

// ------------------------------------------------------------------------------------------------
// SERVER-STATE READERS
// ------------------------------------------------------------------------------------------------
function sql<T = Record<string, any>>(query: string): T[] {
  const out = execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { input: `SELECT coalesce(json_agg(t), '[]'::json) FROM (${query}) t;`, encoding: 'utf8' },
  )
  return JSON.parse(out.trim()) as T[]
}
function sqlExec(statement: string): void {
  execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1'], {
    input: statement,
    encoding: 'utf8',
  })
}
const n = (query: string) => sql<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`)[0].n
const cents = (major: unknown) => Math.round(Number(major) * 100)

type Json = Record<string, any>
type Res = { status: number; body: Json }
async function call(
  handler: (req: Request, ctx: any) => Promise<Response>,
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string>; auth?: string } = {},
): Promise<Res> {
  const req = new Request(`https://chaos.test${path}`, {
    method: opts.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: opts.auth ?? 'Bearer chaos-terminal',
      ...(opts.headers ?? {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) })
  const text = await res.text()
  let body: Json = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: res.status, body }
}
function expectStatus(res: Res, status: number) {
  if (res.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 1500)}`)
  }
}
function mintToken(purpose: 'service_session' | 'line_void' | 'cash_settlement', userId = MANAGER): string {
  const id = randomUUID()
  sqlExec(`INSERT INTO public.privileged_authorization_tokens (id, user_id, restaurant_id, terminal_id, purpose, nonce, ttl_seconds, expires_at)
           VALUES ('${id}', '${userId}', '${R}', '${TERM}', '${purpose}', '${randomUUID()}', 90, now() + interval '90 seconds');`)
  return id
}

// ------------------------------------------------------------------------------------------------
// ROUNDS, LINES, AND WHAT THE SERVER SAYS THEY ARE WORTH
// ------------------------------------------------------------------------------------------------
type Want = { key: ItemKey; qty: number; note?: string; v?: Record<string, string> }
let tabId = ''

function roundItems(wants: Want[]) {
  return wants.map((w) => ({
    menuItemId: ITEM[w.key],
    name: NAME[w.key],
    quantity: w.qty,
    ...(w.note ? { note: w.note } : {}),
    ...(w.v ? { selectedVariants: w.v } : {}),
    // A deliberately wrong client price: the server must reprice every line.
    price: 1,
    unitPrice: 1,
  }))
}
function sendRound(key: string, wants: Want[], opts: { protocol?: boolean } = {}) {
  return call(postRound, '/api/terminal/rounds', {
    body: { tab_id: tabId, items: roundItems(wants), subtotal: 1, total: 1 },
    headers: { 'x-idempotency-key': key, ...(opts.protocol === false ? {} : { 'x-flashtap-variant-protocol': '1' }) },
  })
}
const wantsCents = (wants: Want[]) => wants.reduce((s, w) => s + priceCents(w.key, w.v) * w.qty, 0)

type LineRow = { id: string; order_id: string; source_item_index: number; name_snapshot: string; quantity: string; line_note: string | null; route_to: string; kitchen_state: string | null; bar_state: string | null }
function linesOf(orderId: string): LineRow[] {
  return sql<LineRow>(`SELECT id, order_id, source_item_index, name_snapshot, quantity, line_note, route_to, kitchen_state, bar_state
                         FROM order_lines WHERE order_id = '${orderId}' ORDER BY source_item_index`)
}
/** The line of `orderId` at the position `index` of what was sent (lines are written in item order). */
function lineAt(orderId: string, index: number): LineRow {
  const row = linesOf(orderId).find((l) => l.source_item_index === index)
  if (!row) throw new Error(`no line ${index} on order ${orderId}`)
  return row
}
const stateOf = (lineId: string) => sql<{ k: string | null; b: string | null }>(`SELECT kitchen_state AS k, bar_state AS b FROM order_lines WHERE id = '${lineId}'`)[0]
const voidEvents = (lineId: string) => n(`SELECT 1 FROM order_line_events WHERE order_line_id = '${lineId}' AND to_state = 'voided'`)

async function financials(): Promise<Json> {
  const res = await call(getLines, `/api/terminal/tabs/${tabId}/lines`, { method: 'GET', params: { tabId } })
  expectStatus(res, 200)
  return res.body
}
async function voidLines(targets: Array<{ id: string; qty?: number }>, reason: string, token = mintToken('line_void')) {
  return call(amendTab, `/api/terminal/tabs/${tabId}/amend`, {
    params: { tabId },
    body: {
      amendments: targets.map((t) => ({ line_id: t.id, new_quantity: t.qty ?? 0 })),
      staff_user_id: MANAGER,
      authorization_token_id: token,
      void_reason: reason,
    },
  })
}
async function bump(lineId: string, station: 'kitchen' | 'bar', to: string) {
  const r = await call(stationLineState, `/api/station/order-lines/${lineId}/state`, { params: { lineId }, body: { station, to_state: to } })
  expectStatus(r, 200)
}
async function allocate(lineId: string, shares: Array<[string, number]>) {
  return call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${lineId}/allocate`, {
    params: { tabId, lineId },
    body: { shares: shares.map(([who, q]) => ({ allocated_to: who, quantity_allocated: q })) },
  })
}
async function settleAlloc(ids: string[]) {
  return call(settleAllocations, `/api/terminal/tabs/${tabId}/settle-allocations`, {
    params: { tabId }, body: { allocation_ids: ids, method: 'cash' },
  })
}
async function boardLineIds(station: 'kitchen' | 'bar'): Promise<string[]> {
  const res = await call(stationLines, `/api/station/lines?station=${station}`, { method: 'GET' })
  expectStatus(res, 200)
  return (res.body.orders as Json[]).flatMap((o) => (o.lines as Json[]).map((l) => String(l.id)))
}
/** Every table a void or a payment could have touched, for "nothing changed" assertions. */
function moneySnapshot() {
  return {
    orders: n(`SELECT 1 FROM orders WHERE tab_id = '${tabId}'`),
    lines: n(`SELECT 1 FROM order_lines WHERE tab_id = '${tabId}'`),
    voidEvents: n(`SELECT 1 FROM order_line_events e JOIN order_lines l ON l.id = e.order_line_id WHERE l.tab_id = '${tabId}' AND e.to_state = 'voided'`),
    liveAllocations: n(`SELECT 1 FROM order_line_allocations WHERE tab_id = '${tabId}' AND voided_at IS NULL`),
    settlements: n(`SELECT 1 FROM order_line_allocation_settlements WHERE tab_id = '${tabId}'`),
    payments: n(`SELECT 1 FROM payments WHERE tab_id = '${tabId}'`),
  }
}

// ------------------------------------------------------------------------------------------------
// THE SCENARIO
// ------------------------------------------------------------------------------------------------
let broken: string | null = null
function step(title: string, fn: () => Promise<void>) {
  test(title, async () => {
    if (broken) throw new Error(`not run: an earlier checkpoint failed (${broken})`)
    broken = title
    await fn()
    broken = null
  }, 60_000)
}

const ORD: Record<string, string> = {}

beforeAll(() => {
  sqlExec(`INSERT INTO public.menu_items (id, restaurant_id, category_id, name, base_price, status, variant_groups) VALUES
    ('${ITEM.salmon}', '${R}', 'c4a05000-0000-4000-8000-00000000c001', 'Grilled Salmon', 185, 'active', '[]'::jsonb),
    ('${ITEM.pizza}', '${R}', 'c4a05000-0000-4000-8000-00000000c001', 'Pizza', 0, 'active',
     '[{"name":"Size","required":true,"type":"price","options":[{"label":"Small","price":90},{"label":"Large","price":140}]},
       {"name":"Crust","required":false,"type":"text","options":["Thin","Thick"]}]'::jsonb);`)
})

describe('chaos orders, cancellation, kitchen, variants, idempotency', () => {
  step('O01 open the tab', async () => {
    const res = await call(openTable, `/api/terminal/tables/${TABLE}/open`, {
      params: { tableId: TABLE },
      body: { user_id: WAITER, authorization_token_id: mintToken('service_session', WAITER), customer_name: 'RC orders' },
    })
    expectStatus(res, 200)
    tabId = res.body.tab.id
    expect(sql(`SELECT status FROM tabs WHERE id = '${tabId}'`)[0].status).toBe('open')
  })

  const roundA: Want[] = [
    { key: 'pasta', qty: 1, note: 'no parmesan', v: { Size: 'Large', Sauce: 'Cream' } },
    { key: 'burger', qty: 2 },
    { key: 'lager', qty: 2, note: 'ice cold' },
    { key: 'ribeye', qty: 1, v: { Doneness: 'Medium' } },
  ]

  step('O02 A1 normal round: server prices, variants, notes, kitchen names', async () => {
    const res = await sendRound('rc-A1', roundA)
    expectStatus(res, 200)
    expect(res.body).toMatchObject({ success: true, duplicate: false, lines_written: true, line_count: 4 })
    ORD.A = res.body.order_id
    const [order] = sql(`SELECT total, items FROM orders WHERE id = '${ORD.A}'`)
    expect(cents(order.total)).toBe(wantsCents(roundA))
    expect(wantsCents(roundA)).toBe(15500 + 19700 + 6400 + 24500)
    const rows = linesOf(ORD.A)
    expect(rows.map((r) => [Number(r.quantity), r.line_note, r.route_to])).toEqual([
      [1, 'no parmesan', 'kitchen'], [2, null, 'kitchen'], [2, 'ice cold', 'bar'], [1, null, 'kitchen'],
    ])
    expect(rows[0].name_snapshot).toMatch(/Large/)
    expect(rows[3].name_snapshot).toMatch(/Medium/)
    // One creation event per station half.
    expect(n(`SELECT 1 FROM order_line_events e JOIN order_lines l ON l.id = e.order_line_id WHERE l.order_id = '${ORD.A}' AND e.to_state = 'outstanding'`)).toBe(4)
  })

  step('O03 A2 response lost: the same-key retry is the same round, nothing new', async () => {
    const before = moneySnapshot()
    const retry = await sendRound('rc-A1', roundA)
    expectStatus(retry, 200)
    expect(retry.body).toMatchObject({ duplicate: true, order_id: ORD.A, line_count: 4 })
    expect(moneySnapshot()).toEqual(before)
    expect(n(`SELECT 1 FROM orders WHERE idempotency_key = 'rc-A1'`)).toBe(1)
  })

  step('O04 A4 double-tap on one key, both past the replay check: one order, one set of lines', async () => {
    const basket: Want[] = [{ key: 'chips', qty: 1, note: 'crispy' }, { key: 'espresso', qty: 1 }]
    const before = moneySnapshot()
    // Pin the worst interleaving: each request's "do lines already exist?" read waits until the
    // other one has made it too, so both have created-or-found the order and both see no lines.
    const { result: [a, b], arrived } = await withHold(
      (m, path, search) => m === 'GET' && path.endsWith('/rest/v1/order_lines') && search.includes('select=id,route_to,name_snapshot,quantity,kitchen_state,bar_state'),
      2,
      () => Promise.all([sendRound('rc-A4-dbl', basket), sendRound('rc-A4-dbl', basket)]),
    )
    expect(arrived).toBe(2)
    expectStatus(a, 200)
    expectStatus(b, 200)
    expect(a.body.order_id).toBe(b.body.order_id)
    // Exactly one of the two created the round; the other is answered as its replay.
    expect([a.body.duplicate, b.body.duplicate].sort()).toEqual([false, true])
    ORD.dbl = a.body.order_id
    expect(n(`SELECT 1 FROM orders WHERE idempotency_key = 'rc-A4-dbl'`)).toBe(1)
    expect(linesOf(ORD.dbl)).toHaveLength(2)
    expect(n(`SELECT 1 FROM order_line_events e JOIN order_lines l ON l.id = e.order_line_id WHERE l.order_id = '${ORD.dbl}'`)).toBe(2)
    expect(moneySnapshot()).toEqual({ ...before, orders: before.orders + 1, lines: before.lines + 2 })
    // The tab is owed the round once.
    const f = await financials()
    expect(f.financials.orders[ORD.dbl].live_cents).toBe(wantsCents(basket))
  })

  step('O05 A4 one basket under two keys at once: two intentional rounds (a key is the unit of intent)', async () => {
    // DECIDED AND DOCUMENTED: the server does not guess that two DIFFERENT keys are one tap. The key
    // is how a device says "this is one round"; the device mints one per basket and keeps it until
    // the round is resolved, so a double tap reuses it (O04). A second key is a second round -- a
    // table that genuinely orders "the same again" within a second must not lose it to a heuristic.
    const basket: Want[] = [{ key: 'salad', qty: 1 }]
    const [a, b] = await Promise.all([sendRound('rc-A4-k1', basket), sendRound('rc-A4-k2', basket)])
    expectStatus(a, 200)
    expectStatus(b, 200)
    expect(a.body.order_id).not.toBe(b.body.order_id)
    expect([a.body.duplicate, b.body.duplicate]).toEqual([false, false])
    for (const id of [a.body.order_id, b.body.order_id]) expect(linesOf(id)).toHaveLength(1)
    ORD.k1 = a.body.order_id
    ORD.k2 = b.body.order_id
  })

  step('O06 A3 basket changed after a timeout: same key refused, Modena never replayed', async () => {
    const sent: Want[] = [{ key: 'burger', qty: 1 }, { key: 'pasta', qty: 1, v: { Size: 'Regular' } }]
    const first = await sendRound('rc-A3', sent)
    expectStatus(first, 200)
    ORD.A3 = first.body.order_id
    const before = moneySnapshot()
    // The terminal never saw the answer. The waiter removes the Modena and adds a Salmon, and the
    // device re-sends under the SAME key.
    const edited: Want[] = [{ key: 'burger', qty: 1 }, { key: 'salmon', qty: 1 }]
    const resend = await sendRound('rc-A3', edited)
    expectStatus(resend, 409)
    expect(resend.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_BODY_MISMATCH', order_id: ORD.A3 })
    expect(JSON.stringify(resend.body.items)).toMatch(/Modena/)
    expect(moneySnapshot()).toEqual(before)
    expect(n(`SELECT 1 FROM order_lines WHERE tab_id = '${tabId}' AND menu_item_id = '${ITEM.salmon}'`)).toBe(0)
    // Sent as a NEW round (new key), it is exactly the edited basket -- and the Modena is still only
    // the one line the first send made, never a copy.
    const intentional = await sendRound('rc-A3-new', edited)
    expectStatus(intentional, 200)
    ORD.A3new = intentional.body.order_id
    expect(linesOf(ORD.A3new).map((l) => l.name_snapshot).join('|')).toMatch(/^Burger\|Grilled Salmon$/)
    expect(n(`SELECT 1 FROM order_lines l JOIN orders o ON o.id = l.order_id
               WHERE l.tab_id = '${tabId}' AND o.idempotency_key IN ('rc-A3', 'rc-A3-new') AND l.name_snapshot LIKE 'Modena%'`)).toBe(1)
  })

  step('O07 A3 original and edited send on one key at once: exactly one body lands', async () => {
    const original: Want[] = [{ key: 'chips', qty: 1 }, { key: 'pasta', qty: 1, v: { Size: 'Regular' } }]
    const edited: Want[] = [{ key: 'chips', qty: 1 }, { key: 'salmon', qty: 1 }]
    const [a, b] = await Promise.all([sendRound('rc-A3-race', original), sendRound('rc-A3-race', edited)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const won = a.status === 200 ? { res: a, wants: original } : { res: b, wants: edited }
    const lost = a.status === 200 ? b : a
    expect(lost.body.code).toBe('IDEMPOTENCY_KEY_BODY_MISMATCH')
    expect(lost.body.order_id).toBe(won.res.body.order_id)
    const rows = linesOf(won.res.body.order_id)
    expect(rows.map((r) => r.name_snapshot.split(' (')[0].split(' - ')[0])).toEqual(won.wants.map((w) => NAME[w.key]))
    expect(n(`SELECT 1 FROM orders WHERE idempotency_key = 'rc-A3-race'`)).toBe(1)
    ORD.race = won.res.body.order_id
  })

  step('O08 A5 a round while another is in flight: both land, nothing merged', async () => {
    const r1: Want[] = [{ key: 'wine', qty: 1, v: { Glass: 'Small' } }]
    const r2: Want[] = [{ key: 'cheesecake', qty: 1, note: 'candle' }]
    const [a, b] = await Promise.all([sendRound('rc-A5-1', r1), sendRound('rc-A5-2', r2)])
    expectStatus(a, 200)
    expectStatus(b, 200)
    expect(a.body.order_id).not.toBe(b.body.order_id)
    expect(linesOf(a.body.order_id).map((l) => l.name_snapshot)).toEqual([expect.stringMatching(/House Wine/)])
    expect(linesOf(b.body.order_id).map((l) => l.line_note)).toEqual(['candle'])
    ORD.A5a = a.body.order_id
    ORD.A5b = b.body.order_id
  })

  step('O09 H1-H3 variant validation: missing, invalid, base-0 refused before anything is written', async () => {
    const before = moneySnapshot()
    const missing = await sendRound('rc-H1', [{ key: 'ribeye', qty: 1 }])
    expectStatus(missing, 400)
    expect(missing.body.code).toBe('MENU_ITEM_VARIANT_REQUIRED')
    expect(missing.body.unavailableItems[0].groups).toEqual(['Doneness'])
    const invalid = await sendRound('rc-H2', [{ key: 'pasta', qty: 1, v: { Size: 'Huge' } }])
    expectStatus(invalid, 400)
    expect(invalid.body.code).toBe('MENU_ITEM_UNPRICEABLE_SELECTION')
    const unknownGroup = await sendRound('rc-H2b', [{ key: 'burger', qty: 1, v: { Colour: 'Red' } }])
    expectStatus(unknownGroup, 400)
    expect(unknownGroup.body.code).toBe('MENU_ITEM_UNPRICEABLE_SELECTION')
    // A base-0 item with no answer would be sold for N$0.
    const base0 = await sendRound('rc-H3', [{ key: 'pizza', qty: 1 }])
    expectStatus(base0, 400)
    expect(base0.body.code).toBe('MENU_ITEM_VARIANT_REQUIRED')
    expect(moneySnapshot()).toEqual(before)
    expect(n(`SELECT 1 FROM orders WHERE idempotency_key IN ('rc-H1', 'rc-H2', 'rc-H2b', 'rc-H3')`)).toBe(0)
  })

  const roundH: Want[] = [
    { key: 'pizza', qty: 1, note: 'extra basil', v: { Size: 'Large', Crust: 'Thin' } },
    { key: 'pasta', qty: 1, v: { Size: 'Regular', Sauce: 'Tomato' } },
    { key: 'pasta', qty: 2, note: 'one without parmesan', v: { Size: 'Large', Sauce: 'Cream' } },
  ]

  step('O10 H4-H6 two groups, two variants of one product, a variant with a note', async () => {
    const res = await sendRound('rc-H4', roundH)
    expectStatus(res, 200)
    ORD.H = res.body.order_id
    const [order] = sql(`SELECT total, items FROM orders WHERE id = '${ORD.H}'`)
    expect(cents(order.total)).toBe(14000 + 12000 + 31000)
    roundH.forEach((w, i) => {
      const item = order.items[i]
      expect({ i, total: cents(item.total), v: item.selectedVariants }).toEqual({ i, total: priceCents(w.key, w.v) * w.qty, v: w.v })
    })
    const rows = linesOf(ORD.H)
    expect(rows[0].name_snapshot).toMatch(/Large/)
    expect(rows[0].name_snapshot).toMatch(/Thin/)
    expect(rows[1].name_snapshot).toMatch(/Regular/)
    expect(rows[2].name_snapshot).toMatch(/Large/)
    expect(rows.map((r) => r.line_note)).toEqual(['extra basil', null, 'one without parmesan'])
    const f = await financials()
    expect(f.financials.orders[ORD.H].live_cents).toBe(57000)
  })

  step('O11 B1 unpaid cancel: voided at the station, changed, money down', async () => {
    const burger = lineAt(ORD.A, 1)
    const before = (await financials()).financials.orders[ORD.A]
    const res = await voidLines([burger], 'guest changed their mind')
    expectStatus(res, 200)
    expect(res.body).toMatchObject({ changed: true, refused: [], applied: [{ line_id: burger.id, action: 'voided' }] })
    expect(stateOf(burger.id).k).toBe('voided')
    expect(voidEvents(burger.id)).toBe(1)
    const after = (await financials()).financials.orders[ORD.A]
    expect(before.live_cents - after.live_cents).toBe(19700)
    expect(after.voided_cents - before.voided_cents).toBe(19700)
  })

  step('O12 B2 cancel applied but the answer lost: re-read shows it, a retry changes nothing', async () => {
    const lager = lineAt(ORD.A, 2)
    const token = mintToken('line_void')
    const first = await voidLines([lager], 'spilled', token)
    expectStatus(first, 200)
    expect(first.body.changed).toBe(true)
    const before = moneySnapshot()
    // The device never saw the 200. It retries with the SAME PIN authorization: spent, refused.
    const sameToken = await voidLines([lager], 'spilled', token)
    expectStatus(sameToken, 403)
    expect(sameToken.body.code).toBe('AUTHORIZATION_INVALID')
    // With a fresh PIN: answered, but nothing applied -- changed:false is what says "not by me".
    const fresh = await voidLines([lager], 'spilled')
    expectStatus(fresh, 200)
    expect(fresh.body).toMatchObject({ changed: false, applied: [], order_id: null })
    expect(fresh.body.refused).toEqual([{ line_id: lager.id, reason: 'window_closed' }])
    expect(moneySnapshot()).toEqual(before)
    expect(voidEvents(lager.id)).toBe(1)
    // The truth is on the re-read: the line is voided.
    const shown = ((await financials()).orders as Json[]).flatMap((o) => o.lines as Json[]).find((l) => l.id === lager.id)
    expect(shown?.is_voided).toBe(true)
  })

  step('O13 G1-G5/B6 station states then cancel: outstanding cancels, cooked/ready/collected refused', async () => {
    // There is NO 'preparing' line state: a line is outstanding -> cooked (station) -> ready (pass)
    // -> collected. 'preparing' exists only as an ORDER status and does not gate a line void.
    const wants: Want[] = [{ key: 'chips', qty: 1 }, { key: 'salad', qty: 1 }, { key: 'cheesecake', qty: 1 }, { key: 'espresso', qty: 1 }]
    const res = await sendRound('rc-G1', wants)
    expectStatus(res, 200)
    ORD.G = res.body.order_id
    const [chips, salad, cake, espresso] = linesOf(ORD.G)
    await bump(chips.id, 'kitchen', 'cooked')
    await bump(salad.id, 'kitchen', 'cooked')
    await bump(salad.id, 'kitchen', 'ready')
    await bump(cake.id, 'kitchen', 'cooked')
    await bump(cake.id, 'kitchen', 'ready')
    await bump(cake.id, 'kitchen', 'collected')
    const before = (await financials()).financials.orders[ORD.G]
    const v = await voidLines([chips, salad, cake, espresso], 'table left')
    expectStatus(v, 200)
    expect(v.body.applied).toEqual([{ line_id: espresso.id, action: 'voided' }])
    expect(v.body.refused).toEqual([
      { line_id: chips.id, reason: 'window_closed' },
      { line_id: salad.id, reason: 'window_closed' },
      { line_id: cake.id, reason: 'window_closed' },
    ])
    expect([stateOf(chips.id).k, stateOf(salad.id).k, stateOf(cake.id).k, stateOf(espresso.id).b]).toEqual(['cooked', 'ready', 'collected', 'voided'])
    for (const l of [chips, salad, cake]) expect(voidEvents(l.id)).toBe(0)
    // Only the espresso left the bill.
    const after = (await financials()).financials.orders[ORD.G]
    expect(before.live_cents - after.live_cents).toBe(2600)
    // A cook un-bumps the chips (undo): the window is the line's state now, not its history.
    await bump(chips.id, 'kitchen', 'outstanding')
    const again = await voidLines([chips], 'table left')
    expect(again.body.applied).toEqual([{ line_id: chips.id, action: 'voided' }])
    // A voided line cannot be bumped back from a station.
    const back = await call(stationLineState, `/api/station/order-lines/${chips.id}/state`, { params: { lineId: chips.id }, body: { station: 'kitchen', to_state: 'cooked' } })
    expect(back.status).toBe(409)
    expect(stateOf(chips.id).k).toBe('voided')
  })

  step('O14 H7-H8 variant cancel and variant reduction: the replacement keeps the variant', async () => {
    const [, regular, large] = linesOf(ORD.H)
    const res = await voidLines([{ id: regular.id }, { id: large.id, qty: 1 }], 'over-ordered')
    expectStatus(res, 200)
    expect(res.body.applied.map((a: Json) => a.action)).toEqual(['voided', 'replaced'])
    const replacementId = String(res.body.applied[1].new_line_id)
    ORD.Hamend = String(res.body.order_id)
    const [item] = sql(`SELECT o.items -> l.source_item_index AS item, l.name_snapshot, l.line_note, l.quantity
                          FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = '${replacementId}'`)
    expect(item.item.selectedVariants).toEqual({ Size: 'Large', Sauce: 'Cream' })
    expect(cents(item.item.total)).toBe(15500)
    expect(item.name_snapshot).toMatch(/Large/)
    expect({ note: item.line_note, qty: Number(item.quantity) }).toEqual({ note: 'one without parmesan', qty: 1 })
    expect([stateOf(regular.id).k, stateOf(large.id).k]).toEqual(['voided', 'voided'])
    const f = (await financials()).financials.orders
    expect(f[ORD.H].live_cents).toBe(14000) // the pizza is all that is left of that round
    expect(f[ORD.Hamend].live_cents).toBe(15500)
  })

  const allocIds: Record<string, string[]> = {}

  step('O15 B8/H9 partial payment: settled line refused, unsettled share voided with its line', async () => {
    const wants: Want[] = [{ key: 'ribeye', qty: 2, v: { Doneness: 'Rare' } }, { key: 'wine', qty: 2, v: { Glass: 'Large' } }]
    const res = await sendRound('rc-B8', wants)
    expectStatus(res, 200)
    ORD.B8 = res.body.order_id
    const [ribeye, wine] = linesOf(ORD.B8)
    const split = await allocate(ribeye.id, [['Guest A', 1], ['Guest B', 1]])
    expectStatus(split, 200)
    expect(split.body.line_total_cents).toBe(49000)
    allocIds.ribeye = (split.body.allocations as Json[]).map((a) => String(a.id))
    // Guest A pays for their steak (a variant line: charged the variant price).
    const paid = await settleAlloc([allocIds.ribeye[0]])
    expectStatus(paid, 200)
    expect(paid.body.applied).toEqual([{ allocation_id: allocIds.ribeye[0], amount_cents: 24500 }])
    // The half-paid line cannot be cancelled or reduced; nothing moves.
    const before = moneySnapshot()
    const v = await voidLines([ribeye], 'wrong steak')
    expect(v.body.refused).toEqual([{ line_id: ribeye.id, reason: 'line_settled' }])
    const r = await voidLines([{ id: ribeye.id, qty: 1 }], 'wrong steak')
    expect(r.body.refused).toEqual([{ line_id: ribeye.id, reason: 'line_settled' }])
    expect(moneySnapshot()).toEqual(before)
    expect(stateOf(ribeye.id).k).toBe('outstanding')
    // An UNSETTLED share goes with its line: voided in the same transaction, never chargeable.
    const w = await allocate(wine.id, [['Guest C', 2]])
    expectStatus(w, 200)
    allocIds.wine = (w.body.allocations as Json[]).map((a) => String(a.id))
    const vw = await voidLines([wine], 'corked')
    expect(vw.body.applied).toEqual([{ line_id: wine.id, action: 'voided' }])
    expect(sql(`SELECT void_reason FROM order_line_allocations WHERE id = '${allocIds.wine[0]}'`)[0].void_reason).toBe('line_voided_by_amendment')
    const late = await settleAlloc(allocIds.wine)
    expectStatus(late, 409)
    // line_voided is checked before the share's own voided_at; either way nothing is settled.
    expect(late.body.refused).toEqual([{ allocation_id: allocIds.wine[0], reason: 'line_voided' }])
    expect(n(`SELECT 1 FROM order_line_allocation_settlements WHERE order_line_allocation_id = '${allocIds.wine[0]}'`)).toBe(0)
  })

  step('O16 B7 paid order: void refused order_paid, kitchen untouched, no allocation on it', async () => {
    // A share on the ribeye, made while round A is still unpaid...
    const ribeyeA = lineAt(ORD.A, 3)
    const early = await allocate(ribeyeA.id, [['Guest D', 1]])
    expectStatus(early, 200)
    const earlyShare = String(early.body.allocations[0].id)
    const f = (await financials()).financials.orders
    const owed = f[ORD.A].outstanding_cents
    expect(owed).toBe(15500 + 24500) // round A less the voided burgers and lagers
    const settle = await call(settleTab, `/api/terminal/tabs/${tabId}/settle`, {
      params: { tabId }, body: { order_ids: [ORD.A], method: 'cash', amount: owed / 100 },
    })
    expectStatus(settle, 200)
    expect(sql(`SELECT payment_status FROM orders WHERE id = '${ORD.A}'`)[0].payment_status).toBe('paid')
    const pasta = lineAt(ORD.A, 0)
    const before = moneySnapshot()
    const v = await voidLines([pasta], 'too salty')
    expect(v.body).toMatchObject({ changed: false, applied: [], refused: [{ line_id: pasta.id, reason: 'order_paid' }] })
    expect(stateOf(pasta.id).k).toBe('outstanding')
    // A line on a PAID order is not split and paid a second time.
    const split = await allocate(pasta.id, [['Guest D', 1]])
    expectStatus(split, 409)
    expect(split.body.code).toBe('ORDER_PAID')
    // Nor is a line that was cancelled.
    const burger = lineAt(ORD.A, 1)
    const splitVoided = await allocate(burger.id, [['Guest D', 2]])
    expectStatus(splitVoided, 409)
    expect(splitVoided.body.code).toBe('LINE_VOIDED')
    // ...is not a second way to pay for the ribeye once the whole order is paid: the card is not
    // even asked for it, and settling it in cash is refused.
    const card = await call(prepareSplitPayment, `/api/terminal/tabs/${tabId}/prepare-split-payment`, {
      params: { tabId }, body: { allocation_ids: [earlyShare] },
    })
    expectStatus(card, 409)
    expect(card.body).toMatchObject({ code: 'ALLOCATION_NOT_PAYABLE', reasons: [{ allocation_id: earlyShare, reason: 'order_paid' }] })
    const cash = await settleAlloc([earlyShare])
    expectStatus(cash, 409)
    expect(cash.body.refused).toEqual([{ allocation_id: earlyShare, reason: 'order_paid' }])
    expect(moneySnapshot()).toEqual(before)
  })

  step('O17 B9 cancel then re-add: history kept, a new genuine line, no duplicate allocation', async () => {
    const wants: Want[] = [{ key: 'salmon', qty: 1, note: 'no sauce' }]
    const first = await sendRound('rc-B9-1', wants)
    expectStatus(first, 200)
    const [oldLine] = linesOf(first.body.order_id)
    const share = await allocate(oldLine.id, [['Guest E', 1]])
    expectStatus(share, 200)
    const oldAlloc = String(share.body.allocations[0].id)
    const v = await voidLines([oldLine], 'wrong table')
    expect(v.body.changed).toBe(true)
    const again = await sendRound('rc-B9-2', wants)
    expectStatus(again, 200)
    const [newLine] = linesOf(again.body.order_id)
    expect(newLine.id).not.toBe(oldLine.id)
    // The void is history: the old line, its event and its voided share stay exactly as they were.
    expect(stateOf(oldLine.id).k).toBe('voided')
    expect(voidEvents(oldLine.id)).toBe(1)
    expect(sql(`SELECT voided_at IS NOT NULL AS v FROM order_line_allocations WHERE id = '${oldAlloc}'`)[0].v).toBe(true)
    expect(stateOf(newLine.id).k).toBe('outstanding')
    expect(newLine.line_note).toBe('no sauce')
    // The new line starts with no share; one allocation makes exactly one live share for salmon.
    const newShare = await allocate(newLine.id, [['Guest E', 1]])
    expectStatus(newShare, 200)
    expect(n(`SELECT 1 FROM order_line_allocations a JOIN order_lines l ON l.id = a.order_line_id
               WHERE l.tab_id = '${tabId}' AND l.menu_item_id = '${ITEM.salmon}' AND a.voided_at IS NULL`)).toBe(1)
    // The kitchen board shows the new salmon and not the cancelled one.
    const board = await boardLineIds('kitchen')
    expect(board).toContain(newLine.id)
    expect(board).not.toContain(oldLine.id)
    ORD.B9 = again.body.order_id
    allocIds.salmon = [String(newShare.body.allocations[0].id)]
  })

  step('O18 G whole-order terminal cancel: lines voided, unsettled shares voided, stations told', async () => {
    const wants: Want[] = [{ key: 'burger', qty: 1 }, { key: 'chips', qty: 1 }, { key: 'salad', qty: 1 }]
    const res = await sendRound('rc-G-cancel', wants)
    expectStatus(res, 200)
    const orderId = res.body.order_id
    const [burger, chips, salad] = linesOf(orderId)
    await bump(chips.id, 'kitchen', 'cooked')
    await bump(salad.id, 'kitchen', 'cooked')
    await bump(salad.id, 'kitchen', 'ready')
    const share = await allocate(burger.id, [['Guest F', 1]])
    expectStatus(share, 200)
    const burgerAlloc = String(share.body.allocations[0].id)
    const told = broadcasts.length
    const cancel = await call(terminalOrderStatus, `/api/terminal/orders/${orderId}/status`, {
      method: 'PATCH', params: { orderId }, body: { status: 'cancelled', reason: 'walked out' },
    })
    expectStatus(cancel, 200)
    expect(cancel.body.outcome).toBe('cancelled')
    expect(sql(`SELECT status, payment_status FROM orders WHERE id = '${orderId}'`)[0]).toEqual({ status: 'cancelled', payment_status: 'cancelled' })
    // Recorded ruling (voidOutstandingOrderLines): outstanding AND cooked halves void; a half the
    // pass already passed (ready) is food made and stays -- and is named back to the caller.
    expect([stateOf(burger.id).k, stateOf(chips.id).k, stateOf(salad.id).k]).toEqual(['voided', 'voided', 'ready'])
    expect(cancel.body.lines_not_voided).toEqual([expect.objectContaining({ line_id: salad.id, kitchen_state: 'ready' })])
    // The burger's unpaid share went with it: nobody can be charged for a cancelled order.
    expect(sql(`SELECT voided_at IS NOT NULL AS v FROM order_line_allocations WHERE id = '${burgerAlloc}'`)[0].v).toBe(true)
    const late = await settleAlloc([burgerAlloc])
    expectStatus(late, 409)
    // Nor can the made-but-cancelled salad be split and paid for.
    const splitSalad = await allocate(salad.id, [['Guest F', 1]])
    expectStatus(splitSalad, 409)
    expect(splitSalad.body.code).toBe('ORDER_CANCELLED')
    // A share that slipped in anyway (written concurrently with the cancel, bypassing the route's
    // read) is refused by the settlement function itself.
    const slipped = randomUUID()
    sqlExec(`INSERT INTO public.order_line_allocations (id, restaurant_id, order_id, order_line_id, tab_id, allocated_to, quantity_allocated, amount_cents, created_by_actor_kind)
             VALUES ('${slipped}', '${R}', '${orderId}', '${salad.id}', '${tabId}', 'Guest F', 1, 7200, 'terminal');`)
    const slippedSettle = await settleAlloc([slipped])
    expectStatus(slippedSettle, 409)
    expect(slippedSettle.body.refused).toEqual([{ allocation_id: slipped, reason: 'order_cancelled' }])
    sqlExec(`UPDATE public.order_line_allocations SET voided_at = now(), void_reason = 'chaos_cleanup' WHERE id = '${slipped}';`)
    // The station screens were told.
    expect(broadcasts.length).toBeGreaterThan(told)
    const board = await boardLineIds('kitchen')
    expect(board).not.toContain(burger.id)
    expect(board).not.toContain(chips.id)
    ORD.Gcancel = orderId
  })

  step('O19 G6 dashboard cancel: the station screens update and are told', async () => {
    const wants: Want[] = [{ key: 'cheesecake', qty: 1 }, { key: 'lager', qty: 1 }]
    const res = await sendRound('rc-G6', wants)
    expectStatus(res, 200)
    const orderId = res.body.order_id
    const [cake, lager] = linesOf(orderId)
    expect(await boardLineIds('kitchen')).toContain(cake.id)
    expect(await boardLineIds('bar')).toContain(lager.id)
    const told = broadcasts.length
    const cancel = await call(dashboardOrderStatus, `/api/orders/${orderId}/status`, {
      method: 'PATCH', params: { orderId }, body: { status: 'cancelled', cancellation_reason: 'duplicate ticket' }, auth: 'Bearer chaos-manager',
    })
    expectStatus(cancel, 200)
    expect(cancel.body).toMatchObject({ success: true, lines_voided: 2, lines_not_voided: [], lines_void_failed: false })
    expect([stateOf(cake.id).k, stateOf(lager.id).b]).toEqual(['voided', 'voided'])
    expect(await boardLineIds('kitchen')).not.toContain(cake.id)
    expect(await boardLineIds('bar')).not.toContain(lager.id)
    expect(broadcasts.length).toBeGreaterThan(told)
    // And the terminal's own view of the tab no longer owes it.
    expect((await financials()).financials.orders[orderId]?.live_cents ?? 0).toBe(0)
  })

  step('O20 G7 payment never moves kitchen state', async () => {
    const snapshot = () => sql(`SELECT id, kitchen_state, bar_state FROM order_lines WHERE tab_id = '${tabId}' ORDER BY id`)
    const before = snapshot()
    // A share paid by item, and a whole round paid in cash.
    const paid = await settleAlloc(allocIds.salmon)
    expectStatus(paid, 200)
    const owed = (await financials()).financials.orders[ORD.A5b].outstanding_cents
    const settle = await call(settleTab, `/api/terminal/tabs/${tabId}/settle`, {
      params: { tabId }, body: { order_ids: [ORD.A5b], method: 'cash', amount: owed / 100 },
    })
    expectStatus(settle, 200)
    expect(snapshot()).toEqual(before)
    expect(stateOf(lineAt(ORD.A5b, 0).id).k).toBe('outstanding')
  })

  step('O21 M POS order: replayed key, keys at once, edited key', async () => {
    const pos = (key: string, qty: number) =>
      call(postPosOrder, '/api/terminal/orders', {
        body: { restaurantId: R, items: roundItems([{ key: 'burger', qty }]), subtotal: 1, total: 1 },
        headers: { 'x-idempotency-key': key, 'x-flashtap-variant-protocol': '1' },
      })
    const first = await pos('rc-POS-1', 1)
    expectStatus(first, 200)
    const replay = await pos('rc-POS-1', 1)
    expectStatus(replay, 200)
    expect(replay.body).toMatchObject({ duplicate: true, orderId: first.body.orderId })
    const edited = await pos('rc-POS-1', 2)
    expectStatus(edited, 409)
    expect(edited.body.code).toBe('IDEMPOTENCY_KEY_BODY_MISMATCH')
    const [a, b] = await Promise.all([pos('rc-POS-2', 1), pos('rc-POS-2', 1)])
    expectStatus(a, 200)
    expectStatus(b, 200)
    expect(a.body.orderId).toBe(b.body.orderId)
    expect([a.body.duplicate, b.body.duplicate].sort()).toEqual([false, true])
    expect(n(`SELECT 1 FROM orders WHERE idempotency_key IN ('rc-POS-1', 'rc-POS-2')`)).toBe(2)
    expect(cents(sql(`SELECT total FROM orders WHERE id = '${first.body.orderId}'`)[0].total)).toBe(9850)
  })

  step('O22 M settle-allocations double-tap: one settlement', async () => {
    const [pizza] = linesOf(ORD.H)
    const share = await allocate(pizza.id, [['Guest G', 1]])
    expectStatus(share, 200)
    const id = String(share.body.allocations[0].id)
    const [a, b] = await Promise.all([settleAlloc([id]), settleAlloc([id])])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(n(`SELECT 1 FROM order_line_allocation_settlements WHERE order_line_allocation_id = '${id}'`)).toBe(1)
    const won = a.status === 200 ? a : b
    expect(won.body.applied).toEqual([{ allocation_id: id, amount_cents: 14000 }])
  })

  step('O23 H10/M invoice: two creates at once make one invoice, variant lines named and priced', async () => {
    // Pay what is still owed first, so the invoice bills a settled tab.
    const f = (await financials()).financials.orders as Record<string, Json>
    const owing = Object.entries(f).filter(([, o]) => o.outstanding_cents > 0).map(([id]) => id)
    const owed = owing.reduce((s, id) => s + f[id].outstanding_cents, 0)
    const settle = await call(settleTab, `/api/terminal/tabs/${tabId}/settle`, {
      params: { tabId }, body: { order_ids: owing, method: 'cash', amount: owed / 100 },
    })
    expectStatus(settle, 200)
    const body = { tab_id: tabId, restaurant_id: R, bill_to: { name: 'RC Orders Ltd', address: '2 Test Street' } }
    // Pinned: each create's INSERT waits for the other's, so both have passed the "already
    // invoiced?" read before either document exists -- the double-click that issued two.
    const { result: [a, b], arrived } = await withHold(
      (m, path) => m === 'POST' && path.endsWith('/rest/v1/business_documents'),
      2,
      () => Promise.all([
        call(invoiceFromOrder, '/api/admin/documents/from-order', { body, auth: 'Bearer chaos-manager' }),
        call(invoiceFromOrder, '/api/admin/documents/from-order', { body, auth: 'Bearer chaos-manager' }),
      ]),
    )
    expect(arrived).toBe(2)
    // Never two. At most one is issued; the other is refused (or, if each saw the other, both
    // withdrew and the retry below issues exactly one).
    const liveInvoices = () => sql(`SELECT id, total FROM business_documents WHERE restaurant_id = '${R}'
                                      AND document_type = 'invoice' AND tab_id = '${tabId}' AND status <> 'void'`)
    expect(liveInvoices().length).toBeLessThanOrEqual(1)
    expect([a.status, b.status].filter((s) => s === 201).length).toBe(liveInvoices().length)
    for (const r of [a, b].filter((x) => x.status !== 201)) {
      expect({ status: r.status, code: r.body.code }).toEqual({ status: 409, code: expect.stringMatching(/^INVOICE_(ALREADY_EXISTS|CREATE_CONFLICT)$/) })
    }
    if (liveInvoices().length === 0) {
      expectStatus(await call(invoiceFromOrder, '/api/admin/documents/from-order', { body, auth: 'Bearer chaos-manager' }), 201)
    }
    const again = await call(invoiceFromOrder, '/api/admin/documents/from-order', { body, auth: 'Bearer chaos-manager' })
    expect({ status: again.status, code: again.body.code }).toEqual({ status: 409, code: 'INVOICE_ALREADY_EXISTS' })
    const docs = liveInvoices()
    expect(docs).toHaveLength(1)
    const live = (await financials()).financials.tab.live_cents
    expect(cents(docs[0].total)).toBe(live)
    const docLines = sql(`SELECT li->>'description' AS description, (li->>'line_total')::numeric AS line_total
                            FROM business_documents d, jsonb_array_elements(d.line_items) li WHERE d.id = '${docs[0].id}'`)
    const pizza = docLines.find((l) => /Pizza/.test(String(l.description)))
    expect(pizza).toBeTruthy()
    expect(String(pizza!.description)).toMatch(/Large/)
    expect(cents(pizza!.line_total)).toBe(14000)
    // The reduced Large pasta is billed once, at one plate.
    const pastaLarge = docLines.filter((l) => /Modena/.test(String(l.description)) && /Large/.test(String(l.description)))
    expect(pastaLarge.reduce((s, l) => s + cents(l.line_total), 0)).toBe(15500 + 15500) // round A's plate + the amended one
  })

  step('O24 final: no duplicate lines anywhere, every item has exactly one line', async () => {
    expect(sql(`SELECT order_id, source_item_index FROM order_lines GROUP BY 1, 2 HAVING count(*) > 1`)).toEqual([])
    const unmatched = sql(`SELECT o.id, i.ord - 1 AS idx FROM orders o, jsonb_array_elements(o.items) WITH ORDINALITY i(item, ord)
                             WHERE o.tab_id = '${tabId}' AND NOT EXISTS (
                               SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.source_item_index = i.ord - 1)`)
    expect(unmatched).toEqual([])
    // No live share on a voided line or a cancelled order.
    expect(sql(`SELECT a.id FROM order_line_allocations a
                  JOIN order_lines l ON l.id = a.order_line_id JOIN orders o ON o.id = a.order_id
                 WHERE a.tab_id = '${tabId}' AND a.voided_at IS NULL AND a.settled_at IS NULL
                   AND (o.status = 'cancelled' OR (coalesce(l.kitchen_state, 'voided') = 'voided' AND coalesce(l.bar_state, 'voided') = 'voided'))`)).toEqual([])
  })
})
