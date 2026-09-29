/**
 * THE CHAOS TAB -- one long, deliberately messy table, driven through the REAL route handlers
 * against a REAL PostgREST and a REAL Postgres built from the production migration set.
 *
 * Launched only by `node supabase/tests/chaos-e2e.mjs` (the file name does not match jest's
 * testMatch, so the offline suite never picks it up). That script builds the database, starts
 * PostgREST, opens a 127.0.0.1 proxy and passes its URL here; see its header for what is and is not
 * real, and for the safety rules.
 *
 * Every checkpoint asserts SERVER state -- rows read straight out of Postgres with psql, and the
 * JSON the read routes return -- never a client's idea of what happened. The step titles are the
 * checkpoint names the mutation runner matches on; renaming one means updating MUTATIONS there.
 *
 * Money is compared in integer cents throughout. The expected figures come from an independent
 * oracle (PRICE below and the ledger of what the waiter did), not from the projection under test.
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
 * Every outbound request goes through here. Non-loopback hosts throw -- no staging, no gateway, no
 * email provider can be reached even by a code path the mocks forgot. `holdClaims` implements the
 * double-tap barrier for C13: the orders claim PATCH of N concurrent settles is held until all N
 * have arrived, so both requests have passed every pre-check before either writes.
 */
const realFetch = globalThis.fetch
const postgrestErrors: string[] = []
let claimBarrier: { expected: number; waiting: Array<() => void>; timer: NodeJS.Timeout | null } | null = null
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname !== '127.0.0.1') {
    throw new Error(`chaos: refused a request to ${url.origin} -- only the loopback proxy may be reached`)
  }
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const body = typeof init?.body === 'string' ? init.body : ''
  if (
    claimBarrier &&
    method === 'PATCH' &&
    url.pathname.endsWith('/rest/v1/orders') &&
    body.includes('"payment_status":"paid"')
  ) {
    const barrier = claimBarrier
    await new Promise<void>((release) => {
      barrier.waiting.push(release)
      if (barrier.waiting.length >= barrier.expected) {
        if (barrier.timer) clearTimeout(barrier.timer)
        barrier.waiting.splice(0).forEach((r) => r())
      } else if (!barrier.timer) {
        barrier.timer = setTimeout(() => barrier.waiting.splice(0).forEach((r) => r()), 4000)
      }
    })
  }
  const res = await realFetch(input as RequestInfo, init)
  if (res.status >= 400) {
    // Every refusal PostgREST gives a route is visible in the run log, with the query that caused it.
    const text = await res.clone().text()
    postgrestErrors.push(`${method} ${url.pathname}${url.search} -> ${res.status} ${text.slice(0, 400)}`)
    console.warn(`[chaos] PostgREST ${res.status} for ${method} ${decodeURIComponent(url.pathname + url.search).slice(0, 900)}: ${text.slice(0, 400)}`)
  }
  return res
}) as typeof fetch

// ------------------------------------------------------------------------------------------------
// FIXTURE IDS (supabase/tests/chaos/seed.sql)
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
} as const
type ItemKey = keyof typeof ITEM
const NAME: Record<ItemKey, string> = {
  pasta: 'Modena Pasta', ribeye: 'Ribeye', burger: 'Burger', chips: 'Chips', salad: 'Caesar Salad',
  cheesecake: 'Cheesecake', lager: 'Lager', wine: 'House Wine', espresso: 'Espresso',
}
const STATION: Record<ItemKey, 'kitchen' | 'bar'> = {
  pasta: 'kitchen', ribeye: 'kitchen', burger: 'kitchen', chips: 'kitchen', salad: 'kitchen',
  cheesecake: 'kitchen', lager: 'bar', wine: 'bar', espresso: 'bar',
}

/** THE ORACLE: unit price in cents for an item + selection, written from the menu, not the code. */
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
  }
}

// ------------------------------------------------------------------------------------------------
// MOCKS -- only the edges that cannot run here. Each is named in chaos-e2e.mjs's header.
// ------------------------------------------------------------------------------------------------
jest.mock('@/lib/terminal-auth', () => ({
  // jose is ESM-only and cannot load under ts-jest. The header is still REQUIRED, and the claims
  // are those a real activation of the seeded terminal would carry.
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
  // A faithful copy of the real one: the terminal row is read from the database.
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
jest.mock('@/lib/stations/realtime-invalidate', () => ({
  ...jest.requireActual('@/lib/stations/realtime-invalidate'),
  broadcastLineChanged: async () => undefined,
}))
jest.mock('@/lib/payments/finatic-restaurant-credentials', () => ({
  ...jest.requireActual('@/lib/payments/finatic-restaurant-credentials'),
  getRestaurantFinaticCredentials: async () => ({ merchantNo: 'CHAOS-MERCHANT', storeNo: 'CHAOS-STORE' }),
}))
/** The simulated gateway: what Finatic's order.query would report for the charged reference. */
const gateway: { paid: boolean; amountMajor: number | null; transactionId: string; queries: string[] } = {
  paid: false, amountMajor: null, transactionId: 'CHAOS-TXN-1', queries: [],
}
jest.mock('@/lib/payments/query-finatic-order-paid', () => ({
  ...jest.requireActual('@/lib/payments/query-finatic-order-paid'),
  queryFinaticOrderPaid: async (p: { merchantOrderNo: string }) => {
    gateway.queries.push(p.merchantOrderNo)
    return {
      paid: gateway.paid,
      statusRecognised: true,
      merchantOrderNo: p.merchantOrderNo,
      status: gateway.paid ? 'SUCCESS' : 'PENDING',
      transactionId: gateway.paid ? gateway.transactionId : null,
      amount: gateway.amountMajor,
      raw: { simulated: true },
    }
  },
}))
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  ...jest.requireActual('@/lib/supabase/admin-restaurant-auth'),
  // No GoTrue here. The dashboard caller is the seeded manager; membership and permission are
  // still checked by the real helpers against restaurant_users.
  getUserFromRequest: async (req: Request) => {
    if (req.headers.get('authorization') !== 'Bearer chaos-manager') throw new Error('Missing authorization')
    return { id: 'c4a05000-0000-4000-8000-000000005001', email: 'manager@chaos.invalid' }
  },
}))

import { POST as openTable } from '@/app/api/terminal/tables/[tableId]/open/route'
import { GET as getTables } from '@/app/api/terminal/tables/route'
import { POST as postRound } from '@/app/api/terminal/rounds/route'
import { GET as getLines } from '@/app/api/terminal/tabs/[tabId]/lines/route'
import { POST as amendTab } from '@/app/api/terminal/tabs/[tabId]/amend/route'
import { POST as allocateLine } from '@/app/api/terminal/tabs/[tabId]/lines/[lineId]/allocate/route'
import { POST as settleAllocations } from '@/app/api/terminal/tabs/[tabId]/settle-allocations/route'
import { POST as settleTab } from '@/app/api/terminal/tabs/[tabId]/settle/route'
import { POST as preparePayment } from '@/app/api/terminal/orders/[orderId]/prepare-payment/route'
import { POST as verifyPayment } from '@/app/api/terminal/orders/[orderId]/verify-payment/route'
import { PATCH as patchOrderStatus } from '@/app/api/terminal/orders/[orderId]/status/route'
import { POST as stationLineState } from '@/app/api/station/order-lines/[lineId]/state/route'
import { GET as orderHistory } from '@/app/api/orders/history/route'
import { POST as invoiceFromOrder } from '@/app/api/admin/documents/from-order/route'

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
const cents = (major: unknown) => Math.round(Number(major) * 100)

type Json = Record<string, any>
async function call(
  handler: (req: Request, ctx: any) => Promise<Response>,
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string>; auth?: string } = {},
): Promise<{ status: number; body: Json }> {
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

/** A status check whose failure shows the route's own answer, not just the number. */
function expectStatus(res: { status: number; body: Json }, status: number) {
  if (res.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 1500)}`)
  }
}

/** A manager PIN authorization, written exactly as app/api/terminal/authorize writes one. */
function mintToken(purpose: 'service_session' | 'line_void' | 'cash_settlement', userId = MANAGER): string {
  const id = randomUUID()
  sqlExec(`INSERT INTO public.privileged_authorization_tokens (id, user_id, restaurant_id, terminal_id, purpose, nonce, ttl_seconds, expires_at)
           VALUES ('${id}', '${userId}', '${R}', '${TERM}', '${purpose}', '${randomUUID()}', 90, now() + interval '90 seconds');`)
  return id
}

// ------------------------------------------------------------------------------------------------
// THE WAITER'S OWN RECORD -- what was asked for, independent of anything the server computes.
// ------------------------------------------------------------------------------------------------
type Want = { key: ItemKey; qty: number; note?: string; v?: Record<string, string> }
type Line = { id: string; order_id: string; key: ItemKey; qty: number; note: string | null; v: Record<string, string>; unitCents: number; totalCents: number; state: 'live' | 'voided' }
const lines: Line[] = []
const rounds: Record<string, { key: string; orderId: string; orderNumber: number; wants: Want[] }> = {}

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

async function sendRound(key: string, wants: Want[]) {
  return call(postRound, '/api/terminal/rounds', {
    body: { tab_id: tabId, items: roundItems(wants), subtotal: 1, total: 1 },
    headers: { 'x-idempotency-key': key, 'x-flashtap-variant-protocol': '1' },
  })
}

/** Record a round the server accepted, reading its lines back from Postgres. */
function recordRound(label: string, key: string, orderId: string, orderNumber: number, wants: Want[]) {
  const rows = sql<{ id: string; source_item_index: number; quantity: string; line_note: string | null }>(
    `SELECT id, source_item_index, quantity, line_note FROM order_lines WHERE order_id = '${orderId}' ORDER BY source_item_index`,
  )
  expect(rows).toHaveLength(wants.length)
  rows.forEach((row, i) => {
    const w = wants[i]
    const unit = priceCents(w.key, w.v)
    lines.push({
      id: row.id, order_id: orderId, key: w.key, qty: w.qty, note: w.note ?? null, v: w.v ?? {},
      unitCents: unit, totalCents: unit * w.qty, state: 'live',
    })
  })
  rounds[label] = { key, orderId, orderNumber, wants }
}

const liveCents = () => lines.filter((l) => l.state === 'live').reduce((s, l) => s + l.totalCents, 0)
const lineOf = (pred: (l: Line) => boolean) => {
  const hit = lines.filter(pred)
  if (hit.length !== 1) throw new Error(`oracle: expected one matching line, found ${hit.length}`)
  return hit[0]
}

/** Every cent the venue has taken, from each money table, independently of the projection. */
function ledger() {
  const alloc = sql<{ c: number }>(
    `SELECT coalesce(sum(s.amount_cents), 0)::int AS c FROM order_line_allocation_settlements s WHERE s.tab_id = '${tabId}'`,
  )[0].c
  const cash = sql<{ c: number }>(
    `SELECT coalesce(sum(round(amount * 100)), 0)::int AS c FROM payments WHERE tab_id = '${tabId}' AND status = 'completed'`,
  )[0].c
  const card = sql<{ c: number }>(
    `SELECT coalesce(sum(round(amount * 100)), 0)::int AS c FROM payment_events
       WHERE restaurant_id = '${R}' AND event_type = 'sale'
         AND order_ids && ARRAY(SELECT id FROM orders WHERE tab_id = '${tabId}')`,
  )[0].c
  return { alloc, cash, card, total: alloc + cash + card }
}
let paidOracle = 0 // cents the customer has handed over, by the waiter's count

async function financials() {
  const res = await call(getLines, `/api/terminal/tabs/${tabId}/lines`, { method: 'GET', params: { tabId } })
  expectStatus(res, 200)
  return res
}
async function tableRow() {
  const res = await call(getTables, '/api/terminal/tables', { method: 'GET' })
  expectStatus(res, 200)
  return (res.body.tables as Json[]).find((t) => t.id === TABLE)
}

/** Terminal lines (C2), tables (C2) and the oracle agree on live / paid / outstanding. */
async function assertFigures(label: string) {
  const live = liveCents()
  const outstanding = live - paidOracle
  const f = (await financials()).body
  expect({ label, live: f.financials.tab.live_cents, paid: f.financials.tab.paid_cents, outstanding: f.financials.tab.outstanding_cents })
    .toEqual({ label, live, paid: paidOracle, outstanding })
  expect(cents(f.tab.total)).toBe(live)
  const t = await tableRow()
  expect({ label, unpaid: cents(t?.tab?.unpaid_total), outstanding: t?.tab?.financials?.outstanding_cents })
    .toEqual({ label, unpaid: outstanding, outstanding })
  // Every cent the projection calls paid is a cent some money table recorded.
  expect({ label, ledger: ledger().total }).toEqual({ label, ledger: paidOracle })
}

// ------------------------------------------------------------------------------------------------
// THE SCENARIO
// ------------------------------------------------------------------------------------------------
let tabId = ''
let broken: string | null = null
function step(title: string, fn: () => Promise<void>) {
  test(title, async () => {
    if (broken) throw new Error(`not run: an earlier checkpoint failed (${broken})`)
    // Set before, cleared after: a jest TIMEOUT never reaches a catch block.
    broken = title
    await fn()
    broken = null
  }, 60_000)
}

const allocationIdsPaidByItem: string[] = []
let settledPaymentRef = ''
let cardLeadOrderId = ''
let cardMerchantOrderNo = ''
let cardChargeCents = 0
const amendReplay: { voidLineId: string; reduceLineId: string } = { voidLineId: '', reduceLineId: '' }
let cashSettledOrderIds: string[] = []
let cashSettleCents = 0

describe('chaos tab lifecycle', () => {
  step('C01 open the tab', async () => {
    const res = await call(openTable, `/api/terminal/tables/${TABLE}/open`, {
      params: { tableId: TABLE },
      body: { user_id: WAITER, authorization_token_id: mintToken('service_session', WAITER), customer_name: 'Chaos party of six' },
    })
    expectStatus(res, 200)
    tabId = res.body.tab.id
    const [tab] = sql(`SELECT status, table_id, opened_by_user_id FROM tabs WHERE id = '${tabId}'`)
    expect(tab).toEqual({ status: 'open', table_id: TABLE, opened_by_user_id: WAITER })
    expect(sql(`SELECT status FROM restaurant_tables WHERE id = '${TABLE}'`)[0].status).toBe('occupied')
    expect(sql(`SELECT count(*)::int AS n FROM tabs WHERE table_id = '${TABLE}' AND status IN ('open','ready_to_pay')`)[0].n).toBe(1)
  })

  const round1: Want[] = [
    { key: 'pasta', qty: 2, note: 'one without parmesan', v: { Size: 'Large', Sauce: 'Cream' } },
    { key: 'ribeye', qty: 1, note: 'sauce on the side', v: { Doneness: 'Medium' } },
    { key: 'lager', qty: 3, note: 'ice cold' },
    { key: 'wine', qty: 1, v: { Glass: 'Large' } },
    { key: 'chips', qty: 2, note: 'extra salt' },
  ]

  step('C02 first round: variants, notes and server prices persisted', async () => {
    const res = await sendRound('chaos-K1', round1)
    expectStatus(res, 200)
    expect(res.body).toMatchObject({ success: true, duplicate: false, lines_written: true, line_count: 5 })
    recordRound('R1', 'chaos-K1', res.body.order_id, res.body.order_number, round1)

    const [order] = sql(`SELECT total, items, payment_status, status, channel, idempotency_key FROM orders WHERE id = '${res.body.order_id}'`)
    expect(order.payment_status).toBe('pending')
    expect(order.idempotency_key).toBe('chaos-K1')
    // The client said N$1 for everything. The server repriced every line from the menu.
    const expectedTotal = round1.reduce((s, w) => s + priceCents(w.key, w.v) * w.qty, 0)
    expect(expectedTotal).toBe(78900)
    expect(cents(order.total)).toBe(expectedTotal)
    round1.forEach((w, i) => {
      const item = order.items[i]
      expect({ i, id: item.menuItemId, q: Number(item.quantity), total: cents(item.total), v: item.selectedVariants ?? null })
        .toEqual({ i, id: ITEM[w.key], q: w.qty, total: priceCents(w.key, w.v) * w.qty, v: w.v ?? null })
    })
    // The Large pasta is priced from its option, never from the N$120 base.
    expect(cents(order.items[0].unitPrice)).toBe(15500)

    const rows = sql(`SELECT source_item_index, name_snapshot, quantity, line_note, route_to, kitchen_state, bar_state
                        FROM order_lines WHERE order_id = '${res.body.order_id}' ORDER BY source_item_index`)
    rows.forEach((r, i) => {
      const w = round1[i]
      expect({ i, note: r.line_note, qty: Number(r.quantity), route: r.route_to })
        .toEqual({ i, note: w.note ?? null, qty: w.qty, route: STATION[w.key] })
      expect(r.name_snapshot).toContain(NAME[w.key])
      expect(STATION[w.key] === 'kitchen' ? r.kitchen_state : r.bar_state).toBe('outstanding')
    })
    // The variant reaches the name the kitchen reads.
    expect(rows[0].name_snapshot).toMatch(/Large/)
    expect(rows[1].name_snapshot).toMatch(/Medium/)
    await assertFigures('after round 1')
  })

  step('C03 pay about half by item: balance reduced by exactly that', async () => {
    const pasta = lineOf((l) => l.key === 'pasta' && l.order_id === rounds.R1.orderId)
    const lager = lineOf((l) => l.key === 'lager' && l.order_id === rounds.R1.orderId)
    for (const l of [pasta, lager]) {
      const res = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${l.id}/allocate`, {
        params: { tabId, lineId: l.id },
        body: { shares: [{ allocated_to: 'Guest A', quantity_allocated: l.qty }] },
      })
      expectStatus(res, 200)
      expect(res.body.line_total_cents).toBe(l.totalCents)
      allocationIdsPaidByItem.push(...(res.body.allocations as Json[]).map((a) => String(a.id)))
    }
    const before = (await financials()).body.financials.tab.outstanding_cents
    const res = await call(settleAllocations, `/api/terminal/tabs/${tabId}/settle-allocations`, {
      params: { tabId },
      body: { allocation_ids: allocationIdsPaidByItem, method: 'cash' },
    })
    expectStatus(res, 200)
    const taken = pasta.totalCents + lager.totalCents
    expect(taken).toBe(40600) // 406 of 789: "about half"
    expect((res.body.applied as Json[]).reduce((s, a) => s + Number(a.amount_cents), 0)).toBe(taken)
    expect(res.body.completed_order_ids).toEqual([]) // the order is only part-paid
    paidOracle += taken

    const settlements = sql(`SELECT amount_cents, method FROM order_line_allocation_settlements WHERE tab_id = '${tabId}'`)
    expect(settlements.map((s) => s.amount_cents).sort()).toEqual([lager.totalCents, pasta.totalCents].sort())
    expect(sql(`SELECT payment_status FROM orders WHERE id = '${rounds.R1.orderId}'`)[0].payment_status).toBe('pending')
    const after = (await financials()).body
    expect(before - after.financials.tab.outstanding_cents).toBe(taken)
    expect(after.financials.orders[rounds.R1.orderId]).toMatchObject({ live_cents: 78900, paid_cents: taken, outstanding_cents: 78900 - taken })
    // Paying for the pasta did not cook it.
    expect(sql(`SELECT kitchen_state FROM order_lines WHERE id = '${pasta.id}'`)[0].kitchen_state).toBe('outstanding')
    await assertFigures('after the first partial payment')
  })

  step('C04 replay item payment: nothing charged twice', async () => {
    const res = await call(settleAllocations, `/api/terminal/tabs/${tabId}/settle-allocations`, {
      params: { tabId },
      body: { allocation_ids: allocationIdsPaidByItem, method: 'cash' },
    })
    expectStatus(res, 409)
    expect(res.body.code).toBe('NOTHING_SETTLED')
    expect((res.body.refused as Json[]).map((r) => r.reason)).toEqual(['already_settled', 'already_settled'])
    expect(sql(`SELECT count(*)::int AS n FROM order_line_allocation_settlements WHERE tab_id = '${tabId}'`)[0].n).toBe(2)
    // Re-splitting a paid line is refused too, so it cannot be paid a second way.
    const pasta = lineOf((l) => l.key === 'pasta' && l.order_id === rounds.R1.orderId)
    const resplit = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${pasta.id}/allocate`, {
      params: { tabId, lineId: pasta.id },
      body: { shares: [{ allocated_to: 'Guest B', quantity_allocated: 2 }] },
    })
    expectStatus(resplit, 409)
    expect(resplit.body.code).toBe('ALREADY_SETTLED')
    await assertFigures('after replaying the item payment')
  })

  const round2: Want[] = [
    { key: 'burger', qty: 2, note: 'no onion' },
    { key: 'salad', qty: 1, note: 'dressing on the side' },
    { key: 'espresso', qty: 2, note: 'after mains' },
    { key: 'wine', qty: 2, note: 'for the ladies', v: { Glass: 'Small' } },
  ]
  const round3: Want[] = [
    { key: 'pasta', qty: 1, note: 'kid portion, mild', v: { Size: 'Regular', Sauce: 'Tomato' } },
    { key: 'ribeye', qty: 2, note: 'rare means rare', v: { Doneness: 'Rare' } },
    { key: 'chips', qty: 1, note: 'well done' },
  ]
  const round4: Want[] = [
    { key: 'cheesecake', qty: 3, note: 'birthday candle on one' },
    { key: 'lager', qty: 2 },
    { key: 'espresso', qty: 1, note: 'double shot' },
  ]

  step('C05 keep ordering: three more rounds, ten items; the kitchen cooks', async () => {
    for (const [label, key, wants] of [['R2', 'chaos-K2', round2], ['R3', 'chaos-K3', round3], ['R4', 'chaos-K4', round4]] as const) {
      const res = await sendRound(key, wants as Want[])
      expectStatus(res, 200)
      expect(res.body.duplicate).toBe(false)
      recordRound(label, key, res.body.order_id, res.body.order_number, wants as Want[])
    }
    expect(Object.keys(rounds)).toHaveLength(4)
    expect(sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}'`)[0].n).toBe(4)
    expect(sql(`SELECT count(*)::int AS n FROM order_lines WHERE tab_id = '${tabId}'`)[0].n).toBe(15)

    // The kitchen cooks round 1's ribeye; the bar pours and hands over round 1's lagers.
    const ribeye = lineOf((l) => l.key === 'ribeye' && l.order_id === rounds.R1.orderId)
    const cook = await call(stationLineState, `/api/station/order-lines/${ribeye.id}/state`, {
      params: { lineId: ribeye.id }, body: { station: 'kitchen', to_state: 'cooked' },
    })
    expectStatus(cook, 200)
    const lager = lineOf((l) => l.key === 'lager' && l.order_id === rounds.R1.orderId)
    for (const to of ['ready', 'collected']) {
      const r = await call(stationLineState, `/api/station/order-lines/${lager.id}/state`, {
        params: { lineId: lager.id }, body: { station: 'bar', to_state: to },
      })
      expectStatus(r, 200)
    }
    expect(sql(`SELECT kitchen_state FROM order_lines WHERE id = '${ribeye.id}'`)[0].kitchen_state).toBe('cooked')
    expect(sql(`SELECT bar_state FROM order_lines WHERE id = '${lager.id}'`)[0].bar_state).toBe('collected')
    await assertFigures('after rounds 2-4')
  })

  async function voidLines(targets: Line[], reason: string) {
    return call(amendTab, `/api/terminal/tabs/${tabId}/amend`, {
      params: { tabId },
      body: {
        amendments: targets.map((l) => ({ line_id: l.id, new_quantity: 0 })),
        staff_user_id: MANAGER,
        authorization_token_id: mintToken('line_void'),
        void_reason: reason,
      },
    })
  }
  function expectVoidedOnServer(l: Line) {
    const [row] = sql(`SELECT kitchen_state, bar_state FROM order_lines WHERE id = '${l.id}'`)
    expect({ line: l.id, state: STATION[l.key] === 'kitchen' ? row.kitchen_state : row.bar_state }).toEqual({ line: l.id, state: 'voided' })
    const events = sql(`SELECT void_reason FROM order_line_events WHERE order_line_id = '${l.id}' AND to_state = 'voided'`)
    expect(events).toHaveLength(1)
    expect(events[0].void_reason).toBeTruthy()
  }

  step('C06 cancel three items: server voided them', async () => {
    const targets = [
      lineOf((l) => l.key === 'salad' && l.order_id === rounds.R2.orderId),
      lineOf((l) => l.key === 'chips' && l.order_id === rounds.R3.orderId),
      lineOf((l) => l.key === 'lager' && l.order_id === rounds.R4.orderId),
    ]
    const before = (await financials()).body.financials.tab
    const res = await voidLines(targets, 'guest changed their mind')
    expectStatus(res, 200)
    expect(res.body.changed).toBe(true)
    expect((res.body.applied as Json[]).map((a) => [a.line_id, a.action]).sort())
      .toEqual(targets.map((t) => [t.id, 'voided']).sort())
    expect(res.body.refused).toEqual([])
    for (const t of targets) {
      expectVoidedOnServer(t)
      t.state = 'voided'
    }
    amendReplay.voidLineId = targets[0].id
    const voided = targets.reduce((s, t) => s + t.totalCents, 0)
    expect(voided).toBe(7200 + 3500 + 6400)
    const after = (await financials()).body
    expect(after.financials.tab.voided_cents - before.voided_cents).toBe(voided)
    expect(before.live_cents - after.financials.tab.live_cents).toBe(voided)
    // The lines route marks them voided and the kitchen summary counts them as such.
    const shown = (after.orders as Json[]).flatMap((o) => o.lines as Json[]).filter((l) => targets.some((t) => t.id === l.id))
    expect(shown.every((l) => l.is_voided === true)).toBe(true)
    // A void creates no order and no line.
    expect(sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}'`)[0].n).toBe(4)
    await assertFigures('after cancelling three items')
  })

  const round5: Want[] = [
    { key: 'burger', qty: 1, note: 'medium-well' },
    { key: 'cheesecake', qty: 1 },
    { key: 'wine', qty: 1, note: 'no ice', v: { Glass: 'Small' } },
    { key: 'salad', qty: 1, note: 'no croutons' },
  ]
  const round6: Want[] = [
    { key: 'burger', qty: 1, note: 'medium-well' },
    { key: 'wine', qty: 1, note: 'no ice', v: { Glass: 'Small' } },
  ]

  step('C07 add four, cancel two of them, add those two again', async () => {
    const r5 = await sendRound('chaos-K5', round5)
    expectStatus(r5, 200)
    recordRound('R5', 'chaos-K5', r5.body.order_id, r5.body.order_number, round5)
    const cancelled = [
      lineOf((l) => l.key === 'burger' && l.order_id === rounds.R5.orderId),
      lineOf((l) => l.key === 'wine' && l.order_id === rounds.R5.orderId),
    ]
    const v = await voidLines(cancelled, 'sent to the wrong table')
    expectStatus(v, 200)
    expect((v.body.applied as Json[]).length).toBe(2)
    for (const c of cancelled) {
      expectVoidedOnServer(c)
      c.state = 'voided'
    }
    const r6 = await sendRound('chaos-K6', round6)
    expectStatus(r6, 200)
    expect(r6.body.order_id).not.toBe(rounds.R5.orderId)
    recordRound('R6', 'chaos-K6', r6.body.order_id, r6.body.order_number, round6)
    // Net: exactly one LIVE medium-well burger and one live no-ice wine from these two rounds.
    const live = sql(`SELECT ol.line_note FROM order_lines ol WHERE ol.tab_id = '${tabId}'
                        AND ol.order_id IN ('${rounds.R5.orderId}', '${rounds.R6.orderId}')
                        AND NOT (coalesce(ol.kitchen_state, 'voided') = 'voided' AND coalesce(ol.bar_state, 'voided') = 'voided')`)
    expect(live.map((r) => r.line_note).sort()).toEqual(['medium-well', 'no croutons', 'no ice', null].sort())
    await assertFigures('after add/cancel/re-add')
  })

  step('C08 reduce quantities on existing items', async () => {
    const ribeye = lineOf((l) => l.key === 'ribeye' && l.order_id === rounds.R3.orderId)
    const cake = lineOf((l) => l.key === 'cheesecake' && l.order_id === rounds.R4.orderId)
    const res = await call(amendTab, `/api/terminal/tabs/${tabId}/amend`, {
      params: { tabId },
      body: {
        amendments: [{ line_id: ribeye.id, new_quantity: 1 }, { line_id: cake.id, new_quantity: 2 }],
        staff_user_id: MANAGER,
        authorization_token_id: mintToken('line_void'),
        void_reason: 'over-ordered',
      },
    })
    expectStatus(res, 200)
    const applied = res.body.applied as Json[]
    expect(applied.map((a) => a.action)).toEqual(['replaced', 'replaced'])
    expect(res.body.lines.map((l: Json) => [l.outcome, l.previous_quantity, l.quantity])).toEqual([['reduced', 2, 1], ['reduced', 3, 2]])
    const newOrderId = String(res.body.order_id)
    const [order] = sql(`SELECT total, items, payment_status, tab_id FROM orders WHERE id = '${newOrderId}'`)
    expect(order.tab_id).toBe(tabId)
    expect(cents(order.total)).toBe(24500 + 11000)
    // The replacement keeps the variant and the note the kitchen needs.
    expect(order.items[0].selectedVariants).toEqual({ Doneness: 'Rare' })
    for (const [old, a, qty] of [[ribeye, applied[0], 1], [cake, applied[1], 2]] as const) {
      expectVoidedOnServer(old)
      old.state = 'voided'
      const [nl] = sql(`SELECT order_id, quantity, line_note, name_snapshot FROM order_lines WHERE id = '${a.new_line_id}'`)
      expect({ order: nl.order_id, qty: Number(nl.quantity), note: nl.line_note }).toEqual({ order: newOrderId, qty, note: old.note })
      lines.push({ ...old, id: String(a.new_line_id), order_id: newOrderId, qty, totalCents: old.unitCents * qty, state: 'live' })
    }
    rounds.AMEND = { key: '(amend)', orderId: newOrderId, orderNumber: res.body.order_number, wants: [] }
    amendReplay.reduceLineId = ribeye.id
    await assertFigures('after reducing quantities')
  })

  step('C09 cancel a cooked item: refused, still owed, still cooked', async () => {
    const ribeye = lineOf((l) => l.key === 'ribeye' && l.order_id === rounds.R1.orderId)
    const before = (await financials()).body.financials.tab
    const res = await voidLines([ribeye], 'guest complained')
    expectStatus(res, 200)
    expect(res.body.changed).toBe(false)
    expect(res.body.applied).toEqual([])
    expect(res.body.refused).toEqual([{ line_id: ribeye.id, reason: 'window_closed' }])
    expect(sql(`SELECT kitchen_state FROM order_lines WHERE id = '${ribeye.id}'`)[0].kitchen_state).toBe('cooked')
    expect(sql(`SELECT count(*)::int AS n FROM order_line_events WHERE order_line_id = '${ribeye.id}' AND to_state = 'voided'`)[0].n).toBe(0)
    expect((await financials()).body.financials.tab).toEqual(before)
    await assertFigures('after the refused cooked-item cancel')
  })

  const round7: Want[] = [
    { key: 'espresso', qty: 2, note: 'decaf' },
    { key: 'chips', qty: 1, note: 'for the table' },
  ]

  step('C10 timed-out round: retry with the same key is a duplicate', async () => {
    const ordersBefore = sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}'`)[0].n
    // The first send reaches the server; the terminal never sees the answer.
    const lost = await sendRound('chaos-K7', round7)
    expectStatus(lost, 200)
    const retry = await sendRound('chaos-K7', round7)
    expectStatus(retry, 200)
    expect(retry.body.duplicate).toBe(true)
    expect(retry.body.order_id).toBe(lost.body.order_id)
    expect(retry.body.line_count).toBe(2)
    expect(sql(`SELECT count(*)::int AS n FROM orders WHERE idempotency_key = 'chaos-K7'`)[0].n).toBe(1)
    expect(sql(`SELECT count(*)::int AS n FROM order_lines WHERE order_id = '${lost.body.order_id}'`)[0].n).toBe(2)
    expect(sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}'`)[0].n).toBe(ordersBefore + 1)
    recordRound('R7', 'chaos-K7', lost.body.order_id, lost.body.order_number, round7)
    await assertFigures('after the timed-out round and its retry')
  })

  step('C11 edited retry with the same key: 409, nothing new', async () => {
    const ordersBefore = sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}'`)[0].n
    const linesBefore = sql(`SELECT count(*)::int AS n FROM order_lines WHERE tab_id = '${tabId}'`)[0].n
    const edited: Want[] = [{ key: 'espresso', qty: 3, note: 'decaf' }] // chips removed, one more coffee
    const res = await sendRound('chaos-K7', edited)
    expectStatus(res, 409)
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_BODY_MISMATCH')
    expect(res.body.order_id).toBe(rounds.R7.orderId)
    // What the server actually has, so the terminal can show it.
    expect(JSON.stringify(res.body.items)).toMatch(/Chips/)
    expect(sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}'`)[0].n).toBe(ordersBefore)
    expect(sql(`SELECT count(*)::int AS n FROM order_lines WHERE tab_id = '${tabId}'`)[0].n).toBe(linesBefore)
    const [k7] = sql(`SELECT items FROM orders WHERE id = '${rounds.R7.orderId}'`)
    expect(k7.items.map((i: Json) => Number(i.quantity))).toEqual([2, 1])
    await assertFigures('after the refused edited retry')
  })

  const round8: Want[] = [{ key: 'espresso', qty: 1, note: 'decaf' }]
  const round9: Want[] = [
    { key: 'cheesecake', qty: 1, note: 'to share' },
    { key: 'lager', qty: 1, note: 'no glass' },
  ]

  step('C12 the edited basket under a new key, and a round while others are pending', async () => {
    const r8 = await sendRound('chaos-K8', round8)
    expectStatus(r8, 200)
    expect(r8.body.duplicate).toBe(false)
    recordRound('R8', 'chaos-K8', r8.body.order_id, r8.body.order_number, round8)
    const r9 = await sendRound('chaos-K9', round9)
    expectStatus(r9, 200)
    recordRound('R9', 'chaos-K9', r9.body.order_id, r9.body.order_number, round9)
    // Every earlier round is still unpaid and still in the kitchen's queue; nothing merged.
    const pending = sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}' AND payment_status = 'pending'`)[0].n
    expect(pending).toBe(Object.keys(rounds).length)
    expect(new Set(Object.values(rounds).map((r) => r.orderId)).size).toBe(Object.keys(rounds).length)
    await assertFigures('after rounds 8 and 9')
  })

  step('C13 double-tapped cash settle: exactly one claim', async () => {
    cashSettledOrderIds = [rounds.R2.orderId, rounds.R5.orderId]
    const f = (await financials()).body.financials.orders
    cashSettleCents = cashSettledOrderIds.reduce((s, id) => s + f[id].outstanding_cents, 0)
    const oracle = lines.filter((l) => cashSettledOrderIds.includes(l.order_id) && l.state === 'live').reduce((s, l) => s + l.totalCents, 0)
    expect(cashSettleCents).toBe(oracle)
    const tap = () =>
      call(settleTab, `/api/terminal/tabs/${tabId}/settle`, {
        params: { tabId },
        body: { order_ids: cashSettledOrderIds, method: 'cash', amount: cashSettleCents / 100 },
      })
    claimBarrier = { expected: 2, waiting: [], timer: null }
    let results: Array<{ status: number; body: Json }>
    try {
      results = await Promise.all([tap(), tap()])
    } finally {
      claimBarrier = null
    }
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 409])
    const winner = results.find((r) => r.status === 200)!
    settledPaymentRef = String(winner.body.payment_reference)
    expect(results.find((r) => r.status === 409)!.body.code).toMatch(/ALREADY_PAID|SETTLE_CLAIM_CONFLICT/)
    const payments = sql(`SELECT amount, order_ids, method FROM payments WHERE tab_id = '${tabId}'`)
    expect(payments).toHaveLength(1)
    expect(cents(payments[0].amount)).toBe(cashSettleCents)
    const orders = sql(`SELECT id, payment_status, settled_charge_cents, payment_reference FROM orders WHERE id IN ('${cashSettledOrderIds.join("','")}') ORDER BY id`)
    for (const o of orders) {
      expect(o.payment_status).toBe('paid')
      expect(o.payment_reference).toBe(settledPaymentRef)
      expect(o.settled_charge_cents).toBe(f[o.id].outstanding_cents)
    }
    paidOracle += cashSettleCents
    // Paid in full, but the kitchen has not made round 2's burgers yet -- still outstanding there.
    const burger = lineOf((l) => l.key === 'burger' && l.order_id === rounds.R2.orderId)
    expect(sql(`SELECT kitchen_state FROM order_lines WHERE id = '${burger.id}'`)[0].kitchen_state).toBe('outstanding')
    await assertFigures('after the second partial payment')
  })

  step('C14 void an item on a paid order: refused order_paid; paid-by-item and paid orders cannot be cancelled', async () => {
    const snapshot = () => sql(`SELECT id, kitchen_state, bar_state FROM order_lines WHERE tab_id = '${tabId}' ORDER BY id`)
    const before = snapshot()
    const burger = lineOf((l) => l.key === 'burger' && l.order_id === rounds.R2.orderId)
    const paidOrder = await voidLines([burger], 'wrong item')
    expectStatus(paidOrder, 200)
    expect(paidOrder.body.refused).toEqual([{ line_id: burger.id, reason: 'order_paid' }])
    expect(paidOrder.body.applied).toEqual([])
    // A line paid for BY ITEM, on an order that is not itself paid, is refused as settled.
    const pasta = lineOf((l) => l.key === 'pasta' && l.order_id === rounds.R1.orderId)
    const byItem = await voidLines([pasta], 'too salty')
    expectStatus(byItem, 200)
    expect(byItem.body.refused).toEqual([{ line_id: pasta.id, reason: 'line_settled' }])
    // And the paid ORDER cannot be cancelled from the terminal either.
    const cancel = await call(patchOrderStatus, `/api/terminal/orders/${rounds.R2.orderId}/status`, {
      method: 'PATCH', params: { orderId: rounds.R2.orderId }, body: { status: 'cancelled', reason: 'chaos' },
    })
    expectStatus(cancel, 400)
    expect(sql(`SELECT status, payment_status FROM orders WHERE id = '${rounds.R2.orderId}'`)[0]).toEqual({ status: 'completed', payment_status: 'paid' })
    expect(snapshot()).toEqual(before)
    await assertFigures('after the refused cancellations')
  })

  step('C15 settle the remaining balance by card (verified gateway amount)', async () => {
    const f = (await financials()).body.financials.orders as Record<string, Json>
    const owing = Object.entries(f).filter(([, o]) => o.outstanding_cents > 0).map(([id]) => id)
    const remaining = liveCents() - paidOracle
    expect(owing.reduce((s, id) => s + f[id].outstanding_cents, 0)).toBe(remaining)
    cardLeadOrderId = rounds.R1.orderId
    const prep = await call(preparePayment, `/api/terminal/orders/${cardLeadOrderId}/prepare-payment`, {
      params: { orderId: cardLeadOrderId }, body: { order_ids: owing },
    })
    expectStatus(prep, 200)
    expect(prep.body.chargeCents).toBe(remaining)
    expect([...prep.body.orderIds].sort()).toEqual([...owing].sort())
    cardMerchantOrderNo = String(prep.body.merchantOrderNo)
    cardChargeCents = prep.body.chargeCents
    // The lead order was part-paid by item: it is charged only what it still owes.
    expect(sql(`SELECT pending_charge_cents FROM orders WHERE id = '${cardLeadOrderId}'`)[0].pending_charge_cents).toBe(78900 - 40600)

    // The device charges the card; the gateway reports exactly that amount.
    gateway.paid = true
    gateway.amountMajor = cardChargeCents / 100
    gateway.transactionId = 'CHAOS-TXN-1'
    const verify = await call(verifyPayment, `/api/terminal/orders/${cardLeadOrderId}/verify-payment`, {
      params: { orderId: cardLeadOrderId }, body: {},
    })
    expectStatus(verify, 200)
    expect(verify.body).toMatchObject({ ok: true, paid: true, applied: true })
    const rows = sql(`SELECT id, payment_status, settled_charge_cents FROM orders WHERE id IN ('${owing.join("','")}')`)
    for (const r of rows) {
      expect({ id: r.id, ps: r.payment_status, charged: r.settled_charge_cents }).toEqual({ id: r.id, ps: 'paid', charged: f[r.id].outstanding_cents })
    }
    const events = sql(`SELECT amount, transaction_id FROM payment_events WHERE restaurant_id = '${R}' AND event_type = 'sale'`)
    expect(events).toHaveLength(1)
    expect(cents(events[0].amount)).toBe(cardChargeCents)
    paidOracle += cardChargeCents
    await assertFigures('after the card settlement')
    expect((await financials()).body.financials.tab.outstanding_cents).toBe(0)
  })

  step('C16 replay every money and food request: nothing duplicated', async () => {
    const counts = () => ({
      orders: sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}'`)[0].n,
      lines: sql(`SELECT count(*)::int AS n FROM order_lines WHERE tab_id = '${tabId}'`)[0].n,
      voidEvents: sql(`SELECT count(*)::int AS n FROM order_line_events e JOIN order_lines l ON l.id = e.order_line_id WHERE l.tab_id = '${tabId}' AND e.to_state = 'voided'`)[0].n,
      payments: sql(`SELECT count(*)::int AS n FROM payments WHERE tab_id = '${tabId}'`)[0].n,
      allocSettlements: sql(`SELECT count(*)::int AS n FROM order_line_allocation_settlements WHERE tab_id = '${tabId}'`)[0].n,
      events: sql(`SELECT count(*)::int AS n FROM payment_events WHERE restaurant_id = '${R}'`)[0].n,
      ledger: ledger().total,
    })
    const before = counts()

    const round = await sendRound('chaos-K1', round1)
    expectStatus(round, 200)
    expect(round.body.duplicate).toBe(true)
    expect(round.body.order_id).toBe(rounds.R1.orderId)

    const revoid = await voidLines([lines.find((l) => l.id === amendReplay.voidLineId)!], 'replay')
    expect(revoid.body.applied).toEqual([])
    const rereduce = await call(amendTab, `/api/terminal/tabs/${tabId}/amend`, {
      params: { tabId },
      body: { amendments: [{ line_id: amendReplay.reduceLineId, new_quantity: 1 }], staff_user_id: MANAGER, authorization_token_id: mintToken('line_void'), void_reason: 'replay' },
    })
    expectStatus(rereduce, 200)
    expect(rereduce.body.applied).toEqual([])
    expect(rereduce.body.order_id).toBeNull()

    const allocs = await call(settleAllocations, `/api/terminal/tabs/${tabId}/settle-allocations`, {
      params: { tabId }, body: { allocation_ids: allocationIdsPaidByItem, method: 'cash' },
    })
    expectStatus(allocs, 409)

    const cash = await call(settleTab, `/api/terminal/tabs/${tabId}/settle`, {
      params: { tabId }, body: { order_ids: cashSettledOrderIds, method: 'cash', amount: cashSettleCents / 100 },
    })
    expectStatus(cash, 409)
    expect(cash.body.code).toBe('ALREADY_PAID')

    const prep = await call(preparePayment, `/api/terminal/orders/${cardLeadOrderId}/prepare-payment`, {
      params: { orderId: cardLeadOrderId }, body: {},
    })
    // Refused before any reference is minted or any expectation written (ensureTerminalMerchantOrderNo).
    expect({ status: prep.status, code: prep.body.code }).toEqual({ status: 400, code: 'ALREADY_PAID' })

    const verify = await call(verifyPayment, `/api/terminal/orders/${cardLeadOrderId}/verify-payment`, {
      params: { orderId: cardLeadOrderId }, body: {},
    })
    expectStatus(verify, 200)
    expect(verify.body.source).toBe('supabase') // already paid: the gateway is not re-applied

    // The gateway webhook for the same charge arriving late goes through the same writer.
    const { settleWholeOrderPayment } = await import('@/lib/payments/settle-whole-order-payment')
    const { createServerSupabaseClient } = await import('@/lib/supabase/server')
    const late = await settleWholeOrderPayment(createServerSupabaseClient(), {
      restaurantId: R, leadOrderIds: [cardLeadOrderId], merchantOrderNo: cardMerchantOrderNo,
      transactionId: 'CHAOS-TXN-1', gatewayAmount: cardChargeCents / 100, paymentMethod: 'card',
      source: 'chaos_webhook_replay', mismatchSource: 'webhook', terminalId: TERM,
    } as never)
    expect((late as Json).applied ?? false).toBe(false)

    // Cancelling a line after the tab is fully paid: refused, and still nothing moves.
    const lastLive = lines.filter((l) => l.state === 'live').at(-1)!
    const lateVoid = await voidLines([lastLive], 'after payment')
    expect(lateVoid.body.applied).toEqual([])

    expect(counts()).toEqual(before)
    await assertFigures('after replaying everything')
  })

  let invoice: Json = {}
  step('C17 invoice for the tab, once', async () => {
    const body = { tab_id: tabId, restaurant_id: R, bill_to: { name: 'Chaos Holdings', address: '1 Test Street' } }
    const res = await call(invoiceFromOrder, '/api/admin/documents/from-order', { body, auth: 'Bearer chaos-manager' })
    expectStatus(res, 201)
    invoice = res.body.document
    const again = await call(invoiceFromOrder, '/api/admin/documents/from-order', { body, auth: 'Bearer chaos-manager' })
    expectStatus(again, 409)
    expect(again.body.code).toBe('INVOICE_ALREADY_EXISTS')
    const docs = sql(`SELECT id, total, balance, status FROM business_documents WHERE restaurant_id = '${R}' AND document_type = 'invoice'`)
    expect(docs).toHaveLength(1)
    expect(cents(docs[0].total)).toBe(liveCents())
    expect(cents(docs[0].balance)).toBe(0)
  })

  // ---------------------------------------------------------------------------------------------
  // FINAL PROOFS
  // ---------------------------------------------------------------------------------------------
  step('C18 final: no duplicate orders or lines, none missing', async () => {
    const orders = sql(`SELECT id, idempotency_key FROM orders WHERE tab_id = '${tabId}'`)
    expect(orders.map((o) => o.id).sort()).toEqual(Object.values(rounds).map((r) => r.orderId).sort())
    const keys = orders.map((o) => o.idempotency_key).filter(Boolean)
    expect(new Set(keys).size).toBe(keys.length)
    const dbLines = sql(`SELECT id FROM order_lines WHERE tab_id = '${tabId}'`)
    expect(dbLines.map((l) => l.id).sort()).toEqual(lines.map((l) => l.id).sort())
    // Every item on every order has exactly one line.
    const unmatched = sql(`SELECT o.id, i.ord - 1 AS idx FROM orders o, jsonb_array_elements(o.items) WITH ORDINALITY i(item, ord)
                             WHERE o.tab_id = '${tabId}' AND NOT EXISTS (
                               SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.source_item_index = i.ord - 1)`)
    expect(unmatched).toEqual([])
    const dupes = sql(`SELECT order_id, source_item_index FROM order_lines WHERE tab_id = '${tabId}' GROUP BY 1, 2 HAVING count(*) > 1`)
    expect(dupes).toEqual([])
  })

  step('C19 final: notes and variants on the right lines, prices right', async () => {
    for (const l of lines) {
      const [row] = sql(`SELECT l.line_note, l.quantity, o.items -> l.source_item_index AS item
                           FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = '${l.id}'`)
      expect({ id: l.id, note: row.line_note, qty: Number(row.quantity), menu: row.item.menuItemId, v: row.item.selectedVariants ?? {}, total: cents(row.item.total) })
        .toEqual({ id: l.id, note: l.note, qty: l.qty, menu: ITEM[l.key], v: l.v, total: l.totalCents })
    }
  })

  step('C20 final: cancelled never charged, paid never charged again', async () => {
    const f = (await financials()).body
    const voided = lines.filter((l) => l.state === 'voided')
    expect(voided.length).toBe(7) // three cancels, two cancelled re-orders, two reduced originals
    expect(f.financials.tab.voided_cents).toBe(voided.reduce((s, l) => s + l.totalCents, 0))
    // No voided line carries a settled allocation, and no order was charged more than its live value.
    expect(sql(`SELECT a.id FROM order_line_allocations a JOIN order_line_allocation_settlements s ON s.order_line_allocation_id = a.id
                  WHERE a.order_line_id IN ('${voided.map((l) => l.id).join("','")}')`)).toEqual([])
    for (const [id, o] of Object.entries(f.financials.orders as Record<string, Json>)) {
      expect({ id, overpaid: o.overpaid_cents, outstanding: o.outstanding_cents }).toEqual({ id, overpaid: 0, outstanding: 0 })
    }
    // Each order was claimed by exactly one whole-order payment.
    const refs = sql(`SELECT id, payment_reference, settled_charge_cents FROM orders WHERE tab_id = '${tabId}' AND payment_status = 'paid'`)
    expect(refs.every((r) => r.payment_reference)).toBe(true)
  })

  step('C21 final: the ledger reconciles to the cent', async () => {
    const l = ledger()
    const wholeOrder = sql<{ c: number }>(`SELECT coalesce(sum(settled_charge_cents), 0)::int AS c FROM orders WHERE tab_id = '${tabId}' AND payment_status = 'paid'`)[0].c
    const f = (await financials()).body.financials.tab
    expect({ ledger: l.total, parts: l.alloc + wholeOrder, projectionPaid: f.paid_cents, live: f.live_cents, oracle: paidOracle })
      .toEqual({ ledger: paidOracle, parts: paidOracle, projectionPaid: paidOracle, live: liveCents(), oracle: liveCents() })
    expect(l).toEqual({ alloc: 40600, cash: cashSettleCents, card: cardChargeCents, total: 40600 + cashSettleCents + cardChargeCents })
    expect(cents(invoice.total) - cents(invoice.balance)).toBe(l.total)
  })

  step('C22 final: terminal lines, tables, order history and invoice agree', async () => {
    const f = (await financials()).body.financials
    const t = await tableRow()
    // A wide window: the route reads dates in the venue's timezone (Africa/Windhoek, UTC+2).
    const hist = await call(orderHistory, `/api/orders/history?restaurantId=${R}&startDate=2026-01-01&endDate=2099-12-31`, { method: 'GET', auth: 'Bearer chaos-manager' })
    expectStatus(hist, 200)
    const histOrders = (hist.body.orders as Json[]).filter((o) => o.tab_id === tabId || Object.values(rounds).some((r) => r.orderId === o.id))
    expect(histOrders).toHaveLength(Object.keys(rounds).length)
    const summary = {
      lines: f.tab.live_cents,
      tables: t?.tab ? t.tab.financials.live_cents : f.tab.live_cents,
      unpaid: t?.tab ? cents(t.tab.unpaid_total) : 0,
      invoiceTotal: cents(invoice.total),
    }
    expect(summary).toEqual({ lines: liveCents(), tables: liveCents(), unpaid: 0, invoiceTotal: liveCents() })
    for (const o of histOrders) {
      const mine = f.orders[o.id]
      expect({ id: o.id, live: cents(o.live_amount), voided: cents(o.voided_amount), ps: o.payment_status })
        .toEqual({ id: o.id, live: mine.live_cents, voided: mine.voided_cents, ps: 'paid' })
    }
    // The dashboard's revenue for the venue is the money actually taken -- nothing voided in it.
    expect({ revenue: cents(hist.body.totalRevenue), paidOrders: hist.body.totalOrders })
      .toEqual({ revenue: ledger().total, paidOrders: Object.keys(rounds).length })
  })

  step('C23 final: kitchen state is not payment state', async () => {
    const rows = sql(`SELECT l.id, l.kitchen_state, l.bar_state, o.payment_status FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.tab_id = '${tabId}'`)
    const byIdMap = new Map(rows.map((r) => [r.id, r]))
    const byId = { get: (id: string) => { const r = byIdMap.get(id); if (!r) throw new Error(`line ${id} missing on the server`); return r } }
    // Paid everywhere, yet the kitchen still has live food to make: payment did not cook it.
    const stillOutstanding = lines.filter((l) => l.state === 'live' && STATION[l.key] === 'kitchen' && byId.get(l.id).kitchen_state === 'outstanding')
    expect(stillOutstanding.length).toBeGreaterThan(0)
    expect(stillOutstanding.every((l) => byId.get(l.id).payment_status === 'paid')).toBe(true)
    // The ribeye cooked while unpaid was still charged: cooked is not paid, paid is not cooked.
    const ribeye = lineOf((l) => l.key === 'ribeye' && l.order_id === rounds.R1.orderId)
    expect(byId.get(ribeye.id).kitchen_state).toBe('cooked')
    expect(sql(`SELECT settled_charge_cents FROM orders WHERE id = '${rounds.R1.orderId}'`)[0].settled_charge_cents).toBe(78900 - 40600)
    // Voided lines are voided at their station, whatever their order's payment status.
    for (const l of lines.filter((x) => x.state === 'voided')) {
      const r = byId.get(l.id)
      expect(STATION[l.key] === 'kitchen' ? r.kitchen_state : r.bar_state).toBe('voided')
    }
  })
})
