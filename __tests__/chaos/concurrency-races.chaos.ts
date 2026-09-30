/**
 * CONCURRENCY RACES -- two waiters, two terminals, one table, at the same moment (RC-RACES,
 * sprint 2026-09-30: scenarios C1-C6, D1-D5, D4 takeover + unresolved attempt, E7, K1-K8).
 *
 *   node supabase/tests/chaos-e2e.mjs --scenario=concurrency-races
 *
 * Launched only by that runner (the file name does not match jest's testMatch). It builds its own
 * Postgres + PostgREST from the real baseline and every production migration; see its header.
 *
 * WHAT "CONCURRENT" MEANS HERE. Two real route handlers are started together (Promise.all) and each
 * talks to the real PostgREST over its own HTTP connection, so their statements reach Postgres in
 * separate sessions. Where the outcome depends on the interleaving, a BARRIER in the fetch wrapper
 * below holds the named write of every racer until all of them have arrived -- so each has passed
 * every read and pre-check before any of them writes -- and then releases them together. That is
 * the worst-case interleaving, forced rather than hoped for, and it is what makes each mutation
 * below fail deterministically. Nothing is sequenced by the test and presented as a race.
 *
 * WHAT IS SIMULATED. The Finatic gateway, at the wire only (as in payment-simulation.chaos.ts):
 * `fetch` to open.finatic.africa is answered here. Terminal JWT verification (jose is ESM-only):
 * two bearer tokens map to the two seeded terminals and the terminal row is re-read from the
 * database. Realtime broadcast. The dashboard caller for Mark-as-Paid and order history (no GoTrue).
 *
 * SAFETY. Refuses to start unless pointed at the harness's own 127.0.0.1 proxy; `fetch` to any other
 * host throws except the Finatic host, which never leaves this process.
 */
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

// ------------------------------------------------------------------------------------------------
// SAFETY
// ------------------------------------------------------------------------------------------------
const REST_URL = process.env.FT_CHAOS_REST_URL ?? ''
const SERVICE_KEY = process.env.FT_CHAOS_SERVICE_KEY ?? ''
const DB = process.env.FT_CHAOS_DB ?? ''
const CONTAINER = process.env.FT_CHAOS_CONTAINER ?? ''
const REPORT_FILE = process.env.FT_CHAOS_REPORT ?? ''
if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(REST_URL)) {
  throw new Error(`races: FT_CHAOS_REST_URL must be the harness's 127.0.0.1 proxy, got "${REST_URL}".`)
}
if (!/^[a-z][a-z0-9_]{0,40}$/.test(DB) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/.test(CONTAINER)) {
  throw new Error('races: FT_CHAOS_DB / FT_CHAOS_CONTAINER missing or malformed')
}
for (const k of Object.keys(process.env)) {
  if (/SUPABASE|UPSTASH|RESEND|PAYCLOUD|FINATIC|REDIS|WEBHOOK|SENTRY|TWILIO|WHATSAPP/i.test(k)) delete process.env[k]
}
process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'races-anon-key-unused'
const FINATIC_HOST = 'open.finatic.africa'
process.env.PAYCLOUD_ENDPOINT = `https://${FINATIC_HOST}/api/entry`
process.env.PAYCLOUD_APP_ID = 'wz663raceslocal'
process.env.PAYCLOUD_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

// ------------------------------------------------------------------------------------------------
// THE SIMULATED GATEWAY (same wire shapes as payment-simulation.chaos.ts)
// ------------------------------------------------------------------------------------------------
type GatewayState =
  | { kind: 'no_record' }
  | { kind: 'paid'; cents: number; txn: string }
  | { kind: 'declined'; cents: number; code: string }
const gw = {
  state: new Map<string, GatewayState>(),
  asks: [] as Array<{ mo: string; cents: number; outcome: string; terminal: string }>,
  /** Every pay.paycloud.close the server sent. */
  closes: [] as string[],
  txnSeq: 0,
}
const major = (c: number) => (c / 100).toFixed(2)
function finaticOrderQuery(mo: string): Record<string, unknown> {
  const s = gw.state.get(mo) ?? { kind: 'no_record' }
  if (s.kind === 'no_record') return { code: 'E04111', msg: '[E04111]Merchant order number is invalid', merchant_order_no: mo }
  if (s.kind === 'paid') {
    return {
      code: '0', msg: 'Success', psn: s.txn,
      data: JSON.stringify({ merchant_order_no: mo, trans_status: 2, paid_amount: major(s.cents), order_amount: major(s.cents), transactionID: s.txn }),
    }
  }
  return {
    code: '0', msg: 'Success',
    data: JSON.stringify({ merchant_order_no: mo, trans_status: 1, paid_amount: '0', order_amount: major(s.cents), trans_error_code: s.code }),
  }
}

/**
 * THE BARRIER. `hold(match, n)` arms it: the next `n` requests matching `match` are parked until all
 * `n` have arrived, then released together (or after 4 s, so a racer that never reaches the write
 * cannot hang the suite -- the test then sees the interleaving it actually got).
 */
type Match = (method: string, path: string, body: string) => boolean
let barrier: { match: Match; expected: number; waiting: Array<() => void>; timer: NodeJS.Timeout | null; arrived: string[]; done: boolean } | null = null
function hold(match: Match, expected: number) {
  barrier = { match, expected, waiting: [], timer: null, arrived: [], done: false }
}
function released(): string[] {
  const arrived = barrier?.arrived ?? []
  barrier = null
  return arrived
}
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname === FINATIC_HOST) {
    // pay.paycloud.close (the dashboard's cancel-terminal): the gateway closes an UNPAID reference so
    // it can never be charged, and refuses to close one it has already been paid on.
    const posted = JSON.parse(String(init?.body ?? '{}')) as { method?: string; merchant_order_no?: string }
    if (posted.method === 'pay.paycloud.close') {
      const mo = String(posted.merchant_order_no ?? '')
      gw.closes.push(mo)
      if (gw.state.get(mo)?.kind === 'paid') {
        return new Response(JSON.stringify({ code: 'E04120', msg: 'Order already paid, cannot close' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      gw.state.set(mo, { kind: 'no_record' })
      return new Response(JSON.stringify({ code: '0', msg: 'Success', data: { merchant_order_no: mo } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (!url.pathname.endsWith('/api/entry/orderquery')) throw new Error(`races: Finatic ${url.pathname} is not simulated`)
    const body = JSON.parse(String(init?.body ?? '{}')) as { merchant_order_no?: string; sign?: string }
    if (!body.sign) throw new Error('races: order.query arrived unsigned')
    return new Response(JSON.stringify(finaticOrderQuery(String(body.merchant_order_no ?? ''))), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.hostname !== '127.0.0.1') throw new Error(`races: refused a request to ${url.origin}`)
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  const body = typeof init?.body === 'string' ? init.body : ''
  const b = barrier
  // ONE-SHOT: once released, a retry of the same write (an order-number collision, say) is not
  // parked again -- it would have no partner and would wait for ever.
  if (b && !b.done && b.match(method, url.pathname, body)) {
    b.arrived.push(`${method} ${url.pathname.replace('/rest/v1', '')}`)
    await new Promise<void>((release) => {
      b.waiting.push(release)
      const open = () => {
        b.done = true
        if (b.timer) clearTimeout(b.timer)
        b.waiting.splice(0).forEach((r) => r())
      }
      if (b.waiting.length >= b.expected) open()
      else if (!b.timer) b.timer = setTimeout(open, 4000)
    })
  }
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

const isPatch = (table: string, field: string): Match => (m, p, body) =>
  m === 'PATCH' && p.endsWith(`/rest/v1/${table}`) && body.includes(`"${field}"`)
const isRpc = (fn: string): Match => (m, p) => m === 'POST' && p.endsWith(`/rest/v1/rpc/${fn}`)
const isInsert = (table: string): Match => (m, p) => m === 'POST' && p.endsWith(`/rest/v1/${table}`)
const either = (...ms: Match[]): Match => (m, p, b) => ms.some((x) => x(m, p, b))

// ------------------------------------------------------------------------------------------------
// FIXTURE
// ------------------------------------------------------------------------------------------------
const R = 'c4a05000-0000-4000-8000-000000000001'
const TERM = { a: 'c4a05000-0000-4000-8000-00000000e001', b: 'c4a05000-0000-4000-8000-00000000e002' } as const
type T = keyof typeof TERM
const MANAGER = 'c4a05000-0000-4000-8000-000000005001'
const WAITER = 'c4a05000-0000-4000-8000-000000005002'
const ITEM = {
  burger: 'c4a05000-0000-4000-8000-000000001003',
  chips: 'c4a05000-0000-4000-8000-000000001004',
  salad: 'c4a05000-0000-4000-8000-000000001005',
  cheesecake: 'c4a05000-0000-4000-8000-000000001006',
  lager: 'c4a05000-0000-4000-8000-000000002001',
  espresso: 'c4a05000-0000-4000-8000-000000002003',
} as const
type ItemKey = keyof typeof ITEM
/** THE ORACLE: unit price in cents from the seeded menu, not from any code under test. */
const PRICE: Record<ItemKey, number> = { burger: 9850, chips: 3500, salad: 7200, cheesecake: 5500, lager: 3200, espresso: 2600 }
const NAME: Record<ItemKey, string> = { burger: 'Burger', chips: 'Chips', salad: 'Caesar Salad', cheesecake: 'Cheesecake', lager: 'Lager', espresso: 'Espresso' }
const tableId = (n: number) => `c4a05000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`
const tableNumber = (n: number) => 300 + n

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async (req: Request) => {
    const token = req.headers.get('authorization')
    const terminalId =
      token === 'Bearer races-terminal-a' ? 'c4a05000-0000-4000-8000-00000000e001'
        : token === 'Bearer races-terminal-b' ? 'c4a05000-0000-4000-8000-00000000e002'
          : null
    if (!terminalId) throw new Response(JSON.stringify({ error: 'Missing terminal token' }), { status: 401 })
    return {
      terminalId,
      restaurantId: 'c4a05000-0000-4000-8000-000000000001',
      deviceSerial: terminalId.endsWith('e001') ? 'CHAOS-P5-0001' : 'CHAOS-P5-0002',
      permissions: ['orders:read', 'orders:update', 'payments:process'],
    }
  },
  validateTerminalRecord: async (supabase: { from: (t: string) => any }, terminal: { terminalId: string; restaurantId: string }) => {
    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select('id, status, restaurant_id, device_serial')
      .eq('id', terminal.terminalId)
      .eq('restaurant_id', terminal.restaurantId)
      .single()
    if (error || !data) throw new Response(JSON.stringify({ error: 'Terminal not recognized' }), { status: 401 })
    if (data.status !== 'active') throw new Response(JSON.stringify({ error: 'Terminal is not active' }), { status: 403 })
    return data
  },
}))
jest.mock('@/lib/stations/realtime-invalidate', () => ({
  ...jest.requireActual('@/lib/stations/realtime-invalidate'),
  broadcastLineChanged: async () => undefined,
}))
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  ...jest.requireActual('@/lib/supabase/admin-restaurant-auth'),
  getUserFromRequest: async (req: Request) => {
    if (req.headers.get('authorization') !== 'Bearer races-manager') throw new Error('Missing authorization')
    return { id: 'c4a05000-0000-4000-8000-000000005001', email: 'manager@chaos.invalid' }
  },
}))

import { POST as openTable } from '@/app/api/terminal/tables/[tableId]/open/route'
import { POST as closeTable } from '@/app/api/terminal/tables/[tableId]/close/route'
import { POST as walkoutClose } from '@/app/api/terminal/tables/[tableId]/walkout-close/route'
import { POST as cancelTerminal } from '@/app/api/payments/cancel-terminal/route'
import { POST as postRound } from '@/app/api/terminal/rounds/route'
import { GET as getLines } from '@/app/api/terminal/tabs/[tabId]/lines/route'
import { POST as amendTab } from '@/app/api/terminal/tabs/[tabId]/amend/route'
import { POST as allocateLine } from '@/app/api/terminal/tabs/[tabId]/lines/[lineId]/allocate/route'
import { POST as settleTab } from '@/app/api/terminal/tabs/[tabId]/settle/route'
import { POST as prepareSplit } from '@/app/api/terminal/tabs/[tabId]/prepare-split-payment/route'
import { POST as recordSplit } from '@/app/api/terminal/tabs/[tabId]/record-split-payment/route'
import { POST as preparePayment } from '@/app/api/terminal/orders/[orderId]/prepare-payment/route'
import { POST as attemptStarted } from '@/app/api/terminal/orders/[orderId]/attempt-started/route'
import { POST as orderPayment } from '@/app/api/terminal/orders/[orderId]/payment/route'
import { POST as verifyPayment } from '@/app/api/terminal/orders/[orderId]/verify-payment/route'
import { POST as saleEvent } from '@/app/api/terminal/payment-events/sale/route'
import { POST as paycloudWebhook } from '@/app/api/webhooks/paycloud/route'
import { PATCH as dashboardOrderStatus } from '@/app/api/orders/[orderId]/status/route'
import { GET as orderHistory } from '@/app/api/orders/history/route'
import { getReportData } from '@/lib/reports/get-report-data'
import { resolveDateRangePreset } from '@/lib/reports/date-range-presets'

// ------------------------------------------------------------------------------------------------
// SERVER TRUTH, straight out of Postgres
// ------------------------------------------------------------------------------------------------
function sql<X = Record<string, any>>(query: string): X[] {
  const out = execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { input: `SELECT coalesce(json_agg(t), '[]'::json) FROM (${query}) t;`, encoding: 'utf8' },
  )
  return JSON.parse(out.trim()) as X[]
}
function sqlExec(statement: string): void {
  execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8' })
}
const n = (query: string) => Number(sql<{ n: number }>(query)[0]?.n ?? 0)
const cents = (m: unknown) => Math.round(Number(m) * 100)
const inList = (ids: string[]) => `('${ids.join("','")}')`

type Json = Record<string, any>
type Res = { status: number; body: Json }
async function call(
  handler: (req: Request, ctx: any) => Promise<Response>,
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string>; raw?: string; term?: T; auth?: string } = {},
): Promise<Res> {
  const req = new Request(`https://races.test${path}`, {
    method: opts.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: opts.auth ?? `Bearer races-terminal-${opts.term ?? 'a'}`,
      ...(opts.headers ?? {}),
    },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  })
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) })
  const text = await res.text()
  let body: Json = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: res.status, body }
}
function expectStatus(res: Res, status: number) {
  if (res.status !== status) throw new Error(`expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 1500)}`)
}
function mintToken(purpose: 'service_session' | 'line_void' | 'cash_settlement', term: T, userId = MANAGER): string {
  const id = randomUUID()
  sqlExec(`INSERT INTO public.privileged_authorization_tokens (id, user_id, restaurant_id, terminal_id, purpose, nonce, ttl_seconds, expires_at)
           VALUES ('${id}', '${userId}', '${R}', '${TERM[term]}', '${purpose}', '${randomUUID()}', 90, now() + interval '90 seconds');`)
  return id
}

// ------------------------------------------------------------------------------------------------
// THE WAITERS
// ------------------------------------------------------------------------------------------------
type Want = { key: ItemKey; qty: number }
const liveOf = (wants: Want[]) => wants.reduce((s, w) => s + PRICE[w.key] * w.qty, 0)

async function openTab(tableNo: number, label: string): Promise<string> {
  const t = tableId(tableNo)
  const res = await call(openTable, `/api/terminal/tables/${t}/open`, {
    params: { tableId: t },
    body: { user_id: WAITER, authorization_token_id: mintToken('service_session', 'a', WAITER), customer_name: label },
  })
  expectStatus(res, 200)
  return String(res.body.tab.id)
}
function roundRaw(term: T, tabId: string, wants: Want[], key = randomUUID()): Promise<Res> {
  return call(postRound, '/api/terminal/rounds', {
    term,
    body: {
      tab_id: tabId,
      items: wants.map((w) => ({ menuItemId: ITEM[w.key], name: NAME[w.key], quantity: w.qty, price: 1, unitPrice: 1 })),
      subtotal: 1, total: 1,
    },
    headers: { 'x-idempotency-key': key, 'x-flashtap-variant-protocol': '1' },
  })
}
async function round(tabId: string, wants: Want[], term: T = 'a'): Promise<string> {
  const res = await roundRaw(term, tabId, wants)
  expectStatus(res, 200)
  return String(res.body.order_id)
}
/** The order's lines in source order: [{id, name, quantity, state}] */
function linesOf(orderId: string) {
  return sql<{ id: string; name: string; quantity: number; kitchen_state: string | null; bar_state: string | null }>(
    `SELECT id, name_snapshot AS name, quantity::float AS quantity, kitchen_state, bar_state FROM order_lines WHERE order_id = '${orderId}' ORDER BY source_item_index`,
  )
}
/** An amendment from one terminal, with that terminal's manager PIN token. */
function amend(term: T, tabId: string, amendments: Array<{ line_id: string; new_quantity: number }>): Promise<Res> {
  return call(amendTab, `/api/terminal/tabs/${tabId}/amend`, {
    term,
    params: { tabId },
    body: { amendments, staff_user_id: MANAGER, authorization_token_id: mintToken('line_void', term), void_reason: `races ${term}` },
  })
}
async function financials(tabId: string) {
  const res = await call(getLines, `/api/terminal/tabs/${tabId}/lines`, { method: 'GET', params: { tabId } })
  expectStatus(res, 200)
  return res.body.financials as { tab: Json; orders: Record<string, Json> }
}
function prepareRaw(term: T, leadId: string, orderIds: string[]): Promise<Res> {
  return call(preparePayment, `/api/terminal/orders/${leadId}/prepare-payment`, { term, params: { orderId: leadId }, body: { order_ids: orderIds } })
}
async function started(term: T, leadId: string, mo: string) {
  const res = await call(attemptStarted, `/api/terminal/orders/${leadId}/attempt-started`, {
    term, params: { orderId: leadId }, body: { businessOrderNo: mo, appVersion: '2.41', launchedAt: new Date().toISOString() },
  })
  expectStatus(res, 200)
}
function reader(term: T, mo: string, amount: number, outcome: 'approved' | 'declined' | 'no_answer') {
  gw.asks.push({ mo, cents: amount, outcome, terminal: term })
  if (outcome === 'approved') {
    gw.txnSeq += 1
    const txn = `RACES-TXN-${gw.txnSeq}`
    gw.state.set(mo, { kind: 'paid', cents: amount, txn })
    return { voucherNo: txn, gatewayResult: undefined as string | undefined }
  }
  if (outcome === 'declined') {
    gw.state.set(mo, { kind: 'declined', cents: amount, code: 'N003' })
    return { voucherNo: undefined as string | undefined, gatewayResult: 'N003' }
  }
  gw.state.set(mo, { kind: 'no_record' })
  return { voucherNo: undefined as string | undefined, gatewayResult: '9027' }
}
function cardSettle(term: T, tabId: string, orderIds: string[], amountCents: number, mo: string, voucher: string) {
  return call(settleTab, `/api/terminal/tabs/${tabId}/settle`, {
    term, params: { tabId },
    body: { order_ids: orderIds, method: 'card', amount: amountCents / 100, gateway_reference: voucher, voucher_no: voucher, business_order_no: mo },
  })
}
function cashSettle(term: T, tabId: string, orderIds: string[], amountCents: number) {
  return call(settleTab, `/api/terminal/tabs/${tabId}/settle`, { term, params: { tabId }, body: { order_ids: orderIds, method: 'cash', amount: amountCents / 100 } })
}
function deviceSale(term: T, orderIds: string[], mo: string, txn: string, amountCents: number) {
  return call(saleEvent, '/api/terminal/payment-events/sale', {
    term, body: { order_ids: orderIds, business_order_no: mo, transaction_id: txn, amount: amountCents / 100, app_version: '2.41' },
  })
}
function webhook(mo: string) {
  const s = gw.state.get(mo)
  const payload = {
    merchant_order_no: mo, trans_status: s?.kind === 'paid' ? 2 : 1,
    amount: s && 'cents' in s ? Number(major(s.cents)) : 0,
    transaction_id: s?.kind === 'paid' ? s.txn : undefined, sign: 'races-unverifiable-signature',
  }
  return call(paycloudWebhook, '/api/webhooks/paycloud', { raw: JSON.stringify(payload), headers: { 'x-forwarded-for': '203.0.113.9' } })
}
function close(term: T, tableNo: number) {
  const t = tableId(tableNo)
  return call(closeTable, `/api/terminal/tables/${t}/close`, { term, params: { tableId: t }, body: {} })
}
/** Every money row for a tab, from every ledger. */
function tabMoney(tabId: string) {
  const ids = sql<{ id: string }>(`SELECT id FROM orders WHERE tab_id = '${tabId}'`).map((r) => r.id)
  const arr = ids.length ? `ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]` : 'ARRAY[]::uuid[]'
  return {
    saleRows: n(`SELECT count(*)::int AS n FROM payment_events WHERE restaurant_id='${R}' AND event_type='sale' AND order_ids && ${arr}`),
    saleCents: n(`SELECT coalesce(sum(round(amount*100)),0)::int AS n FROM payment_events WHERE restaurant_id='${R}' AND event_type='sale' AND order_ids && ${arr}`),
    nonGatewayRows: n(`SELECT count(*)::int AS n FROM non_gateway_payment_events WHERE order_ids && ${arr}`),
    nonGatewayCents: n(`SELECT coalesce(sum(amount_cents),0)::int AS n FROM non_gateway_payment_events WHERE order_ids && ${arr}`),
    allocCents: n(`SELECT coalesce(sum(amount_cents),0)::int AS n FROM order_line_allocation_settlements WHERE tab_id='${tabId}'`),
    paymentsRows: n(`SELECT count(*)::int AS n FROM payments WHERE tab_id='${tabId}'`),
  }
}
const orderRow = (id: string) =>
  sql<{ payment_status: string; status: string; payment_method: string | null; settled_charge_cents: number | null; pending_charge_cents: number | null; pending_charge_terminal_id: string | null; total: string }>(
    `SELECT payment_status, status, payment_method, settled_charge_cents, pending_charge_cents, pending_charge_terminal_id, total FROM orders WHERE id = '${id}'`,
  )[0]

// ------------------------------------------------------------------------------------------------
// THE REPORT: one row per probe -- sessions, interleaving, outcome
// ------------------------------------------------------------------------------------------------
type Row = { scenario: string; layer: string; expected: string; asked: string; ledger: string; allocated: string; final: string; result: string }
const report: Row[] = []
function probe(name: string, fn: (row: Row) => Promise<void>) {
  test(name, async () => {
    const row: Row = { scenario: name.split(' ')[0], layer: '-', expected: '-', asked: '-', ledger: '-', allocated: '-', final: '-', result: 'FAIL' }
    report.push(row)
    await fn(row)
    row.result = 'PASS'
  }, 240_000)
}
afterAll(() => {
  const lines = ['probe | sessions | expected | interleaving | ledger | allocation | outcome | result',
    ...report.map((r) => [r.scenario, r.layer, r.expected, r.asked, r.ledger, r.allocated, r.final, r.result].join(' | '))]
  console.log(`\n[races] REPORT\n${lines.join('\n')}`)
  if (REPORT_FILE) writeFileSync(REPORT_FILE, JSON.stringify({ rows: report, asks: gw.asks }, null, 2))
})

beforeAll(() => {
  sqlExec(`UPDATE public.restaurants SET finatic_merchant_no = 'RACES-MERCHANT', finatic_store_no = 'RACES-STORE' WHERE id = '${R}';`)
  sqlExec(`INSERT INTO public.restaurant_terminals (id, restaurant_id, device_serial, name, status, active)
           VALUES ('${TERM.b}', '${R}', 'CHAOS-P5-0002', 'Chaos second terminal', 'active', true) ON CONFLICT DO NOTHING;`)
  for (let i = 1; i <= 40; i += 1) {
    sqlExec(`INSERT INTO public.restaurant_tables (id, restaurant_id, table_number, table_name, active, status)
             VALUES ('${tableId(i)}', '${R}', ${tableNumber(i)}, 'Races ${i}', true, 'available') ON CONFLICT DO NOTHING;`)
  }
})

const statusesOf = (rs: Res[]) => rs.map((r) => r.status).sort((x, y) => x - y)

// ================================================================================================
// C -- CONCURRENT WAITER ACTIONS
// ================================================================================================
describe('C: two waiters on one tab', () => {
  probe('RC-C1 waiter A adds a round while waiter B cancels an item', async (row) => {
    const tabId = await openTab(1, 'C1')
    const a = await round(tabId, [{ key: 'burger', qty: 2 }, { key: 'lager', qty: 3 }])
    const [burger] = linesOf(a)
    hold(either(isInsert('orders'), isRpc('amend_order_lines')), 2)
    const [add, cancel] = await Promise.all([
      roundRaw('a', tabId, [{ key: 'chips', qty: 1 }]),
      amend('b', tabId, [{ line_id: burger.id, new_quantity: 0 }]),
    ])
    row.asked = `held ${released().join(' + ')} until both arrived`
    expectStatus(add, 200)
    expectStatus(cancel, 200)
    expect(cancel.body.applied).toEqual([{ line_id: burger.id, action: 'voided' }])
    const f = await financials(tabId)
    const expected = PRICE.lager * 3 + PRICE.chips
    expect(f.tab.live_cents).toBe(expected)
    // Nothing lost: the new round's line exists, the voided line is voided once, the lagers untouched.
    expect(linesOf(String(add.body.order_id)).map((l) => [l.name, l.quantity])).toEqual([['Chips', 1]])
    expect(n(`SELECT count(*)::int AS n FROM order_line_events WHERE order_line_id = '${burger.id}' AND to_state = 'voided'`)).toBe(1)
    expect(linesOf(a).map((l) => l.kitchen_state ?? l.bar_state)).toEqual(['voided', 'outstanding'])
    row.layer = '2 terminals (round POST, amend RPC)'
    row.expected = `live ${expected}`
    row.final = `round 200 (+chips), void 200 (burger); live ${f.tab.live_cents}; 1 void event`
  })

  probe('RC-C2 waiter A reduces an item while waiter B adds the same item', async (row) => {
    const tabId = await openTab(2, 'C2')
    const a = await round(tabId, [{ key: 'lager', qty: 3 }])
    const [lager] = linesOf(a)
    hold(either(isInsert('orders'), isRpc('amend_order_lines')), 2)
    const [reduce, add] = await Promise.all([
      amend('a', tabId, [{ line_id: lager.id, new_quantity: 1 }]),
      roundRaw('b', tabId, [{ key: 'lager', qty: 2 }]),
    ])
    row.asked = `held ${released().join(' + ')}`
    expectStatus(reduce, 200)
    expectStatus(add, 200)
    expect(reduce.body.applied[0]).toMatchObject({ line_id: lager.id, action: 'replaced' })
    const f = await financials(tabId)
    expect(f.tab.live_cents).toBe(PRICE.lager * 3) // 1 left from the reduction + 2 added
    const liveLagers = sql<{ q: number }>(`SELECT coalesce(sum(quantity),0)::float AS q FROM order_lines WHERE tab_id='${tabId}' AND bar_state='outstanding'`)[0].q
    expect(liveLagers).toBe(3)

    // C2b: the SAME line, reduced by one terminal and increased by the other, at once.
    const tab2 = await openTab(3, 'C2b')
    const b = await round(tab2, [{ key: 'lager', qty: 3 }])
    const [line] = linesOf(b)
    hold(isRpc('amend_order_lines'), 2)
    const both = await Promise.all([
      amend('a', tab2, [{ line_id: line.id, new_quantity: 1 }]),
      amend('b', tab2, [{ line_id: line.id, new_quantity: 5 }]),
    ])
    released()
    both.forEach((r) => expectStatus(r, 200))
    const applied = both.flatMap((r) => r.body.applied as Json[])
    const refused = both.flatMap((r) => r.body.refused as Json[])
    expect(applied).toHaveLength(1)
    expect(refused.map((r) => r.reason)).toEqual(['window_closed'])
    const winnerQty = both.find((r) => (r.body.applied as Json[]).length === 1)!.body.lines[0].quantity
    expect(n(`SELECT count(*)::int AS n FROM orders WHERE tab_id='${tab2}'`)).toBe(2) // original + ONE replacement
    expect((await financials(tab2)).tab.live_cents).toBe(PRICE.lager * winnerQty)
    row.layer = '2 terminals'
    row.expected = `C2 live ${PRICE.lager * 3}; C2b one winner`
    row.final = `C2 reduce+add both applied, 3 lagers live; C2b one applied (qty ${winnerQty}), one refused window_closed, 1 replacement order`
  })

  probe('RC-C3 two waiters send the same basket at once with different idempotency keys', async (row) => {
    const tabId = await openTab(4, 'C3')
    const basket: Want[] = [{ key: 'burger', qty: 1 }, { key: 'lager', qty: 1 }]
    const keyA = randomUUID()
    const keyB = randomUUID()
    hold(isInsert('orders'), 2)
    const [ra, rb] = await Promise.all([roundRaw('a', tabId, basket, keyA), roundRaw('b', tabId, basket, keyB)])
    row.asked = `held ${released().join(' + ')}`
    expectStatus(ra, 200)
    expectStatus(rb, 200)
    // THE DEFINED OUTCOME: two keys are two sends, so two rounds -- each written exactly once.
    expect([ra.body.duplicate, rb.body.duplicate]).toEqual([false, false])
    expect(ra.body.order_id).not.toBe(rb.body.order_id)
    expect(ra.body.order_number).not.toBe(rb.body.order_number)
    for (const r of [ra, rb]) {
      expect(linesOf(String(r.body.order_id)).map((l) => [l.name, l.quantity])).toEqual([['Burger', 1], ['Lager', 1]])
    }
    expect(n(`SELECT count(*)::int AS n FROM order_lines WHERE tab_id='${tabId}'`)).toBe(4)
    expect((await financials(tabId)).tab.live_cents).toBe(2 * liveOf(basket))
    // Each waiter's own retry is still exactly-once.
    const [replayA, replayB] = await Promise.all([roundRaw('a', tabId, basket, keyA), roundRaw('b', tabId, basket, keyB)])
    expect([replayA.body.duplicate, replayA.body.order_id, replayB.body.duplicate, replayB.body.order_id])
      .toEqual([true, ra.body.order_id, true, rb.body.order_id])
    expect(n(`SELECT count(*)::int AS n FROM order_lines WHERE tab_id='${tabId}'`)).toBe(4)
    row.layer = '2 terminals, 2 keys'
    row.expected = `2 rounds, 4 lines, live ${2 * liveOf(basket)}`
    row.final = `orders #${ra.body.order_number} and #${rb.body.order_number}, 2 lines each; replays duplicate:true, no new lines`
  })

  probe('RC-C4 two waiters cancel the same line at once', async (row) => {
    const tabId = await openTab(5, 'C4')
    const a = await round(tabId, [{ key: 'burger', qty: 2 }, { key: 'espresso', qty: 1 }])
    const [burger] = linesOf(a)
    hold(isRpc('amend_order_lines'), 2)
    const both = await Promise.all([
      amend('a', tabId, [{ line_id: burger.id, new_quantity: 0 }]),
      amend('b', tabId, [{ line_id: burger.id, new_quantity: 0 }]),
    ])
    row.asked = `held ${released().join(' + ')}`
    both.forEach((r) => expectStatus(r, 200))
    const applied = both.flatMap((r) => r.body.applied as Json[])
    const refused = both.flatMap((r) => r.body.refused as Json[])
    expect(applied).toEqual([{ line_id: burger.id, action: 'voided' }])
    expect(refused).toEqual([{ line_id: burger.id, reason: 'window_closed' }])
    expect(n(`SELECT count(*)::int AS n FROM order_line_events WHERE order_line_id = '${burger.id}' AND to_state = 'voided'`)).toBe(1)
    expect((await financials(tabId)).tab.live_cents).toBe(PRICE.espresso)
    row.layer = '2 terminals'
    row.final = '1 applied voided, 1 refused window_closed, 1 void event, live = espresso'
  })

  probe('RC-C5 two terminals amend the same order at once', async (row) => {
    const tabId = await openTab(6, 'C5')
    const a = await round(tabId, [{ key: 'burger', qty: 2 }, { key: 'lager', qty: 3 }, { key: 'salad', qty: 1 }])
    const [, lager, salad] = linesOf(a)
    hold(isRpc('amend_order_lines'), 2)
    const [voidSalad, reduceLager] = await Promise.all([
      amend('a', tabId, [{ line_id: salad.id, new_quantity: 0 }]),
      amend('b', tabId, [{ line_id: lager.id, new_quantity: 2 }]),
    ])
    row.asked = `held ${released().join(' + ')}`
    expectStatus(voidSalad, 200)
    expectStatus(reduceLager, 200)
    expect(voidSalad.body.applied).toEqual([{ line_id: salad.id, action: 'voided' }])
    expect(reduceLager.body.applied[0]).toMatchObject({ line_id: lager.id, action: 'replaced' })
    expect((await financials(tabId)).tab.live_cents).toBe(PRICE.burger * 2 + PRICE.lager * 2)
    // The same reduction sent by both terminals: one replacement, never two.
    const [lager2] = linesOf(String(reduceLager.body.order_id))
    hold(isRpc('amend_order_lines'), 2)
    const same = await Promise.all([
      amend('a', tabId, [{ line_id: lager2.id, new_quantity: 1 }]),
      amend('b', tabId, [{ line_id: lager2.id, new_quantity: 1 }]),
    ])
    released()
    expect(same.flatMap((r) => r.body.applied as Json[])).toHaveLength(1)
    expect(n(`SELECT count(*)::int AS n FROM orders WHERE tab_id='${tabId}'`)).toBe(3) // original + 2 replacements
    const f = await financials(tabId)
    expect(f.tab.live_cents).toBe(PRICE.burger * 2 + PRICE.lager * 1)
    row.layer = '2 terminals'
    row.final = `different lines: both applied; same reduction twice: 1 replacement; live ${f.tab.live_cents}`
  })

  probe('RC-C6 two terminals prepare payment for the same order at once', async (row) => {
    const tabId = await openTab(7, 'C6')
    const A: Want[] = [{ key: 'burger', qty: 1 }, { key: 'lager', qty: 1 }]
    const a = await round(tabId, A)
    hold(isPatch('orders', 'pending_charge_cents'), 2)
    const both = await Promise.all([prepareRaw('a', a, [a]), prepareRaw('b', a, [a])])
    row.asked = `both read the order, then held ${released().join(' + ')} and released together`
    expect(statusesOf(both)).toEqual([200, 409])
    const winnerIdx = both[0].status === 200 ? 0 : 1
    const winner: T = winnerIdx === 0 ? 'a' : 'b'
    const loser: T = winner === 'a' ? 'b' : 'a'
    const lost = both[1 - winnerIdx]
    expect(lost.body).toMatchObject({ code: 'SETTLEMENT_SET_NOT_CLAIMABLE', payment_in_progress_elsewhere: true })
    const mo = String(both[winnerIdx].body.merchantOrderNo)
    expect(orderRow(a)).toMatchObject({ pending_charge_cents: liveOf(A), pending_charge_terminal_id: TERM[winner] })
    // The loser tries again while the winner's reader is open: still refused, nothing overwritten.
    const again = await prepareRaw(loser, a, [a])
    expect({ status: again.status, elsewhere: again.body.payment_in_progress_elsewhere }).toEqual({ status: 409, elsewhere: true })
    expect(orderRow(a).pending_charge_terminal_id).toBe(TERM[winner])
    await started(winner, a, mo)
    const dev = reader(winner, mo, liveOf(A), 'approved')
    expectStatus(await cardSettle(winner, tabId, [a], liveOf(A), mo, dev.voucherNo!), 200)
    expectStatus(await deviceSale(winner, [a], mo, dev.voucherNo!, liveOf(A)), 200)
    expectStatus(await webhook(mo), 200)
    // After it is paid the loser cannot start a second charge, nor settle on the same reference.
    const late = await prepareRaw(loser, a, [a])
    expect({ status: late.status, code: late.body.code }).toEqual({ status: 400, code: 'ALREADY_PAID' })
    const lateSettle = await cardSettle(loser, tabId, [a], liveOf(A), mo, 'LOSER-VOUCHER')
    expect({ status: lateSettle.status, code: lateSettle.body.code }).toEqual({ status: 409, code: 'ALREADY_PAID' })
    const money = tabMoney(tabId)
    expect({ sale: money.saleRows, saleCents: money.saleCents, payments: money.paymentsRows }).toEqual({ sale: 1, saleCents: liveOf(A), payments: 1 })
    expect(gw.asks.filter((x) => x.mo === mo)).toHaveLength(1)
    expect(orderRow(a)).toMatchObject({ payment_status: 'paid', settled_charge_cents: liveOf(A) })
    row.layer = '2 terminals'
    row.expected = `one charge of ${liveOf(A)}`
    row.ledger = `${money.saleRows} sale row ${money.saleCents}; ${money.paymentsRows} payments row`
    row.final = `prepare 200 (${winner}) / 409 in_progress_elsewhere (${loser}); loser retry 409; after paid loser 400 ALREADY_PAID; 1 reader charge`
  })

  probe('RC-C6b two terminals take cash for the same orders at once', async (row) => {
    const tabId = await openTab(8, 'C6b')
    const A: Want[] = [{ key: 'salad', qty: 1 }]
    const B: Want[] = [{ key: 'lager', qty: 2 }]
    const a = await round(tabId, A)
    const b = await round(tabId, B)
    hold(isPatch('orders', 'payment_status'), 2)
    const both = await Promise.all([cashSettle('a', tabId, [a, b], liveOf(A) + liveOf(B)), cashSettle('b', tabId, [a, b], liveOf(A) + liveOf(B))])
    row.asked = `both validated, then held ${released().join(' + ')}`
    expect(statusesOf(both)).toEqual([200, 409])
    const money = tabMoney(tabId)
    expect({ payments: money.paymentsRows, nonGateway: money.nonGatewayRows, cents: money.nonGatewayCents }).toEqual({ payments: 1, nonGateway: 1, cents: liveOf(A) + liveOf(B) })
    expect([orderRow(a).payment_status, orderRow(b).payment_status]).toEqual(['paid', 'paid'])
    row.layer = '2 terminals'
    row.ledger = `${money.paymentsRows} payments, ${money.nonGatewayRows} non_gateway (${money.nonGatewayCents})`
    row.final = `200 + 409 (${both.find((r) => r.status === 409)!.body.code}); paid once`
  })
})

// ================================================================================================
// D -- PAYMENT + ORDERING RACES
// ================================================================================================
describe('D: payment in flight while the tab changes', () => {
  probe('RC-D1 a round added while the payment is being prepared is not charged', async (row) => {
    const tabId = await openTab(10, 'D1')
    const A: Want[] = [{ key: 'burger', qty: 1 }]
    const C: Want[] = [{ key: 'lager', qty: 2 }]
    const a = await round(tabId, A)
    hold(either(isPatch('orders', 'pending_charge_cents'), isInsert('orders')), 2)
    const [prep, add] = await Promise.all([prepareRaw('a', a, [a]), roundRaw('b', tabId, C)])
    row.asked = `held ${released().join(' + ')}`
    expectStatus(prep, 200)
    expectStatus(add, 200)
    const c = String(add.body.order_id)
    const mo = String(prep.body.merchantOrderNo)
    // What the payment covers is fixed at prepare: the intent and the reader figure name order A only.
    expect({ charge: prep.body.chargeCents, ids: prep.body.orderIds }).toEqual({ charge: liveOf(A), ids: [a] })
    expect(sql(`SELECT order_ids FROM terminal_payment_intents WHERE merchant_order_no = '${mo}'`)[0].order_ids).toEqual([a])
    expect(orderRow(c).pending_charge_cents).toBeNull()
    await started('a', a, mo)
    const dev = reader('a', mo, liveOf(A), 'approved')
    // A device that tries to settle the NEW round under this charge is refused: nothing is paid.
    const widened = await cardSettle('a', tabId, [a, c], liveOf(A), mo, dev.voucherNo!)
    expect({ status: widened.status, code: widened.body.code }).toEqual({ status: 400, code: 'AMOUNT_MISMATCH' })
    expect([orderRow(a).payment_status, orderRow(c).payment_status]).toEqual(['pending', 'pending'])
    expectStatus(await cardSettle('a', tabId, [a], liveOf(A), mo, dev.voucherNo!), 200)
    expectStatus(await webhook(mo), 200)
    const f = await financials(tabId)
    expect(f.tab.outstanding_cents).toBe(liveOf(C))
    expect(orderRow(c)).toMatchObject({ payment_status: 'pending', settled_charge_cents: null })
    const money = tabMoney(tabId)
    expect({ sale: money.saleRows, cents: money.saleCents }).toEqual({ sale: 1, cents: liveOf(A) })
    row.layer = '2 terminals (prepare, round)'
    row.expected = `charge ${liveOf(A)}; new round ${liveOf(C)} still owed`
    row.ledger = `1 sale row ${money.saleCents}`
    row.final = `intent [A]; widened settle 400 AMOUNT_MISMATCH; A paid; tab outstanding ${f.tab.outstanding_cents} (the new round)`
  })

  probe('RC-D2 a line on another order can be reduced mid-payment; a line in the payment cannot (D3)', async (row) => {
    const tabId = await openTab(11, 'D2')
    const A: Want[] = [{ key: 'burger', qty: 1 }, { key: 'salad', qty: 1 }]
    const B: Want[] = [{ key: 'lager', qty: 2 }]
    const a = await round(tabId, A)
    const b = await round(tabId, B)
    const [, salad] = linesOf(a)
    const [lager] = linesOf(b)
    const prep = await prepareRaw('a', a, [a])
    expectStatus(prep, 200)
    const mo = String(prep.body.merchantOrderNo)
    await started('a', a, mo)
    hold(isRpc('amend_order_lines'), 2)
    const [inPayment, outside] = await Promise.all([
      amend('b', tabId, [{ line_id: salad.id, new_quantity: 0 }]),
      amend('b', tabId, [{ line_id: lager.id, new_quantity: 1 }]),
    ])
    row.asked = `reader open on A; held ${released().join(' + ')}`
    expectStatus(inPayment, 200)
    expectStatus(outside, 200)
    expect(inPayment.body.refused).toEqual([{ line_id: salad.id, reason: 'payment_in_flight' }])
    expect(outside.body.applied[0]).toMatchObject({ line_id: lager.id, action: 'replaced' })
    const dev = reader('a', mo, liveOf(A), 'approved')
    expectStatus(await cardSettle('a', tabId, [a], liveOf(A), mo, dev.voucherNo!), 200)
    expect(orderRow(a)).toMatchObject({ payment_status: 'paid', settled_charge_cents: liveOf(A) })
    // After the payment: the paid line is refused as paid.
    const late = await amend('b', tabId, [{ line_id: salad.id, new_quantity: 0 }])
    expect(late.body.refused).toEqual([{ line_id: salad.id, reason: 'order_paid' }])
    const f = await financials(tabId)
    expect(f.tab.outstanding_cents).toBe(PRICE.lager * 1)
    row.layer = '1 reader + 2 amend sessions'
    row.final = `in-payment void refused payment_in_flight (then order_paid); other order reduced; A paid ${liveOf(A)}; outstanding ${f.tab.outstanding_cents}`
  })

  probe('RC-D2c a void and a prepare racing on the same order never pay a stale figure', async (row) => {
    const tabId = await openTab(12, 'D2c')
    const A: Want[] = [{ key: 'burger', qty: 1 }, { key: 'salad', qty: 1 }]
    const a = await round(tabId, A)
    const [, salad] = linesOf(a)
    hold(either(isPatch('orders', 'pending_charge_cents'), isRpc('amend_order_lines')), 2)
    const [prep, cut] = await Promise.all([prepareRaw('a', a, [a]), amend('b', tabId, [{ line_id: salad.id, new_quantity: 0 }])])
    const held = released()
    expectStatus(cut, 200)
    const voided = (cut.body.applied as Json[]).length === 1
    let outcome: string
    if (prep.status === 200) {
      // The prepare won: the void must have been refused, and the charge is the unvoided figure.
      expect(voided).toBe(false)
      expect(cut.body.refused).toEqual([{ line_id: salad.id, reason: 'payment_in_flight' }])
      expect(prep.body.chargeCents).toBe(liveOf(A))
      outcome = 'prepare first: void refused payment_in_flight, charge = full'
    } else {
      // The void won: the prepare's figure was stale and refused; nothing recorded.
      expect({ status: prep.status, code: prep.body.code }).toEqual({ status: 409, code: 'ORDER_CHANGED_DURING_PREPARE' })
      expect(voided).toBe(true)
      expect(orderRow(a).pending_charge_cents).toBeNull()
      outcome = 'void first: prepare 409 ORDER_CHANGED_DURING_PREPARE, nothing recorded'
    }
    // Either way the next charge is exactly the live figure and settles.
    const live = (await financials(tabId)).tab.live_cents
    const p2 = prep.status === 200 ? prep : await prepareRaw('a', a, [a])
    expectStatus(p2, 200)
    expect(p2.body.chargeCents).toBe(live)
    const mo = String(p2.body.merchantOrderNo)
    const dev = reader('a', mo, live, 'approved')
    expectStatus(await cardSettle('a', tabId, [a], live, mo, dev.voucherNo!), 200)
    expect(orderRow(a).settled_charge_cents).toBe(live)
    row.layer = '2 terminals (prepare PATCH, amend RPC)'
    row.asked = `held ${held.join(' + ')}`
    row.final = `${outcome}; paid ${live} = live`
  })

  probe('RC-D5 a guest-style edit racing the prepare is refused or refuses it (FTINF / FTCHG)', async (row) => {
    const tabId = await openTab(13, 'D5')
    const A: Want[] = [{ key: 'cheesecake', qty: 1 }]
    const a = await round(tabId, A)
    // A customer order is what the guest editor rewrites; strip the lines so the editor's write is legal.
    sqlExec(`DELETE FROM order_line_events WHERE order_line_id IN (SELECT id FROM order_lines WHERE order_id = '${a}');
             DELETE FROM order_lines WHERE order_id = '${a}'; UPDATE orders SET channel = 'table' WHERE id = '${a}';`)
    const items = sql<{ items: Json[] }>(`SELECT items FROM orders WHERE id = '${a}'`)[0].items
    const guestEdit = () =>
      realFetch(`${REST_URL}/rest/v1/orders?id=eq.${a}`, {
        method: 'PATCH',
        headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({ items: [...items, { name: 'Espresso', quantity: 1, price: 26, total: 26 }], total: (liveOf(A) + PRICE.espresso) / 100 }),
      }).then(async (r) => ({ status: r.status, body: r.status >= 300 ? await r.json() : {} }))
    const prep0 = await prepareRaw('a', a, [a]) // first, so the edit is certainly mid-payment
    expectStatus(prep0, 200)
    const refusedEdit = await guestEdit()
    expect({ status: refusedEdit.status, code: refusedEdit.body.code }).toEqual({ status: 400, code: 'FTINF' })
    const mo = String(prep0.body.merchantOrderNo)
    const dev = reader('a', mo, liveOf(A), 'approved')
    expectStatus(await cardSettle('a', tabId, [a], liveOf(A), mo, dev.voucherNo!), 200)
    expect(orderRow(a)).toMatchObject({ payment_status: 'paid', settled_charge_cents: liveOf(A) })
    expect(cents(orderRow(a).total)).toBe(liveOf(A))
    row.layer = 'reader + PostgREST write'
    row.final = 'edit mid-payment 400 FTINF; paid at the unedited figure (two-session proof: charge-edit-race.test.sh rounds 1,2,5)'
  })
})

// ================================================================================================
// E7 -- PAID, THEN CLOSED AT ONCE
// ================================================================================================
describe('E7: payment then immediate close', () => {
  probe('RC-E7 a card settlement and a table close racing: payment and allocation kept, nothing twice', async (row) => {
    const tabId = await openTab(15, 'E7')
    const A: Want[] = [{ key: 'burger', qty: 1 }, { key: 'lager', qty: 1 }]
    const B: Want[] = [{ key: 'salad', qty: 1 }]
    const a = await round(tabId, A)
    const b = await round(tabId, B)
    // The salad is paid for by one guest, by split card (an allocation).
    const [salad] = linesOf(b)
    const alloc = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${salad.id}/allocate`, {
      params: { tabId, lineId: salad.id }, body: { shares: [{ allocated_to: 'Guest', quantity_allocated: 1 }] },
    })
    expectStatus(alloc, 200)
    const split = await call(prepareSplit, `/api/terminal/tabs/${tabId}/prepare-split-payment`, {
      params: { tabId }, body: { allocation_ids: (alloc.body.allocations as Json[]).map((x) => String(x.id)) },
    })
    expectStatus(split, 200)
    const d1 = reader('a', split.body.merchant_order_no, split.body.amount_cents, 'approved')
    expectStatus(await call(recordSplit, `/api/terminal/tabs/${tabId}/record-split-payment`, {
      params: { tabId }, body: { merchant_order_no: split.body.merchant_order_no, outcome: 'success', transaction_id: d1.voucherNo },
    }), 200)
    // The rest by card; the confirmation and the close race.
    const prep = await prepareRaw('a', a, [a])
    expectStatus(prep, 200)
    const mo = String(prep.body.merchantOrderNo)
    const dev = reader('a', mo, liveOf(A), 'approved')
    hold(either(isPatch('orders', 'payment_status'), isRpc('close_table_session')), 2)
    const [settled, closed] = await Promise.all([cardSettle('a', tabId, [a], liveOf(A), mo, dev.voucherNo!), close('b', 15)])
    row.asked = `held ${released().join(' + ')}`
    expectStatus(settled, 200)
    let closeOutcome = `close ${closed.status}`
    if (closed.status !== 200) {
      // The close read the tab while the card was still being recorded, and refused. Closing again works.
      expect(closed.body.code).toBe('TAB_HAS_OUTSTANDING_BALANCE')
      expectStatus(await close('b', 15), 200)
      closeOutcome = `close 409 (read before the claim), second close 200`
    }
    // Closed again straight away: idempotent, nothing moves.
    expectStatus(await close('a', 15), 200)
    expectStatus(await deviceSale('a', [a], mo, dev.voucherNo!, liveOf(A)), 200)
    expectStatus(await webhook(mo), 200)
    const money = tabMoney(tabId)
    // The split-card charge lives in the item ledger, the whole-order card charge in payment_events.
    expect({ sale: money.saleRows, saleCents: money.saleCents, alloc: money.allocCents }).toEqual({ sale: 1, saleCents: liveOf(A), alloc: PRICE.salad })
    expect(orderRow(a)).toMatchObject({ payment_status: 'paid', settled_charge_cents: liveOf(A) })
    expect(orderRow(b).payment_status).toBe('paid')
    expect(sql(`SELECT status FROM tabs WHERE id = '${tabId}'`)[0].status).toBe('settled')
    expect(n(`SELECT count(*)::int AS n FROM order_line_allocation_settlements WHERE tab_id = '${tabId}'`)).toBe(1)
    row.layer = '2 terminals (card claim, close RPC)'
    row.ledger = `${money.saleRows} sale rows ${money.saleCents}`
    row.allocated = `alloc ${money.allocCents} kept`
    row.final = `settle 200; ${closeOutcome}; tab settled; orders paid once`
  })

  probe('RC-E7b the ordinary close refuses a table that still owes money', async (row) => {
    const tabId = await openTab(16, 'E7b')
    const a = await round(tabId, [{ key: 'espresso', qty: 2 }])
    const res = await close('a', 16)
    expect({ status: res.status, code: res.body.code, owed: res.body.outstanding_cents }).toEqual({ status: 409, code: 'TAB_HAS_OUTSTANDING_BALANCE', owed: PRICE.espresso * 2 })
    expect(sql(`SELECT status FROM tabs WHERE id = '${tabId}'`)[0].status).toBe('open')
    expect(orderRow(a).payment_status).toBe('pending')
    // Paid, it closes.
    expectStatus(await cashSettle('a', tabId, [a], PRICE.espresso * 2), 200)
    expectStatus(await close('a', 16), 200)
    expect(sql(`SELECT status FROM tabs WHERE id = '${tabId}'`)[0].status).toBe('settled')
    row.final = 'owed: 409 TAB_HAS_OUTSTANDING_BALANCE, tab stays open; paid: 200 settled'
  })
})

// ================================================================================================
// D4 -- A SECOND CHARGE ON ONE REFERENCE (after the in-flight window)
// ================================================================================================
describe('D4: another terminal takes over a dead attempt', () => {
  probe('RC-D4 takeover after the window; if both readers answer, the second sale is flagged, never absorbed', async (row) => {
    const tabId = await openTab(18, 'D4')
    const A: Want[] = [{ key: 'burger', qty: 1 }]
    const a = await round(tabId, A)
    const p1 = await prepareRaw('a', a, [a])
    expectStatus(p1, 200)
    const mo = String(p1.body.merchantOrderNo)
    await started('a', a, mo)
    // Terminal A's reader sits unanswered past the window; terminal B may now take the payment.
    sqlExec(`UPDATE orders SET pending_charge_at = now() - interval '6 minutes' WHERE id = '${a}';`)
    const p2 = await prepareRaw('b', a, [a])
    expectStatus(p2, 200)
    expect(p2.body.merchantOrderNo).toBe(mo)
    expect(orderRow(a).pending_charge_terminal_id).toBe(TERM.b)
    const devB = reader('b', mo, liveOf(A), 'approved')
    expectStatus(await cardSettle('b', tabId, [a], liveOf(A), mo, devB.voucherNo!), 200)
    expectStatus(await deviceSale('b', [a], mo, devB.voucherNo!, liveOf(A)), 200)
    // ...and then terminal A's abandoned reader is answered too: a second, real charge.
    gw.txnSeq += 1
    const txnA = `RACES-TXN-${gw.txnSeq}`
    gw.asks.push({ mo, cents: liveOf(A), outcome: 'approved', terminal: 'a' })
    const saleA = await deviceSale('a', [a], mo, txnA, liveOf(A))
    expect({ status: saleA.status, code: saleA.body.code }).toEqual({ status: 409, code: 'SALE_REPORTED_BY_ANOTHER_TERMINAL' })
    const flagged = sql<{ reason: string; txn: string }>(
      `SELECT metadata->>'reason' AS reason, metadata->>'attemptedTransactionId' AS txn FROM audit_logs
        WHERE restaurant_id = '${R}' AND action = 'payment.refused_already_paid' AND metadata->>'attemptedReference' = '${mo}'`,
    )
    expect(flagged).toEqual([{ reason: 'sale_reported_by_another_terminal', txn: txnA }])
    expect(tabMoney(tabId).saleRows).toBe(1)
    expect(orderRow(a)).toMatchObject({ payment_status: 'paid', settled_charge_cents: liveOf(A) })
    row.layer = '2 terminals, sequential by design (window lapse)'
    row.final = 'B took over after 6 min; B paid once; A\'s late sale 409 SALE_REPORTED_BY_ANOTHER_TERMINAL + probable-double-charge audit'
  })
})

describe('D4u: an attempt whose outcome is unknown', () => {
  probe('RC-D4u after an unknown card result no terminal can charge again until it is checked', async (row) => {
    const tabId = await openTab(19, 'D4u')
    const A: Want[] = [{ key: 'salad', qty: 1 }, { key: 'lager', qty: 1 }]
    const a = await round(tabId, A)
    const p1 = await prepareRaw('a', a, [a])
    expectStatus(p1, 200)
    const mo = String(p1.body.merchantOrderNo)
    await started('a', a, mo)
    // The P5 answers 9027; Finatic has no record yet. The terminal verifies, then reports it unconfirmed.
    const dev = reader('a', mo, liveOf(A), 'no_answer')
    const v = await call(verifyPayment, `/api/terminal/orders/${a}/verify-payment`, { params: { orderId: a }, body: {} })
    // E04111 is never a definite answer: the typed field the terminal reads says so.
    expect(v.body).toMatchObject({ paid: false, isE04111: true, attemptResolution: 'unresolved' })
    const cb = await call(orderPayment, `/api/terminal/orders/${a}/payment`, {
      params: { orderId: a },
      body: { status: 'failed', reference: `UNCONFIRMED-${Date.now()}`, amount: liveOf(A) / 100, paymentMethod: 'card', businessOrderNo: mo, gatewayResult: dev.gatewayResult },
    })
    expect(cb.body).toMatchObject({ outcome: 'left_pending_finatic_uncertain' })
    // Pay again -- the same terminal and the other one, at once: both refused, nothing re-armed.
    const retries = await Promise.all([prepareRaw('a', a, [a]), prepareRaw('b', a, [a])])
    for (const r of retries) {
      expect({ status: r.status, code: r.body.code, refusal: r.body.refusal }).toEqual({ status: 409, code: 'SETTLEMENT_SET_NOT_CLAIMABLE', refusal: 'PAYMENT_ATTEMPT_UNRESOLVED' })
    }
    // Even once the in-flight window has passed: an unknown outcome does not lapse.
    sqlExec(`UPDATE orders SET pending_charge_at = now() - interval '10 minutes' WHERE id = '${a}';`)
    const late = await prepareRaw('b', a, [a])
    expect({ status: late.status, refusal: late.body.refusal }).toEqual({ status: 409, refusal: 'PAYMENT_ATTEMPT_UNRESOLVED' })
    expect(gw.asks.filter((x) => x.mo === mo)).toHaveLength(1)
    // The card HAD gone through. "Check payment status" finds it and settles it, once.
    gw.txnSeq += 1
    gw.state.set(mo, { kind: 'paid', cents: liveOf(A), txn: `RACES-TXN-${gw.txnSeq}` })
    const check = await call(verifyPayment, `/api/terminal/orders/${a}/verify-payment`, { params: { orderId: a }, body: {} })
    expect(check.body).toMatchObject({ paid: true, applied: true })
    expect(orderRow(a)).toMatchObject({ payment_status: 'paid', settled_charge_cents: liveOf(A) })
    expect(tabMoney(tabId).saleRows).toBe(1)

    // A definitive decline is NOT unresolved: the retry after it is allowed.
    const tab2 = await openTab(28, 'D4u-decline')
    const b = await round(tab2, [{ key: 'burger', qty: 1 }])
    const q1 = await prepareRaw('a', b, [b])
    const mo2 = String(q1.body.merchantOrderNo)
    const d2 = reader('a', mo2, PRICE.burger, 'declined')
    expectStatus(await call(orderPayment, `/api/terminal/orders/${b}/payment`, {
      params: { orderId: b },
      body: { status: 'failed', reference: `DECLINED-N003-${Date.now()}`, amount: PRICE.burger / 100, paymentMethod: 'card', businessOrderNo: mo2, gatewayResult: d2.gatewayResult },
    }), 200)
    expectStatus(await prepareRaw('b', b, [b]), 200)
    row.layer = '2 terminals (concurrent retries)'
    row.final = 'unknown result: same-terminal + other-terminal retries 409 PAYMENT_ATTEMPT_UNRESOLVED (also past the window); Check found it paid -> settled once; after a decline the retry is 200'
  })
})

describe('D4r: an unresolved attempt is never stuck, and never cleared without evidence', () => {
  const unresolvedOf = (id: string) => sql<{ u: boolean }>(`SELECT pending_charge_unresolved_at IS NOT NULL AS u FROM orders WHERE id = '${id}'`)[0].u
  /** A card attempt the P5 answered 9027 for, reported unconfirmed after a Check found no record. */
  async function unknownAttempt(tableNo: number, label: string, wants: Want[]) {
    const tabId = await openTab(tableNo, label)
    const a = await round(tabId, wants)
    const p = await prepareRaw('a', a, [a])
    expectStatus(p, 200)
    const mo = String(p.body.merchantOrderNo)
    await started('a', a, mo)
    reader('a', mo, liveOf(wants), 'no_answer')
    await call(verifyPayment, `/api/terminal/orders/${a}/verify-payment`, { params: { orderId: a }, body: {} })
    const cb = await call(orderPayment, `/api/terminal/orders/${a}/payment`, {
      params: { orderId: a },
      body: { status: 'failed', reference: `UNCONFIRMED-${Date.now()}`, amount: liveOf(wants) / 100, paymentMethod: 'card', businessOrderNo: mo, gatewayResult: '9027' },
    })
    expect(cb.body).toMatchObject({ outcome: 'left_pending_finatic_uncertain' })
    expect(unresolvedOf(a)).toBe(true)
    return { tabId, a, mo }
  }

  probe('RC-D4r resolution: gateway decline releases it; E04111 for ever never auto-clears; staff cancel at the gateway clears it', async (row) => {
    const steps: string[] = []
    // (i) Finatic later records the attempt as DECLINED: the terminal's Check says not paid, it reports
    //     the failure, the recognised decline releases the attempt, and the retry is allowed.
    const i = await unknownAttempt(29, 'D4r-i', [{ key: 'burger', qty: 1 }])
    gw.state.set(i.mo, { kind: 'declined', cents: PRICE.burger, code: 'N003' })
    // "Check payment status": a RECOGNISED not-paid is evidence. The attempt is released server-side
    // (the order stays owed) and the answer is the typed definite value the terminal clears its block on.
    const chk = await call(verifyPayment, `/api/terminal/orders/${i.a}/verify-payment`, { params: { orderId: i.a }, body: {} })
    expect(chk.body).toMatchObject({ paid: false, attemptResolution: 'resolved_not_paid' })
    expect({ pending: orderRow(i.a).pending_charge_cents, unresolved: unresolvedOf(i.a), ps: orderRow(i.a).payment_status })
      .toEqual({ pending: null, unresolved: false, ps: 'pending' })
    expect(n(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = '${i.a}' AND action = 'payment.unresolved_attempt_released'`)).toBe(1)
    expect(sql(`SELECT status FROM terminal_payment_intents WHERE merchant_order_no = '${i.mo}'`)[0].status).toBe('failed')
    expectStatus(await prepareRaw('b', i.a, [i.a]), 200)
    steps.push('gateway recognised not-paid -> Check answers resolved_not_paid, attempt released (audited), order still owed -> retry 200')

    // (ii) Finatic NEVER registers it (E04111 for ever). Repeated Checks, and time, clear nothing.
    const ii = await unknownAttempt(30, 'D4r-ii', [{ key: 'espresso', qty: 2 }])
    for (let k = 0; k < 3; k += 1) {
      const c = await call(verifyPayment, `/api/terminal/orders/${ii.a}/verify-payment`, { params: { orderId: ii.a }, body: {} })
      expect(c.body).toMatchObject({ paid: false, isE04111: true, attemptResolution: 'unresolved' })
    }
    sqlExec(`UPDATE orders SET pending_charge_at = now() - interval '2 hours' WHERE id = '${ii.a}';`)
    expect({ unresolved: unresolvedOf(ii.a), pending: orderRow(ii.a).pending_charge_cents }).toEqual({ unresolved: true, pending: PRICE.espresso * 2 })
    expect((await prepareRaw('a', ii.a, [ii.a])).body.refusal).toBe('PAYMENT_ATTEMPT_UNRESOLVED')
    steps.push('E04111 x3 Checks + 2h later: still unresolved, card refused')
    // The staff path: a manager cancels the attempt from the dashboard. The GATEWAY closes the
    // reference (the evidence that it can never be charged), the expectation and the old reference
    // are cleared in one statement, and the status change is written down.
    const cancel = await call(cancelTerminal, '/api/payments/cancel-terminal', { auth: 'Bearer races-manager', body: { orderId: ii.a } })
    expectStatus(cancel, 200)
    expect(gw.closes).toContain(ii.mo)
    expect({ unresolved: unresolvedOf(ii.a), pending: orderRow(ii.a).pending_charge_cents }).toEqual({ unresolved: false, pending: null })
    expect(n(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = '${ii.a}' AND action = 'payment_status.changed'`)).toBeGreaterThanOrEqual(1)
    const after = await call(verifyPayment, `/api/terminal/orders/${ii.a}/verify-payment`, { params: { orderId: ii.a }, body: {} })
    expect(after.body).toMatchObject({ paid: false, attemptResolution: 'resolved_not_paid' })
    const retry = await prepareRaw('a', ii.a, [ii.a])
    expectStatus(retry, 200)
    expect(retry.body.merchantOrderNo).not.toBe(ii.mo) // a fresh reference: the old one is closed at the gateway
    steps.push('manager cancel-terminal: gateway closed the reference -> cleared + audited -> card retry 200 on a NEW reference')
    row.final = steps.join(' | ')
  })

  probe('RC-D4r2 resolution: a cancel the gateway refuses keeps the mark; the ruled cash path releases a stale attempt', async (row) => {
    const steps: string[] = []

    // (iii) The cancel is refused when the gateway says the card WAS paid: the mark stays, and Check settles it.
    const iii = await unknownAttempt(31, 'D4r-iii', [{ key: 'chips', qty: 1 }])
    gw.txnSeq += 1
    gw.state.set(iii.mo, { kind: 'paid', cents: PRICE.chips, txn: `RACES-TXN-${gw.txnSeq}` })
    const refusedCancel = await call(cancelTerminal, '/api/payments/cancel-terminal', { auth: 'Bearer races-manager', body: { orderId: iii.a } })
    expect(refusedCancel.status).toBe(400)
    expect(unresolvedOf(iii.a)).toBe(true)
    expect((await call(verifyPayment, `/api/terminal/orders/${iii.a}/verify-payment`, { params: { orderId: iii.a }, body: {} })).body).toMatchObject({ paid: true, applied: true })
    expect(orderRow(iii.a).payment_status).toBe('paid')
    steps.push('cancel refused (gateway: already paid) -> mark kept -> Check settled it once')

    // (iv) The existing ruled cash path (20260929140000): past the window a cash settlement releases the
    //      stale attempt, audited; a late confirmation of it would be held as paid by another payment.
    const iv = await unknownAttempt(32, 'D4r-iv', [{ key: 'lager', qty: 1 }])
    const early = await cashSettle('b', iv.tabId, [iv.a], PRICE.lager)
    expect({ status: early.status, code: early.body.code }).toEqual({ status: 409, code: 'PAYMENT_IN_FLIGHT' })
    // Real time passing ages the attempt AND its intent together.
    sqlExec(`UPDATE orders SET pending_charge_at = now() - interval '6 minutes' WHERE id = '${iv.a}';
             UPDATE terminal_payment_intents SET created_at = now() - interval '6 minutes' WHERE merchant_order_no = '${iv.mo}';`)
    expectStatus(await cashSettle('b', iv.tabId, [iv.a], PRICE.lager), 200)
    expect(n(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = '${iv.a}' AND action = 'payment.stale_card_attempt_released'`)).toBe(1)
    expect(orderRow(iv.a).payment_status).toBe('paid')
    steps.push('cash inside the window 409; past it the stale attempt is released (audited) and cash is taken')
    row.final = steps.join(' | ')
  })
})

describe('E7c: the close routes', () => {
  probe('RC-E7c walkout close still writes off an owed tab; a zero-balance tab closes on the ordinary route', async (row) => {
    // Owed: the ordinary close refuses, the manager-PIN walkout closes it and records no payment.
    const tabId = await openTab(33, 'E7c')
    const a = await round(tabId, [{ key: 'burger', qty: 1 }])
    const plain = await close('a', 33)
    expect({ status: plain.status, code: plain.body.code }).toEqual({ status: 409, code: 'TAB_HAS_OUTSTANDING_BALANCE' })
    const tokenId = randomUUID()
    sqlExec(`INSERT INTO public.privileged_authorization_tokens (id, user_id, restaurant_id, terminal_id, purpose, nonce, ttl_seconds, expires_at)
             VALUES ('${tokenId}', '${MANAGER}', '${R}', '${TERM.a}', 'walkout_close', '${randomUUID()}', 90, now() + interval '90 seconds');`)
    const t = tableId(33)
    const walk = await call(walkoutClose, `/api/terminal/tables/${t}/walkout-close`, {
      params: { tableId: t }, body: { reason: 'Guests left without paying', staff_user_id: MANAGER, authorization_token_id: tokenId },
    })
    expectStatus(walk, 200)
    expect(sql(`SELECT status FROM tabs WHERE id = '${tabId}'`)[0].status).toBe('settled')
    expect(orderRow(a).payment_status).toBe('pending') // the debt stays visible, nothing recorded as paid
    const money = tabMoney(tabId)
    expect({ sale: money.saleRows, ng: money.nonGatewayRows, payments: money.paymentsRows }).toEqual({ sale: 0, ng: 0, payments: 0 })

    // Zero balance because every line was cancelled: the ordinary close works.
    const tab2 = await openTab(34, 'E7c-zero')
    const b = await round(tab2, [{ key: 'espresso', qty: 1 }])
    const [esp] = linesOf(b)
    expectStatus(await amend('a', tab2, [{ line_id: esp.id, new_quantity: 0 }]), 200)
    expectStatus(await close('a', 34), 200)
    expect(sql(`SELECT status FROM tabs WHERE id = '${tab2}'`)[0].status).toBe('settled')
    expect(orderRow(b).payment_status).toBe('pending') // live 0, still 'pending': owed is the projection's call

    // rc-life's R2 shape on a FULLY SETTLED tab: one order paid, one order entirely voided, and one
    // reduced onto a replacement that was then paid. Two orders stay payment_status 'pending' at
    // live 0; the projection says nothing is owed, so the ordinary close works.
    const tab3 = await openTab(35, 'E7c-R2')
    const paid = await round(tab3, [{ key: 'burger', qty: 1 }])
    const voided = await round(tab3, [{ key: 'cheesecake', qty: 1 }])
    const reduced = await round(tab3, [{ key: 'lager', qty: 2 }])
    const [cake] = linesOf(voided)
    const [lg] = linesOf(reduced)
    expectStatus(await amend('a', tab3, [{ line_id: cake.id, new_quantity: 0 }]), 200)
    const cut = await amend('b', tab3, [{ line_id: lg.id, new_quantity: 1 }])
    expectStatus(cut, 200)
    const replacement = String(cut.body.order_id)
    const beforePay = await close('a', 35)
    expect({ status: beforePay.status, owed: beforePay.body.outstanding_cents }).toEqual({ status: 409, owed: PRICE.burger + PRICE.lager })
    expectStatus(await cashSettle('a', tab3, [paid, replacement], PRICE.burger + PRICE.lager), 200)
    expect([orderRow(voided).payment_status, orderRow(reduced).payment_status]).toEqual(['pending', 'pending'])
    expect((await financials(tab3)).tab.outstanding_cents).toBe(0)
    expectStatus(await close('a', 35), 200)
    expect(sql(`SELECT status FROM tabs WHERE id = '${tab3}'`)[0].status).toBe('settled')
    row.final = 'owed: close 409, walkout (PIN) 200 with order still pending + no payment rows; all-voided tab: close 200; ' +
      'settled tab holding a fully-voided and a reduced-away order (both pending, live 0): 409 while owed, 200 once paid'
  })
})

// ================================================================================================
// K -- CASH vs CARD: ledger, order history and the cash-up, per method
// ================================================================================================
describe('K: what each payment method records, and what the cash-up shows', () => {
  const kRows: Array<{ k: string; table: number; taken: number; method: string }> = []
  async function cashUpFor(table: number) {
    const tz = sql<{ tz: string | null }>(`SELECT timezone AS tz FROM restaurants WHERE id = '${R}'`)[0].tz || 'Africa/Windhoek'
    const range = resolveDateRangePreset('today', { timeZone: tz })
    const rep = await getReportData({ restaurantId: R, startDate: range.startDate, endDate: range.endDate, dateBasis: 'paid', tableNumber: tableNumber(table) })
    return {
      revenue: Math.round(rep.summary.totalRevenue * 100),
      split: Object.fromEntries(rep.summary.paymentMethodSplit.map((s: { method: string; gross: number }) => [s.method, Math.round(s.gross * 100)])),
      orders: rep.orders.length,
    }
  }
  async function historyFor(tabId: string) {
    const hist = await call(orderHistory, `/api/orders/history?restaurantId=${R}&startDate=2026-01-01&endDate=2099-12-31`, { method: 'GET', auth: 'Bearer races-manager' })
    expectStatus(hist, 200)
    return (hist.body.orders as Json[]).filter((o) => o.tab_id === tabId)
      .map((o) => `${o.payment_method}/${o.payment_status}/live ${cents(o.live_amount)}`).sort()
  }
  function record(row: Row, k: string, money: ReturnType<typeof tabMoney>, cashUp: Awaited<ReturnType<typeof cashUpFor>>, hist: string[], taken: number, note: string) {
    const contradiction = cashUp.revenue !== taken
    row.layer = 'terminal + dashboard'
    row.expected = `taken ${taken}`
    row.ledger = `sale ${money.saleCents} (${money.saleRows}), non_gateway ${money.nonGatewayCents} (${money.nonGatewayRows}), alloc ${money.allocCents}`
    row.allocated = `history ${hist.join('; ') || 'none'}`
    row.final = `cash-up revenue ${cashUp.revenue} split ${JSON.stringify(cashUp.split)}${contradiction ? ' <-- CONTRADICTS money taken' : ''}; ${note}`
  }

  probe('RC-K1 cash', async (row) => {
    const tabId = await openTab(20, 'K1')
    const a = await round(tabId, [{ key: 'burger', qty: 1 }])
    expectStatus(await cashSettle('a', tabId, [a], PRICE.burger), 200)
    const money = tabMoney(tabId)
    expect({ sale: money.saleRows, ng: money.nonGatewayCents }).toEqual({ sale: 0, ng: PRICE.burger })
    expect(orderRow(a).payment_method).toBe('cash')
    const cu = await cashUpFor(20)
    expect(cu).toEqual({ revenue: PRICE.burger, split: { cash: PRICE.burger }, orders: 1 })
    record(row, 'K1', money, cu, await historyFor(tabId), PRICE.burger, 'consistent')
  })

  probe('RC-K2 card', async (row) => {
    const tabId = await openTab(21, 'K2')
    const a = await round(tabId, [{ key: 'lager', qty: 2 }])
    const p = await prepareRaw('a', a, [a])
    const mo = String(p.body.merchantOrderNo)
    const dev = reader('a', mo, PRICE.lager * 2, 'approved')
    expectStatus(await cardSettle('a', tabId, [a], PRICE.lager * 2, mo, dev.voucherNo!), 200)
    const money = tabMoney(tabId)
    expect({ sale: money.saleCents, ng: money.nonGatewayRows }).toEqual({ sale: PRICE.lager * 2, ng: 0 })
    const cu = await cashUpFor(21)
    expect(cu).toEqual({ revenue: PRICE.lager * 2, split: { card: PRICE.lager * 2 }, orders: 1 })
    record(row, 'K2', money, cu, await historyFor(tabId), PRICE.lager * 2, 'consistent')
  })

  probe('RC-K3 partial card (one item by split card, the rest still owed)', async (row) => {
    const tabId = await openTab(22, 'K3')
    const a = await round(tabId, [{ key: 'burger', qty: 1 }, { key: 'chips', qty: 1 }])
    const [, chips] = linesOf(a)
    const alloc = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${chips.id}/allocate`, {
      params: { tabId, lineId: chips.id }, body: { shares: [{ allocated_to: 'Guest', quantity_allocated: 1 }] },
    })
    const split = await call(prepareSplit, `/api/terminal/tabs/${tabId}/prepare-split-payment`, {
      params: { tabId }, body: { allocation_ids: (alloc.body.allocations as Json[]).map((x) => String(x.id)) },
    })
    const d = reader('a', split.body.merchant_order_no, split.body.amount_cents, 'approved')
    expectStatus(await call(recordSplit, `/api/terminal/tabs/${tabId}/record-split-payment`, {
      params: { tabId }, body: { merchant_order_no: split.body.merchant_order_no, outcome: 'success', transaction_id: d.voucherNo },
    }), 200)
    const money = tabMoney(tabId)
    expect(money.allocCents).toBe(PRICE.chips)
    expect((await financials(tabId)).tab.outstanding_cents).toBe(PRICE.burger)
    const cu = await cashUpFor(22)
    // WHAT THE CASH-UP SHOWS TODAY (orders.total of COMPLETED orders; owner ruling pending): nothing.
    expect(cu.revenue).toBe(0)
    record(row, 'K3', money, cu, await historyFor(tabId), PRICE.chips, 'part-payment taken by card is absent from the cash-up until the order completes')
  })

  probe('RC-K4 card, then cash for the rest of the same order', async (row) => {
    const tabId = await openTab(23, 'K4')
    const a = await round(tabId, [{ key: 'salad', qty: 1 }, { key: 'espresso', qty: 1 }])
    const [salad] = linesOf(a)
    const alloc = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${salad.id}/allocate`, {
      params: { tabId, lineId: salad.id }, body: { shares: [{ allocated_to: 'Guest', quantity_allocated: 1 }] },
    })
    const split = await call(prepareSplit, `/api/terminal/tabs/${tabId}/prepare-split-payment`, {
      params: { tabId }, body: { allocation_ids: (alloc.body.allocations as Json[]).map((x) => String(x.id)) },
    })
    const d = reader('a', split.body.merchant_order_no, split.body.amount_cents, 'approved')
    expectStatus(await call(recordSplit, `/api/terminal/tabs/${tabId}/record-split-payment`, {
      params: { tabId }, body: { merchant_order_no: split.body.merchant_order_no, outcome: 'success', transaction_id: d.voucherNo },
    }), 200)
    // Cash for what is left (the espresso) -- the settle route charges the OUTSTANDING figure.
    expectStatus(await cashSettle('a', tabId, [a], PRICE.espresso), 200)
    const money = tabMoney(tabId)
    expect({ alloc: money.allocCents, ng: money.nonGatewayCents }).toEqual({ alloc: PRICE.salad, ng: PRICE.espresso })
    expect(orderRow(a)).toMatchObject({ payment_status: 'paid', payment_method: 'cash' })
    const cu = await cashUpFor(23)
    // Today: the whole order under 'cash' (orders.payment_method + orders.total).
    expect(cu).toEqual({ revenue: PRICE.salad + PRICE.espresso, split: { cash: PRICE.salad + PRICE.espresso }, orders: 1 })
    record(row, 'K4', money, cu, await historyFor(tabId), PRICE.salad + PRICE.espresso,
      `total right, METHOD WRONG: ${PRICE.salad} was card (item ledger) but the cash-up files all ${PRICE.salad + PRICE.espresso} under cash -- the drawer is short by ${PRICE.salad}`)
  })

  probe('RC-K5 decline', async (row) => {
    const tabId = await openTab(24, 'K5')
    const a = await round(tabId, [{ key: 'burger', qty: 1 }])
    const p = await prepareRaw('a', a, [a])
    const mo = String(p.body.merchantOrderNo)
    const dev = reader('a', mo, PRICE.burger, 'declined')
    const cb = await call(orderPayment, `/api/terminal/orders/${a}/payment`, {
      params: { orderId: a },
      body: { status: 'failed', reference: `DECLINED-${dev.gatewayResult}-${Date.now()}`, amount: PRICE.burger / 100, paymentMethod: 'card', businessOrderNo: mo, gatewayResult: dev.gatewayResult },
    })
    expectStatus(cb, 200)
    const money = tabMoney(tabId)
    expect({ sale: money.saleRows, ng: money.nonGatewayRows, alloc: money.allocCents }).toEqual({ sale: 0, ng: 0, alloc: 0 })
    expect(orderRow(a)).toMatchObject({ payment_status: 'pending', pending_charge_cents: null, pending_charge_terminal_id: null })
    const cu = await cashUpFor(24)
    expect(cu.revenue).toBe(0)
    record(row, 'K5', money, cu, await historyFor(tabId), 0, 'nothing taken, nothing recorded, attempt released')
  })

  probe('RC-K6 unknown card result (P5 9027, Finatic has no record)', async (row) => {
    const tabId = await openTab(25, 'K6')
    const a = await round(tabId, [{ key: 'lager', qty: 1 }])
    const p = await prepareRaw('a', a, [a])
    const mo = String(p.body.merchantOrderNo)
    const dev = reader('a', mo, PRICE.lager, 'no_answer')
    const v = await call(verifyPayment, `/api/terminal/orders/${a}/verify-payment`, { params: { orderId: a }, body: {} })
    expect(v.body).toMatchObject({ paid: false, isE04111: true })
    const cb = await call(orderPayment, `/api/terminal/orders/${a}/payment`, {
      params: { orderId: a },
      body: { status: 'failed', reference: `UNCONFIRMED-${Date.now()}`, amount: PRICE.lager / 100, paymentMethod: 'card', businessOrderNo: mo, gatewayResult: dev.gatewayResult },
    })
    expect(cb.body).toMatchObject({ success: false, outcome: 'left_pending_finatic_uncertain' })
    const money = tabMoney(tabId)
    expect({ sale: money.saleRows, ng: money.nonGatewayRows }).toEqual({ sale: 0, ng: 0 })
    expect(orderRow(a)).toMatchObject({ payment_status: 'pending', pending_charge_cents: PRICE.lager })
    // Cash is refused while the unknown card may still land (no double collection).
    const cash = await cashSettle('b', tabId, [a], PRICE.lager)
    expect({ status: cash.status, code: cash.body.code }).toEqual({ status: 409, code: 'PAYMENT_IN_FLIGHT' })
    const cu = await cashUpFor(25)
    expect(cu.revenue).toBe(0)
    record(row, 'K6', money, cu, await historyFor(tabId), 0, 'left pending, expectation kept; cash refused PAYMENT_IN_FLIGHT')
  })

  probe('RC-K7 manual Mark-as-Paid (dashboard)', async (row) => {
    const tabId = await openTab(26, 'K7')
    const a = await round(tabId, [{ key: 'espresso', qty: 2 }])
    const res = await call(dashboardOrderStatus, `/api/orders/${a}/status`, {
      method: 'PATCH', auth: 'Bearer races-manager', params: { orderId: a }, body: { payment_status: 'paid', payment_method: 'cash' },
    })
    expectStatus(res, 200)
    expect(res.body.payment).toMatchObject({ method: 'cash', amount_cents: PRICE.espresso * 2 })
    const money = tabMoney(tabId)
    expect({ sale: money.saleRows, ng: money.nonGatewayCents }).toEqual({ sale: 0, ng: PRICE.espresso * 2 })
    const cu = await cashUpFor(26)
    record(row, 'K7', money, cu, await historyFor(tabId), PRICE.espresso * 2, `order ${orderRow(a).status}/${orderRow(a).payment_status}`)
    expect(cu.revenue).toBe(orderRow(a).status === 'completed' ? PRICE.espresso * 2 : 0)
  })

  probe('RC-K8 cash for an amended order (a voided line)', async (row) => {
    const tabId = await openTab(27, 'K8')
    const a = await round(tabId, [{ key: 'burger', qty: 1 }, { key: 'cheesecake', qty: 1 }])
    const [, cake] = linesOf(a)
    expectStatus(await amend('a', tabId, [{ line_id: cake.id, new_quantity: 0 }]), 200)
    expectStatus(await cashSettle('a', tabId, [a], PRICE.burger), 200)
    const money = tabMoney(tabId)
    expect(money.nonGatewayCents).toBe(PRICE.burger)
    const cu = await cashUpFor(27)
    // Today: orders.total, which still carries the voided cheesecake.
    expect(cu.revenue).toBe(PRICE.burger + PRICE.cheesecake)
    record(row, 'K8', money, cu, await historyFor(tabId), PRICE.burger, `cash-up counts the voided cheesecake (${PRICE.cheesecake}) as takings`)
  })
})
