/**
 * PAYMENT SIMULATION -- the CARD path end to end, with only the Finatic gateway simulated.
 *
 *   node supabase/tests/chaos-e2e.mjs --scenario=payment-simulation
 *
 * Launched only by that runner (the file name does not match jest's testMatch). It builds its own
 * Postgres + PostgREST from the real baseline and every production migration; see its header.
 *
 * WHAT IS REAL. Every route the P5 calls on a card payment, imported and invoked as the Next
 * handler: prepare-payment, attempt-started, the device callback (orders/[id]/payment), the tab
 * settle, the device sale-event call, verify-payment ("Check payment status"), the split-card pair
 * (prepare-split-payment / record-split-payment), the amend route, and the PayCloud webhook. Behind
 * them: the real lib/payments code, the real `queryFinaticOrderPaid` status mapping, the real
 * `payments/paycloud.js` client -- which really builds and RSA-signs an order.query request -- and
 * real SQL (settle_order_payment, settle_order_line_allocations, the settled-charge trigger).
 *
 * WHAT IS SIMULATED -- ONLY THE GATEWAY, AT THE WIRE. `fetch` to https://open.finatic.africa is
 * answered here with a Finatic-shaped body (the shape recorded in query-finatic-order-paid.ts and
 * __tests__/helpers/reconcile-harness.ts: `{code, msg, data: "<json>"}`, trans_status 2 / 1, and
 * the E04111 business error). The signing key is a throwaway generated per run. Nothing is mocked
 * above the HTTP boundary; the credentials lookup reads the seeded restaurant row.
 *
 * WHAT STANDS IN FOR THE DEVICE. The P5 is not here, so each scenario performs the SAME route
 * sequence the terminal code performs (src/lib/payment.ts, PaymentScreen.handleProcessPayment,
 * TableDetailScreen.runSettle / split card) -- read off terminal 2.40 (c2da1d27) -- and records what
 * the reader was asked to charge at the simulated gateway (`gw.asks`). The terminal leg
 * (D:\RN\ft-paysim src/screens/__tests__/paymentSimulation.test.tsx) proves the device side of the
 * same contract against these response shapes.
 *
 * Also mocked, exactly as in tab-lifecycle.chaos.ts: terminal JWT verification (jose is ESM-only),
 * realtime broadcast. Nothing else.
 *
 * SAFETY. Refuses to start unless pointed at the harness's own 127.0.0.1 proxy. `fetch` to any host
 * other than 127.0.0.1 throws, except the Finatic host, which is answered locally and never
 * reaches the network. Every staging/production variable jest.setup-env.ts may have loaded is
 * deleted before any route module is imported.
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
  throw new Error(`paysim: FT_CHAOS_REST_URL must be the harness's 127.0.0.1 proxy, got "${REST_URL}".`)
}
if (!/^[a-z][a-z0-9_]{0,40}$/.test(DB) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/.test(CONTAINER)) {
  throw new Error('paysim: FT_CHAOS_DB / FT_CHAOS_CONTAINER missing or malformed')
}
// jest.setup-env.ts may have loaded a real .env.test. Nothing real survives this block.
for (const k of Object.keys(process.env)) {
  if (/SUPABASE|UPSTASH|RESEND|PAYCLOUD|FINATIC|REDIS|WEBHOOK|SENTRY|TWILIO|WHATSAPP/i.test(k)) delete process.env[k]
}
process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'paysim-anon-key-unused'

// The gateway client is real, so it needs an endpoint and a signing key. Both are local fakes: the
// endpoint host is intercepted below and never resolved; the key exists only in this process.
const FINATIC_HOST = 'open.finatic.africa'
process.env.PAYCLOUD_ENDPOINT = `https://${FINATIC_HOST}/api/entry`
process.env.PAYCLOUD_APP_ID = 'wz663paysimlocal'
process.env.PAYCLOUD_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey
// PAYCLOUD_GATEWAY_PUBLIC_KEY is deliberately UNSET: Finatic has no merchant-facing public key
// (ruled 2026-08-22), so on production every webhook fails signature verification and settles
// through the order.query fallback. That is the path exercised here.

// ------------------------------------------------------------------------------------------------
// THE SIMULATED GATEWAY
// ------------------------------------------------------------------------------------------------
type GatewayState =
  | { kind: 'no_record' } // order.query answers E04111: never presented, or not registered yet
  | { kind: 'paid'; cents: number; txn: string }
  | { kind: 'declined'; cents: number; code: string }
  | { kind: 'unrecognised'; transStatus: number }

const gw = {
  state: new Map<string, GatewayState>(),
  /** Every charge a reader was asked to make: the figure the device handed WiseCashier. */
  asks: [] as Array<{ mo: string; cents: number; outcome: string }>,
  /** Every order.query the server made, by merchant order number. */
  queries: [] as string[],
  txnSeq: 0,
}
const major = (c: number) => (c / 100).toFixed(2)

/** Finatic's order.query answer for one merchant order number, in the recorded wire shape. */
function finaticOrderQuery(mo: string): Record<string, unknown> {
  const s = gw.state.get(mo) ?? { kind: 'no_record' }
  switch (s.kind) {
    case 'no_record':
      return { code: 'E04111', msg: '[E04111]Merchant order number is invalid', merchant_order_no: mo }
    case 'paid':
      return {
        code: '0', msg: 'Success', psn: s.txn,
        data: JSON.stringify({ merchant_order_no: mo, trans_status: 2, paid_amount: major(s.cents), order_amount: major(s.cents), transactionID: s.txn }),
      }
    case 'declined':
      return {
        code: '0', msg: 'Success',
        data: JSON.stringify({ merchant_order_no: mo, trans_status: 1, paid_amount: '0', order_amount: major(s.cents), trans_error_code: s.code }),
      }
    case 'unrecognised':
      return { code: '0', msg: 'Success', data: JSON.stringify({ merchant_order_no: mo, trans_status: s.transStatus }) }
  }
}

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname === FINATIC_HOST) {
    if (!url.pathname.endsWith('/api/entry/orderquery')) {
      throw new Error(`paysim: the server called Finatic ${url.pathname}; only order.query is simulated`)
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as { merchant_order_no?: string; sign?: string }
    const mo = String(body.merchant_order_no ?? '')
    // The real client really signed this request with the throwaway key.
    if (!body.sign) throw new Error('paysim: order.query arrived unsigned')
    gw.queries.push(mo)
    return new Response(JSON.stringify(finaticOrderQuery(mo)), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.hostname !== '127.0.0.1') {
    throw new Error(`paysim: refused a request to ${url.origin} -- only the loopback proxy may be reached`)
  }
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

// ------------------------------------------------------------------------------------------------
// FIXTURE (supabase/tests/chaos/seed.sql + per-run tables below)
// ------------------------------------------------------------------------------------------------
const R = 'c4a05000-0000-4000-8000-000000000001'
const TERM = 'c4a05000-0000-4000-8000-00000000e001'
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
/** THE ORACLE: unit price in cents, from the seeded menu -- not from any code under test. */
const PRICE: Record<ItemKey, number> = { burger: 9850, chips: 3500, salad: 7200, cheesecake: 5500, lager: 3200, espresso: 2600 }
const NAME: Record<ItemKey, string> = { burger: 'Burger', chips: 'Chips', salad: 'Caesar Salad', cheesecake: 'Cheesecake', lager: 'Lager', espresso: 'Espresso' }
const tableId = (n: number) => `c4a05000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async (req: Request) => {
    if (req.headers.get('authorization') !== 'Bearer paysim-terminal') {
      throw new Response(JSON.stringify({ error: 'Missing terminal token' }), { status: 401 })
    }
    return {
      terminalId: 'c4a05000-0000-4000-8000-00000000e001',
      restaurantId: 'c4a05000-0000-4000-8000-000000000001',
      deviceSerial: 'CHAOS-P5-0001',
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

import { POST as openTable } from '@/app/api/terminal/tables/[tableId]/open/route'
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

// ------------------------------------------------------------------------------------------------
// DATABASE READERS (server truth, straight out of Postgres)
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
const cents = (m: unknown) => Math.round(Number(m) * 100)
const inList = (ids: string[]) => `('${ids.join("','")}')`

type Json = Record<string, any>
async function call(
  handler: (req: Request, ctx: any) => Promise<Response>,
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string>; raw?: string } = {},
): Promise<{ status: number; body: Json }> {
  const req = new Request(`https://paysim.test${path}`, {
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer paysim-terminal', ...(opts.headers ?? {}) },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  })
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) })
  const text = await res.text()
  let body: Json = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: res.status, body }
}
function expectStatus(res: { status: number; body: Json }, status: number) {
  if (res.status !== status) throw new Error(`expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 1500)}`)
}
function mintToken(purpose: 'service_session' | 'line_void', userId = MANAGER): string {
  const id = randomUUID()
  sqlExec(`INSERT INTO public.privileged_authorization_tokens (id, user_id, restaurant_id, terminal_id, purpose, nonce, ttl_seconds, expires_at)
           VALUES ('${id}', '${userId}', '${R}', '${TERM}', '${purpose}', '${randomUUID()}', 90, now() + interval '90 seconds');`)
  return id
}

/** Sale rows in the gateway ledger for one charge. */
const saleRows = (mo: string) =>
  sql<{ id: string; amount: string; origin: string; recorded_by: string | null; order_ids: string[] }>(
    `SELECT id, amount, origin, raw_gateway_response->>'recorded_by' AS recorded_by, order_ids
       FROM payment_events WHERE restaurant_id = '${R}' AND event_type = 'sale' AND business_order_no = '${mo}'`,
  )
const intentOf = (mo: string) =>
  sql<{ status: string; consumed_at: string | null; amount_cents: number; order_ids: string[] | null }>(
    `SELECT status, consumed_at, amount_cents, order_ids FROM terminal_payment_intents WHERE merchant_order_no = '${mo}'`,
  )[0] ?? null
const ordersOf = (ids: string[]) =>
  sql<{ id: string; payment_status: string; status: string; settled_charge_cents: number | null; pending_charge_cents: number | null; total: string; cancellation_reason: string | null }>(
    `SELECT id, payment_status, status, settled_charge_cents, pending_charge_cents, total, cancellation_reason FROM orders WHERE id IN ${inList(ids)} ORDER BY id`,
  )
/** Every money row that could exist for a tab, from every ledger table. */
function tabMoney(tabId: string) {
  const orderIds = sql<{ id: string }>(`SELECT id FROM orders WHERE tab_id = '${tabId}'`).map((r) => r.id)
  const ids = orderIds.length ? `ARRAY[${orderIds.map((i) => `'${i}'::uuid`).join(',')}]` : `ARRAY[]::uuid[]`
  return {
    saleCents: sql<{ c: number }>(`SELECT coalesce(sum(round(amount*100)),0)::int AS c FROM payment_events WHERE restaurant_id='${R}' AND event_type='sale' AND order_ids && ${ids}`)[0].c,
    saleRows: sql<{ n: number }>(`SELECT count(*)::int AS n FROM payment_events WHERE restaurant_id='${R}' AND event_type='sale' AND order_ids && ${ids}`)[0].n,
    nonGatewayRows: sql<{ n: number }>(`SELECT count(*)::int AS n FROM non_gateway_payment_events WHERE order_ids && ${ids}`)[0].n,
    allocSettledCents: sql<{ c: number }>(`SELECT coalesce(sum(amount_cents),0)::int AS c FROM order_line_allocation_settlements WHERE tab_id='${tabId}'`)[0].c,
    paymentsRows: sql<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE tab_id='${tabId}'`)[0].n,
  }
}

// ------------------------------------------------------------------------------------------------
// THE WAITER -- tabs, rounds, and the terminal's own route sequences
// ------------------------------------------------------------------------------------------------
type Want = { key: ItemKey; qty: number }
const liveOf = (wants: Want[]) => wants.reduce((s, w) => s + PRICE[w.key] * w.qty, 0)
let roundSeq = 0

async function openTab(tableNo: number, label: string): Promise<string> {
  const t = tableId(tableNo)
  const res = await call(openTable, `/api/terminal/tables/${t}/open`, {
    params: { tableId: t },
    body: { user_id: WAITER, authorization_token_id: mintToken('service_session', WAITER), customer_name: label },
  })
  expectStatus(res, 200)
  return String(res.body.tab.id)
}
async function round(tabId: string, wants: Want[]): Promise<string> {
  roundSeq += 1
  const res = await call(postRound, '/api/terminal/rounds', {
    body: {
      tab_id: tabId,
      // A deliberately wrong client price: the server reprices every line.
      items: wants.map((w) => ({ menuItemId: ITEM[w.key], name: NAME[w.key], quantity: w.qty, price: 1, unitPrice: 1 })),
      subtotal: 1, total: 1,
    },
    headers: { 'x-idempotency-key': `paysim-round-${roundSeq}-${randomUUID()}`, 'x-flashtap-variant-protocol': '1' },
  })
  expectStatus(res, 200)
  expect(cents(sql(`SELECT total FROM orders WHERE id = '${res.body.order_id}'`)[0].total)).toBe(liveOf(wants))
  return String(res.body.order_id)
}
async function financials(tabId: string) {
  const res = await call(getLines, `/api/terminal/tabs/${tabId}/lines`, { method: 'GET', params: { tabId } })
  expectStatus(res, 200)
  return res.body.financials as { tab: Json; orders: Record<string, Json> }
}

/** processPaymentIntent's server half before the reader opens: prepare-payment, then attempt-started. */
async function preparePay(leadId: string, orderIds: string[]) {
  const prep = await call(preparePayment, `/api/terminal/orders/${leadId}/prepare-payment`, {
    params: { orderId: leadId }, body: { order_ids: orderIds },
  })
  expectStatus(prep, 200)
  const mo = String(prep.body.merchantOrderNo)
  const started = await call(attemptStarted, `/api/terminal/orders/${leadId}/attempt-started`, {
    params: { orderId: leadId }, body: { businessOrderNo: mo, appVersion: '2.40', launchedAt: new Date().toISOString() },
  })
  expectStatus(started, 200)
  return { mo, chargeCents: Number(prep.body.chargeCents), orderIds: (prep.body.orderIds as string[]).map(String), prep, started }
}

/**
 * THE READER. The terminal hands WiseCashier `chargeCents` (payment.ts: chargeAmount =
 * prepared.chargeCents / 100); what the card network then does is the scenario's choice.
 * 'approved' -> Finatic records a paid transaction for exactly that figure; 'declined' -> a
 * trans_status 1 row; 'no_answer' -> the P5 returned an unknown code (9027) and Finatic has no
 * record of the reference yet (E04111).
 */
function reader(mo: string, cents: number, outcome: 'approved' | 'declined' | 'no_answer') {
  gw.asks.push({ mo, cents, outcome })
  if (outcome === 'approved') {
    gw.txnSeq += 1
    const txn = `PAYSIM-TXN-${gw.txnSeq}`
    gw.state.set(mo, { kind: 'paid', cents, txn })
    return { voucherNo: txn, businessOrderNo: mo }
  }
  if (outcome === 'declined') {
    gw.state.set(mo, { kind: 'declined', cents, code: 'N003' })
    return { gatewayResult: 'N003' }
  }
  gw.state.set(mo, { kind: 'no_record' })
  return { gatewayResult: '9027' }
}
const asksFor = (mo: string) => gw.asks.filter((a) => a.mo === mo)

/** The terminal's device callback (api.completePayment -> POST orders/[id]/payment). */
function deviceCallback(orderId: string, body: Json) {
  return call(orderPayment, `/api/terminal/orders/${orderId}/payment`, { params: { orderId }, body })
}
/** api.recordSaleEvent -> POST payment-events/sale. */
function deviceSale(orderIds: string[], mo: string, txn: string, amountCents: number) {
  return call(saleEvent, '/api/terminal/payment-events/sale', {
    body: { order_ids: orderIds, business_order_no: mo, transaction_id: txn, amount: amountCents / 100, app_version: '2.40' },
  })
}
/** "Check payment status" and resolveAmbiguousPaymentWithFinatic -> POST verify-payment. */
function verify(orderId: string) {
  return call(verifyPayment, `/api/terminal/orders/${orderId}/verify-payment`, { params: { orderId }, body: {} })
}
/** Finatic's notify. Unverifiable signature, as on production, so it settles via the re-query. */
function webhook(mo: string) {
  const s = gw.state.get(mo)
  const payload = {
    merchant_order_no: mo,
    trans_status: s?.kind === 'paid' ? 2 : 1,
    amount: s && 'cents' in s ? Number(major(s.cents)) : 0,
    transaction_id: s?.kind === 'paid' ? s.txn : undefined,
    sign: 'paysim-unverifiable-signature',
  }
  return call(paycloudWebhook, '/api/webhooks/paycloud', { raw: JSON.stringify(payload), headers: { 'x-forwarded-for': '203.0.113.9' } })
}

// ------------------------------------------------------------------------------------------------
// THE SERVER CONTRACT, AS OBSERVED -- the terminal leg replays these exact bodies
// ------------------------------------------------------------------------------------------------
/**
 * Every reply below is what a real route handler returned in this run. They are written to the
 * report and copied into the terminal repo (src/screens/__tests__/helpers/paysimServerContract.json)
 * so the device-side suite answers its fetches with the server's words, not with guesses. Each
 * scenario's own order id and merchant order number are rewritten to S1b's, so the device test can
 * drive one order through every outcome.
 */
const contract: Record<string, { status: number; body: Json; orderId: string; mo: string }> = {}
function capture(name: string, res: { status: number; body: Json }, orderId: string, mo: string) {
  if (!contract[name]) contract[name] = { status: res.status, body: res.body, orderId, mo }
}
function contractForTerminal(): Record<string, unknown> {
  const meta = contract.prepare
  const out: Record<string, unknown> = {
    _meta: {
      source: 'flashtap web __tests__/chaos/payment-simulation.chaos.ts via supabase/tests/chaos-e2e.mjs',
      orderId: meta?.orderId, merchantOrderNo: meta?.mo, chargeCents: meta?.body.chargeCents,
    },
  }
  for (const [name, c] of Object.entries(contract)) {
    let text = JSON.stringify(c.body)
    if (meta) text = text.split(c.orderId).join(meta.orderId).split(c.mo).join(meta.mo)
    out[name] = { status: c.status, body: JSON.parse(text) }
  }
  return out
}

// ------------------------------------------------------------------------------------------------
// THE REPORT
// ------------------------------------------------------------------------------------------------
type Row = { scenario: string; layer: string; expected: number; asked: string; ledger: string; allocated: string; final: string; result: 'PASS' | 'FAIL' | 'FAIL (defect reproduced)' }
const report: Row[] = []
function scenario(name: string, fn: (row: Row) => Promise<void>) {
  test(name, async () => {
    const row: Row = { scenario: name.split(' ')[0], layer: 'web/server', expected: 0, asked: '-', ledger: '-', allocated: '-', final: '-', result: 'FAIL' }
    report.push(row)
    await fn(row)
    row.result = 'PASS'
  }, 120_000)
}
/**
 * A DEFECT THIS SUITE REPRODUCES AND DOES NOT FIX (the brief: report it with failing evidence).
 * The body asserts the CORRECT behaviour, so today it fails -- and jest's `test.failing` counts that
 * as expected. The day the defect is fixed the body passes, `test.failing` turns RED, and whoever
 * fixed it converts this to an ordinary `scenario`. It can never go quietly green.
 */
function knownDefect(name: string, fn: (row: Row) => Promise<void>) {
  test.failing(name, async () => {
    const row: Row = { scenario: name.split(' ')[0], layer: 'web/server', expected: 0, asked: '-', ledger: '-', allocated: '-', final: '-', result: 'FAIL (defect reproduced)' }
    report.push(row)
    await fn(row)
    row.result = 'PASS'
  }, 120_000)
}
afterAll(() => {
  const lines = [
    'scenario | layer | expected cents | gateway asked | ledger | allocated/settled | final state | result',
    ...report.map((r) => [r.scenario, r.layer, r.expected, r.asked, r.ledger, r.allocated, r.final, r.result].join(' | ')),
    `order.query calls: ${gw.queries.length}`,
  ]
  console.log(`\n[paysim] REPORT\n${lines.join('\n')}`)
  if (REPORT_FILE) {
    writeFileSync(REPORT_FILE, JSON.stringify({ rows: report, asks: gw.asks, queries: gw.queries.length }, null, 2))
    writeFileSync(REPORT_FILE.replace(/report\.json$/, 'terminal-contract.json'), JSON.stringify(contractForTerminal(), null, 2))
  }
})

beforeAll(() => {
  // Real Finatic credentials on the restaurant row, so the real lookup is exercised, and eight
  // extra tables so every scenario has a tab of its own.
  sqlExec(`UPDATE public.restaurants SET finatic_merchant_no = 'PAYSIM-MERCHANT', finatic_store_no = 'PAYSIM-STORE' WHERE id = '${R}';`)
  for (let n = 1; n <= 12; n += 1) {
    sqlExec(`INSERT INTO public.restaurant_tables (id, restaurant_id, table_number, table_name, active, status)
             VALUES ('${tableId(n)}', '${R}', ${100 + n}, 'Paysim ${n}', true, 'available') ON CONFLICT DO NOTHING;`)
  }
})

const shortState = (rows: Array<{ payment_status: string; status: string }>) =>
  rows.map((o) => `${o.payment_status}/${o.status}`).join(',')

// ================================================================================================
describe('payment simulation (card, Finatic simulated at the wire)', () => {
  scenario('S1a success, tab of two orders (TableDetail: prepare -> reader -> tab settle -> sale -> webhook)', async (row) => {
    const tabId = await openTab(1, 'S1a')
    const A: Want[] = [{ key: 'burger', qty: 2 }, { key: 'lager', qty: 2 }]
    const B: Want[] = [{ key: 'cheesecake', qty: 1 }, { key: 'espresso', qty: 2 }]
    const a = await round(tabId, A)
    const b = await round(tabId, B)
    const expected = liveOf(A) + liveOf(B)
    row.expected = expected

    const { mo, chargeCents, orderIds } = await preparePay(a, [a, b])
    expect(chargeCents).toBe(expected)
    expect(intentOf(mo)).toMatchObject({ status: 'launched', consumed_at: null, amount_cents: expected })
    const dev = reader(mo, chargeCents, 'approved')

    // runSettle: settleTab(tab.id, orderIds, amount=bill, reference=voucher, {voucherNo, businessOrderNo})
    const settle = await call(settleTab, `/api/terminal/tabs/${tabId}/settle`, {
      params: { tabId },
      body: { order_ids: orderIds, method: 'card', amount: expected / 100, gateway_reference: dev.voucherNo, voucher_no: dev.voucherNo, business_order_no: mo },
    })
    expectStatus(settle, 200)
    expect(settle.body).toMatchObject({ success: true, can_close: true, sale_event: 'recorded' })
    // recordSaleEvent(orderIds, businessOrderNo, transactionId, amount) -- idempotent on the reference.
    const sale = await deviceSale(orderIds, mo, dev.voucherNo!, expected)
    expectStatus(sale, 200)
    // Finatic's notify lands afterwards.
    const hook = await webhook(mo)
    expectStatus(hook, 200)

    const ledger = saleRows(mo)
    expect(ledger).toHaveLength(1)
    expect(cents(ledger[0].amount)).toBe(expected)
    const orders = ordersOf([a, b])
    expect(orders.map((o) => o.payment_status)).toEqual(['paid', 'paid'])
    const perOrder = Object.fromEntries(orders.map((o) => [o.id, o.settled_charge_cents]))
    expect(perOrder).toEqual({ [a]: liveOf(A), [b]: liveOf(B) })
    const f = await financials(tabId)
    expect(f.tab.outstanding_cents).toBe(0)
    const money = tabMoney(tabId)
    expect({ sale: money.saleRows, nonGateway: money.nonGatewayRows, alloc: money.allocSettledCents }).toEqual({ sale: 1, nonGateway: 0, alloc: 0 })
    expect(asksFor(mo)).toHaveLength(1)
    const intent = intentOf(mo)

    row.asked = String(asksFor(mo).map((x) => x.cents).join('+'))
    row.ledger = `${ledger.length} sale row, ${cents(ledger[0].amount)}`
    row.allocated = `settled_charge ${liveOf(A)}+${liveOf(B)}`
    row.final = `orders ${shortState(orders)}; tab outstanding ${f.tab.outstanding_cents}; intent ${intent?.status}${intent?.consumed_at ? '/consumed' : '/not consumed'}`
  })

  scenario('S1b success, single order (PaymentScreen: prepare -> reader -> device callback -> sale -> webhook)', async (row) => {
    const tabId = await openTab(2, 'S1b')
    const A: Want[] = [{ key: 'salad', qty: 1 }, { key: 'chips', qty: 1 }]
    const a = await round(tabId, A)
    row.expected = liveOf(A)

    const { mo, chargeCents, prep, started } = await preparePay(a, [a])
    capture('prepare', prep, a, mo)
    capture('attemptStarted', started, a, mo)
    expect(chargeCents).toBe(liveOf(A))
    const dev = reader(mo, chargeCents, 'approved')
    // finishSuccessfulPayment: completePayment(status success, reference=voucher, amount=reportAmount())
    const cb = await deviceCallback(a, { status: 'success', reference: dev.voucherNo, voucherNo: dev.voucherNo, businessOrderNo: mo, amount: liveOf(A) / 100, paymentMethod: 'card' })
    expectStatus(cb, 200)
    capture('callbackSuccess', cb, a, mo)
    expect(cb.body).toMatchObject({ success: true, canClose: true })
    const sale1 = await deviceSale([a], mo, dev.voucherNo!, liveOf(A))
    expectStatus(sale1, 200)
    capture('sale', sale1, a, mo)
    expectStatus(await webhook(mo), 200)

    const ledger = saleRows(mo)
    expect(ledger).toHaveLength(1)
    expect(cents(ledger[0].amount)).toBe(liveOf(A))
    const [o] = ordersOf([a])
    expect({ ps: o.payment_status, settled: o.settled_charge_cents }).toEqual({ ps: 'paid', settled: liveOf(A) })
    expect((await financials(tabId)).tab.outstanding_cents).toBe(0)
    const intent = intentOf(mo)
    row.asked = String(chargeCents)
    row.ledger = `${ledger.length} sale row (${ledger[0].origin}), ${cents(ledger[0].amount)}`
    row.allocated = `settled_charge ${o.settled_charge_cents}`
    row.final = `order ${o.payment_status}/${o.status}; tab outstanding 0; intent ${intent?.status}${intent?.consumed_at ? '/consumed' : '/not consumed'}`
  })

  // ----------------------------------------------------------------------------------------------
  /** What S2 left behind, for the defect check that follows it. */
  const s2: { tabId: string; a: string; b: string; A: Want[]; B: Want[]; expected: number; mo: string } = {
    tabId: '', a: '', b: '', A: [], B: [], expected: 0, mo: '',
  }
  scenario('S2 decline, tab of two orders (reader N003 -> device reports failed, no verify)', async (row) => {
    const tabId = await openTab(3, 'S2')
    const A: Want[] = [{ key: 'burger', qty: 1 }, { key: 'lager', qty: 1 }]
    const B: Want[] = [{ key: 'salad', qty: 1 }]
    const a = await round(tabId, A)
    const b = await round(tabId, B)
    const expected = liveOf(A) + liveOf(B)
    row.expected = expected

    const { mo, chargeCents } = await preparePay(a, [a, b])
    Object.assign(s2, { tabId, a, b, A, B, expected, mo })
    const dev = reader(mo, chargeCents, 'declined')
    // PAYMENT_DECLINED -> outcomeKind confirmed_failure -> NO verify-payment; runSettle reports
    // completePaymentReliably(orderIds[0], {status failed, reference DECLINED-N003-<ts>, amount, gatewayResult}).
    // The terminal's orderIds[0] is the order it prepared (resolvePrepareOrderId takes the first),
    // NOT the first id of prepare's response, whose order is PostgREST's.
    const cb = await deviceCallback(a, {
      status: 'failed', reference: `DECLINED-${dev.gatewayResult}-${Date.now()}`, amount: expected / 100,
      paymentMethod: 'card', businessOrderNo: mo, gatewayResult: dev.gatewayResult,
    })
    expectStatus(cb, 200)
    capture('callbackDeclined', cb, a, mo)

    const money = tabMoney(tabId)
    const orders = ordersOf([a, b])
    const f = await financials(tabId)
    const intent = intentOf(mo)
    row.asked = String(asksFor(mo).map((x) => x.cents).join('+'))
    row.ledger = `${money.saleRows} sale, ${money.nonGatewayRows} non_gateway`
    row.allocated = `alloc ${money.allocSettledCents}`
    row.final = `callback outcome=${cb.body.outcome}; nothing paid, nothing recorded; intent ${intent?.status}; 1 charge asked`

    // The gateway WAS asked (the verify-before-cancel guard ran) and said declined.
    expect(gw.queries.filter((q) => q === mo).length).toBeGreaterThanOrEqual(1)
    // Nothing was taken and nothing was recorded as taken.
    expect({ sale: money.saleRows, nonGateway: money.nonGatewayRows, alloc: money.allocSettledCents, payments: money.paymentsRows })
      .toEqual({ sale: 0, nonGateway: 0, alloc: 0, payments: 0 })
    expect(orders.some((o) => o.payment_status === 'paid')).toBe(false)
    expect(asksFor(mo)).toHaveLength(1) // nothing charged a second time by itself
    expect(sql(`SELECT count(*)::int AS n FROM terminal_payment_intents WHERE tab_id = '${tabId}'`)[0].n).toBe(1)
  })

  // D1 FIXED (2026-09-29, owner ruling): was knownDefect. A declined card on a TAB releases the failed
  // attempt only; the lead order stays owed.
  scenario('S2-D1 a declined card on a tab never cancels the lead order: the attempt is released, the tab still owes all of it', async (row) => {
    const { tabId, a, b, A, B, expected } = s2
    row.expected = expected
    const orders = ordersOf([a, b])
    const byId = Object.fromEntries(orders.map((o) => [o.id, o]))
    const f = await financials(tabId)
    const audit = sql<{ basis: string; verified: boolean }>(
      `SELECT metadata->>'evidence_basis' AS basis, (metadata->>'finaticVerifiedBeforeCancel')::boolean AS verified
         FROM audit_logs WHERE entity_id = '${a}' AND action = 'payment.failed'`,
    )
    row.asked = '-'
    row.ledger = '0'
    row.allocated = '0'
    row.final =
      `lead ${liveOf(A)}c -> ${byId[a].payment_status}/${byId[a].status} (${byId[a].cancellation_reason}, audit ${audit.map((x) => x.basis).join(',')}); ` +
      `other ${liveOf(B)}c -> ${byId[b].payment_status}; tab now owes ${f.tab.outstanding_cents} of ${expected}; a retry would charge ${f.tab.outstanding_cents}`
    console.log(`[paysim] S2-D1 evidence: ${row.final}`)
    // CORRECT BEHAVIOUR: a decline takes no money and removes no debt. Both orders still owe.
    expect({ lead: byId[a].payment_status, leadStatus: byId[a].status }).toEqual({ lead: 'pending', leadStatus: 'pending' })
    expect(f.tab.outstanding_cents).toBe(expected)
    // The failed attempt itself is released (the owner's rule), so the tab can be charged afresh.
    const pend = sql<{ id: string; c: number | null; sid: string | null }>(`SELECT id, pending_charge_cents AS c, pending_settlement_id AS sid FROM orders WHERE id IN ('${a}','${b}')`)
    expect(pend.every((o) => o.c === null && o.sid === null)).toBe(true)
    const intents = sql<{ status: string }>(`SELECT status FROM terminal_payment_intents WHERE tab_id = '${tabId}'`)
    expect(intents.map((i) => i.status)).toEqual(['failed'])
    const kept = sql<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = '${a}' AND action = 'payment.attempt_failed_order_kept'`)
    expect(kept[0].n).toBe(1)
    row.result = 'PASS'
  })

  // ----------------------------------------------------------------------------------------------
  /** S3's first half, reused by S4: the P5 answers 9027 and Finatic has nothing yet. */
  async function ambiguousAttempt(tableNo: number, label: string) {
    const tabId = await openTab(tableNo, label)
    const A: Want[] = [{ key: 'burger', qty: 1 }, { key: 'chips', qty: 2 }]
    const B: Want[] = [{ key: 'cheesecake', qty: 2 }]
    const a = await round(tabId, A)
    const b = await round(tabId, B)
    const expected = liveOf(A) + liveOf(B)
    const { mo, chargeCents } = await preparePay(a, [a, b])
    expect(chargeCents).toBe(expected)
    const dev = reader(mo, chargeCents, 'no_answer')
    // PAYMENT_AMBIGUOUS -> resolveAmbiguousPaymentWithFinatic(orderIds[0] = the prepared lead) -> verify-payment.
    const v = await verify(a)
    expectStatus(v, 200)
    if (v.body.isE04111 !== true || v.body.paid !== false) throw new Error(`verify: ${JSON.stringify(v.body)}`)
    expect(v.body).toMatchObject({ ok: true, paid: false, isE04111: true, outcome: 'left_pending_finatic_uncertain' })
    // Not paid -> the failure is reported with an UNCONFIRMED reference and the raw code.
    const cb = await deviceCallback(a, {
      status: 'failed', reference: `UNCONFIRMED-${Date.now()}`, amount: expected / 100,
      paymentMethod: 'card', businessOrderNo: mo, gatewayResult: dev.gatewayResult,
    })
    expectStatus(cb, 200)
    capture('verifyNoRecord', v, a, mo)
    capture('callbackUncertain', cb, a, mo)
    return { tabId, a, b, A, B, expected, mo, chargeCents, cb, verifyBody: v.body }
  }

  scenario('S3 ambiguous: P5 9027 / "Not confirmed", Finatic has no record (E04111)', async (row) => {
    const s = await ambiguousAttempt(4, 'S3')
    row.expected = s.expected
    expect(s.cb.body).toMatchObject({ success: false, canClose: false, outcome: 'left_pending_finatic_uncertain' })
    const orders = ordersOf([s.a, s.b])
    const money = tabMoney(s.tabId)
    const intent = intentOf(s.mo)
    // Nothing settled, nothing cancelled, the charge expectation kept so a later confirmation lands.
    expect(orders.map((o) => o.payment_status)).toEqual(['pending', 'pending'])
    expect(orders.every((o) => o.status !== 'cancelled')).toBe(true)
    expect(Object.fromEntries(orders.map((o) => [o.id, o.pending_charge_cents]))).toEqual({ [s.a]: liveOf(s.A), [s.b]: liveOf(s.B) })
    expect({ sale: money.saleRows, nonGateway: money.nonGatewayRows, alloc: money.allocSettledCents }).toEqual({ sale: 0, nonGateway: 0, alloc: 0 })
    expect(intent).toMatchObject({ status: 'launched', consumed_at: null })
    expect(sql(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = '${s.a}' AND action = 'payment.verification_uncertain'`)[0].n).toBeGreaterThanOrEqual(2)
    expect(asksFor(s.mo)).toHaveLength(1) // no second prepare, no second charge
    expect(sql(`SELECT count(DISTINCT merchant_order_no)::int AS n FROM terminal_payment_intents WHERE tab_id = '${s.tabId}'`)[0].n).toBe(1)
    expect((await financials(s.tabId)).tab.outstanding_cents).toBe(s.expected)

    // Also the other unknown shape: Finatic answers a trans_status nobody has seen. Same outcome.
    gw.state.set(s.mo, { kind: 'unrecognised', transStatus: 3 })
    const again = await deviceCallback(s.a, { status: 'failed', reference: `UNCONFIRMED-${Date.now()}`, amount: s.expected / 100, paymentMethod: 'card', businessOrderNo: s.mo, gatewayResult: '9027' })
    expect(again.body).toMatchObject({ success: false, outcome: 'left_pending_finatic_uncertain' })
    expect(ordersOf([s.a, s.b]).map((o) => o.payment_status)).toEqual(['pending', 'pending'])

    row.asked = String(s.chargeCents)
    row.ledger = `${money.saleRows} sale rows`
    row.allocated = `pending_charge ${liveOf(s.A)}+${liveOf(s.B)} kept`
    row.final = `orders pending,pending (E04111 and trans_status=3 both left pending); intent ${intent?.status}; 1 charge asked`
  })

  scenario('S4 uncertain then success: "Check payment status" -> verify-payment settles once', async (row) => {
    const s = await ambiguousAttempt(5, 'S4')
    row.expected = s.expected
    // The card had in fact gone through; Finatic now reports it.
    gw.txnSeq += 1
    const txn = `PAYSIM-TXN-${gw.txnSeq}`
    gw.state.set(s.mo, { kind: 'paid', cents: s.chargeCents, txn })

    const check = await verify(s.a) // handleCheckPaymentStatus -> verifyTerminalPayment(orderId)
    expectStatus(check, 200)
    expect(check.body).toMatchObject({ ok: true, paid: true, applied: true, transactionId: txn })
    capture('verifyPaid', check, s.a, s.mo)
    // Pressed again, and Finatic's notify arriving late: nothing more happens.
    const again = await verify(s.a)
    capture('verifyAlreadyPaid', again, s.a, s.mo)
    expect(again.body).toMatchObject({ paid: true, source: 'supabase' })
    expectStatus(await webhook(s.mo), 200)

    const ledger = saleRows(s.mo)
    expect(ledger).toHaveLength(1)
    expect({ amount: cents(ledger[0].amount), by: ledger[0].recorded_by }).toEqual({ amount: s.expected, by: 'server' })
    const orders = ordersOf([s.a, s.b])
    expect(orders.map((o) => o.payment_status)).toEqual(['paid', 'paid'])
    expect(Object.fromEntries(orders.map((o) => [o.id, o.settled_charge_cents]))).toEqual({ [s.a]: liveOf(s.A), [s.b]: liveOf(s.B) })
    expect(sql(`SELECT count(*)::int AS n FROM audit_logs WHERE restaurant_id = '${R}' AND action = 'payment.settlement_applied' AND metadata->>'merchant_order_no' = '${s.mo}' AND jsonb_array_length(metadata->'applied_order_ids') > 0`)[0].n).toBe(1)
    expect((await financials(s.tabId)).tab.outstanding_cents).toBe(0)
    expect(asksFor(s.mo)).toHaveLength(1)
    const intent = intentOf(s.mo)

    row.asked = String(s.chargeCents)
    row.ledger = `1 sale row (server), ${cents(ledger[0].amount)}`
    row.allocated = `settled_charge ${liveOf(s.A)}+${liveOf(s.B)}; 1 settlement_applied`
    row.final = `orders paid,paid; tab outstanding 0; intent ${intent?.status}${intent?.consumed_at ? '/consumed' : '/not consumed'}`
  })

  // ----------------------------------------------------------------------------------------------
  scenario('S5 replay: callback twice, sale twice, webhook + verify for the same charge; tab settle twice', async (row) => {
    // Single order: the device callback path.
    const tabId = await openTab(6, 'S5')
    const A: Want[] = [{ key: 'burger', qty: 1 }, { key: 'espresso', qty: 1 }]
    const a = await round(tabId, A)
    row.expected = liveOf(A)
    const { mo, chargeCents } = await preparePay(a, [a])
    const dev = reader(mo, chargeCents, 'approved')
    const body = { status: 'success', reference: dev.voucherNo, voucherNo: dev.voucherNo, businessOrderNo: mo, amount: liveOf(A) / 100, paymentMethod: 'card' }
    const first = await deviceCallback(a, body)
    expectStatus(first, 200)
    const second = await deviceCallback(a, body)
    expect({ status: second.status, code: second.body.code }).toEqual({ status: 409, code: 'ALREADY_PAID' })
    capture('callbackAlreadyPaid', second, a, mo)
    expectStatus(await deviceSale([a], mo, dev.voucherNo!, liveOf(A)), 200)
    const saleAgain = await deviceSale([a], mo, dev.voucherNo!, liveOf(A))
    expectStatus(saleAgain, 200) // idempotent: the existing row is returned
    expectStatus(await webhook(mo), 200)
    const v = await verify(a)
    expect(v.body).toMatchObject({ paid: true, source: 'supabase' })

    expect(saleRows(mo)).toHaveLength(1)
    expect(sql(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_id = '${a}' AND action = 'payment.completed'`)[0].n).toBe(1)
    const [o] = ordersOf([a])
    expect({ ps: o.payment_status, settled: o.settled_charge_cents }).toEqual({ ps: 'paid', settled: liveOf(A) })

    // Tab path: the same card settle delivered twice (a retried request).
    const tab2 = await openTab(7, 'S5-tab')
    const B: Want[] = [{ key: 'salad', qty: 2 }]
    const C: Want[] = [{ key: 'lager', qty: 3 }]
    const b = await round(tab2, B)
    const c = await round(tab2, C)
    const p2 = await preparePay(b, [b, c])
    const dev2 = reader(p2.mo, p2.chargeCents, 'approved')
    const settleBody = { order_ids: p2.orderIds, method: 'card', amount: p2.chargeCents / 100, gateway_reference: dev2.voucherNo, voucher_no: dev2.voucherNo, business_order_no: p2.mo }
    expectStatus(await call(settleTab, `/api/terminal/tabs/${tab2}/settle`, { params: { tabId: tab2 }, body: settleBody }), 200)
    const replay = await call(settleTab, `/api/terminal/tabs/${tab2}/settle`, { params: { tabId: tab2 }, body: settleBody })
    expect({ status: replay.status, code: replay.body.code }).toEqual({ status: 409, code: 'ALREADY_PAID' })
    expectStatus(await deviceSale(p2.orderIds, p2.mo, dev2.voucherNo!, p2.chargeCents), 200)
    expectStatus(await webhook(p2.mo), 200)
    expect(saleRows(p2.mo)).toHaveLength(1)
    expect(sql(`SELECT count(*)::int AS n FROM payments WHERE tab_id = '${tab2}'`)[0].n).toBe(1)
    expect(sql(`SELECT count(*)::int AS n FROM audit_logs WHERE restaurant_id = '${R}' AND action = 'payment.refused_already_paid' AND entity_id IN ${inList([b, c])}`)[0].n).toBe(0)

    row.asked = `${chargeCents}; tab ${p2.chargeCents}`
    row.ledger = `1 sale row each (${cents(saleRows(mo)[0].amount)}; ${cents(saleRows(p2.mo)[0].amount)})`
    row.allocated = `settled_charge ${o.settled_charge_cents}; tab ${ordersOf([b, c]).map((x) => x.settled_charge_cents).join('+')}`
    row.final = `2nd callback 409 ALREADY_PAID; 2nd sale 200 same row; 2nd tab settle 409; paid once`
  })

  // ----------------------------------------------------------------------------------------------
  scenario('S6 partial: pay one order by card, one item by split card, add a round, pay the rest', async (row) => {
    const tabId = await openTab(8, 'S6')
    const A: Want[] = [{ key: 'burger', qty: 2 }]
    const B: Want[] = [{ key: 'salad', qty: 1 }, { key: 'lager', qty: 2 }]
    const a = await round(tabId, A)
    const b = await round(tabId, B)
    const steps: string[] = []

    // Step 1: a subset of orders -- order A only (TableDetail with A selected).
    const p1 = await preparePay(a, [a])
    expect(p1.chargeCents).toBe(liveOf(A))
    const d1 = reader(p1.mo, p1.chargeCents, 'approved')
    expectStatus(await call(settleTab, `/api/terminal/tabs/${tabId}/settle`, {
      params: { tabId }, body: { order_ids: [a], method: 'card', amount: p1.chargeCents / 100, gateway_reference: d1.voucherNo, voucher_no: d1.voucherNo, business_order_no: p1.mo },
    }), 200)
    expectStatus(await deviceSale([a], p1.mo, d1.voucherNo!, p1.chargeCents), 200)
    let f = await financials(tabId)
    expect(f.tab.outstanding_cents).toBe(liveOf(B))
    steps.push(`1: expected ${liveOf(A)} asked ${p1.chargeCents} ledger ${cents(saleRows(p1.mo)[0].amount)} remaining ${f.tab.outstanding_cents}`)

    // Step 2: one item of B by split card (allocate -> prepare-split -> reader -> record-split).
    const saladLine = sql<{ id: string }>(`SELECT id FROM order_lines WHERE order_id = '${b}' AND source_item_index = 0`)[0].id
    const alloc = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${saladLine}/allocate`, {
      params: { tabId, lineId: saladLine }, body: { shares: [{ allocated_to: 'Guest at table', quantity_allocated: 1 }] },
    })
    expectStatus(alloc, 200)
    const allocationIds = (alloc.body.allocations as Json[]).map((x) => String(x.id))
    const split = await call(prepareSplit, `/api/terminal/tabs/${tabId}/prepare-split-payment`, { params: { tabId }, body: { allocation_ids: allocationIds } })
    expectStatus(split, 200)
    expect(split.body.amount_cents).toBe(PRICE.salad)
    const d2 = reader(split.body.merchant_order_no, split.body.amount_cents, 'approved')
    const rec = await call(recordSplit, `/api/terminal/tabs/${tabId}/record-split-payment`, {
      params: { tabId }, body: { merchant_order_no: split.body.merchant_order_no, outcome: 'success', transaction_id: d2.voucherNo },
    })
    expectStatus(rec, 200)
    expect(rec.body.status).toBe('confirmed')
    f = await financials(tabId)
    expect(f.tab.outstanding_cents).toBe(liveOf(B) - PRICE.salad)
    expect(f.orders[b]).toMatchObject({ paid_cents: PRICE.salad, outstanding_cents: liveOf(B) - PRICE.salad })
    const allocSettled = tabMoney(tabId).allocSettledCents
    expect(allocSettled).toBe(PRICE.salad)
    steps.push(`2: expected ${PRICE.salad} asked ${split.body.amount_cents} allocated ${allocSettled} remaining ${f.tab.outstanding_cents}`)

    // Step 3: another round, then pay everything left in one card charge -- confirmed through
    // the gateway path (reader ambiguous, then Finatic reports it paid), so settle_order_payment runs.
    const C: Want[] = [{ key: 'espresso', qty: 3 }]
    const c = await round(tabId, C)
    const remaining = liveOf(B) - PRICE.salad + liveOf(C)
    f = await financials(tabId)
    expect(f.tab.outstanding_cents).toBe(remaining)
    const p3 = await preparePay(b, [b, c])
    expect(p3.chargeCents).toBe(remaining)
    reader(p3.mo, p3.chargeCents, 'no_answer')
    gw.txnSeq += 1
    gw.state.set(p3.mo, { kind: 'paid', cents: p3.chargeCents, txn: `PAYSIM-TXN-${gw.txnSeq}` })
    const v = await verify(b)
    expect(v.body).toMatchObject({ paid: true, applied: true })
    f = await financials(tabId)
    const orders = ordersOf([a, b, c])
    expect(orders.map((o) => o.payment_status)).toEqual(['paid', 'paid', 'paid'])
    const settledOf = Object.fromEntries(orders.map((o) => [o.id, o.settled_charge_cents]))
    expect(settledOf).toEqual({ [a]: liveOf(A), [b]: liveOf(B) - PRICE.salad, [c]: liveOf(C) })
    expect(f.tab.outstanding_cents).toBe(0)
    expect(f.tab.paid_cents).toBe(liveOf(A) + liveOf(B) + liveOf(C))
    const ledger3 = saleRows(p3.mo)
    expect(ledger3).toHaveLength(1)
    expect(cents(ledger3[0].amount)).toBe(remaining)
    steps.push(`3: expected ${remaining} asked ${p3.chargeCents} ledger ${cents(ledger3[0].amount)} remaining ${f.tab.outstanding_cents}`)

    // Every cent paid is in exactly one ledger: card sale rows + item settlements = the live bill.
    const money = tabMoney(tabId)
    expect(money.saleCents + money.allocSettledCents).toBe(liveOf(A) + liveOf(B) + liveOf(C))
    console.log(`[paysim] S6 steps:\n  ${steps.join('\n  ')}`)

    row.expected = liveOf(A) + liveOf(B) + liveOf(C)
    row.asked = `${p1.chargeCents}+${split.body.amount_cents}+${p3.chargeCents}`
    row.ledger = `sale ${money.saleCents} (2 rows) + alloc ${money.allocSettledCents}`
    row.allocated = `settled_charge ${liveOf(A)},${liveOf(B) - PRICE.salad},${liveOf(C)}; item ${PRICE.salad}`
    row.final = `orders paid x3; remaining ${liveOf(B)} -> ${liveOf(B) - PRICE.salad} -> ${remaining} -> 0`
  })

  // ----------------------------------------------------------------------------------------------
  async function amendedTab(tableNo: number, label: string) {
    const tabId = await openTab(tableNo, label)
    const A: Want[] = [{ key: 'burger', qty: 2 }, { key: 'salad', qty: 1 }, { key: 'lager', qty: 3 }]
    const a = await round(tabId, A)
    const lineIds = sql<{ id: string }>(`SELECT id FROM order_lines WHERE order_id = '${a}' ORDER BY source_item_index`).map((r) => r.id)
    // Void the salad, reduce the lagers 3 -> 1, through the real amend route (manager PIN token).
    const res = await call(amendTab, `/api/terminal/tabs/${tabId}/amend`, {
      params: { tabId },
      body: {
        amendments: [{ line_id: lineIds[1], new_quantity: 0 }, { line_id: lineIds[2], new_quantity: 1 }],
        staff_user_id: MANAGER, authorization_token_id: mintToken('line_void'), void_reason: 'paysim S7',
      },
    })
    expectStatus(res, 200)
    const orderIds = sql<{ id: string }>(`SELECT id FROM orders WHERE tab_id = '${tabId}' ORDER BY order_number`).map((r) => r.id)
    const totalCents = sql<{ c: number }>(`SELECT sum(round(total*100))::int AS c FROM orders WHERE tab_id = '${tabId}'`)[0].c
    const live = PRICE.burger * 2 + PRICE.lager * 1
    const f = await financials(tabId)
    expect(f.tab.live_cents).toBe(live)
    expect(totalCents).toBeGreaterThan(live) // Riviera shape: orders.total still carries the voided lines
    return { tabId, a, orderIds, live, totalCents }
  }

  scenario('S7 amended (Riviera): charge = live, never orders.total -- tab settle path and gateway path', async (row) => {
    // S7a: the TableDetail success path.
    const s = await amendedTab(9, 'S7a')
    row.expected = s.live
    const owing = Object.entries((await financials(s.tabId)).orders).filter(([, o]) => o.outstanding_cents > 0).map(([id]) => id)
    const p = await preparePay(s.a, owing)
    expect(p.chargeCents).toBe(s.live)
    const dev = reader(p.mo, p.chargeCents, 'approved')
    expect(asksFor(p.mo)[0].cents).toBe(s.live)
    const settle = await call(settleTab, `/api/terminal/tabs/${s.tabId}/settle`, {
      params: { tabId: s.tabId },
      body: { order_ids: p.orderIds, method: 'card', amount: s.live / 100, gateway_reference: dev.voucherNo, voucher_no: dev.voucherNo, business_order_no: p.mo },
    })
    expectStatus(settle, 200)
    expectStatus(await deviceSale(p.orderIds, p.mo, dev.voucherNo!, s.live), 200)
    expectStatus(await webhook(p.mo), 200)
    const la = saleRows(p.mo)
    expect(la).toHaveLength(1)
    expect(cents(la[0].amount)).toBe(s.live)
    const settledA = sql<{ c: number }>(`SELECT coalesce(sum(settled_charge_cents),0)::int AS c FROM orders WHERE tab_id = '${s.tabId}' AND payment_status = 'paid'`)[0].c
    expect(settledA).toBe(s.live)
    expect((await financials(s.tabId)).tab.outstanding_cents).toBe(0)

    // S7b: the same shape confirmed by the gateway (Check payment status -> settle_order_payment).
    const t = await amendedTab(10, 'S7b')
    const owingB = Object.entries((await financials(t.tabId)).orders).filter(([, o]) => o.outstanding_cents > 0).map(([id]) => id)
    const q = await preparePay(t.a, owingB)
    expect(q.chargeCents).toBe(t.live)
    reader(q.mo, q.chargeCents, 'no_answer')
    gw.txnSeq += 1
    gw.state.set(q.mo, { kind: 'paid', cents: q.chargeCents, txn: `PAYSIM-TXN-${gw.txnSeq}` })
    const v = await verify(t.a)
    expect(v.body).toMatchObject({ paid: true, applied: true })
    const lb = saleRows(q.mo)
    expect(lb).toHaveLength(1)
    expect(cents(lb[0].amount)).toBe(t.live)
    const settledB = sql<{ c: number }>(`SELECT coalesce(sum(settled_charge_cents),0)::int AS c FROM orders WHERE tab_id = '${t.tabId}' AND payment_status = 'paid'`)[0].c
    expect(settledB).toBe(t.live)
    expect((await financials(t.tabId)).tab.outstanding_cents).toBe(0)
    // The stored tab total the dashboard reads is not the pre-amend figure either.
    const tabTotals = sql<{ id: string; total: string }>(`SELECT id, total FROM tabs WHERE id IN ${inList([s.tabId, t.tabId])}`)
    expect(tabTotals.map((x) => cents(x.total))).toEqual([0, 0])

    row.asked = `${asksFor(p.mo)[0].cents}; ${asksFor(q.mo)[0].cents} (orders.total ${s.totalCents})`
    row.ledger = `${cents(la[0].amount)}; ${cents(lb[0].amount)}`
    row.allocated = `settled_charge sum ${settledA}; ${settledB}`
    row.final = `tabs outstanding 0,0; orders.total ${s.totalCents} never charged`
  })

  scenario('S8 across every scenario: no false double-charge alarm, one charge per reference, paid tabs reconcile', async (row) => {
    // A normal card payment followed by Finatic's notify must never read as "charged twice".
    const alarms = sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE restaurant_id = '${R}' AND action = 'payment.refused_already_paid'
          AND coalesce((metadata->>'distinctGatewayTransaction')::boolean, false)`,
    )[0].n
    expect(alarms).toBe(0)
    // Every reference was presented to a reader exactly once.
    const perRef = new Map<string, number>()
    for (const a of gw.asks) perRef.set(a.mo, (perRef.get(a.mo) ?? 0) + 1)
    expect([...perRef.values()].every((n) => n === 1)).toBe(true)
    // No reference has more than one sale row.
    expect(sql(`SELECT business_order_no FROM payment_events WHERE restaurant_id = '${R}' AND event_type = 'sale' GROUP BY 1 HAVING count(*) > 1`)).toEqual([])
    // Every tab the scenarios settled: the money tables hold exactly its live value.
    const paidTabs = sql<{ id: string }>(
      `SELECT t.id FROM tabs t WHERE t.restaurant_id = '${R}' AND NOT EXISTS (
         SELECT 1 FROM orders o WHERE o.tab_id = t.id AND o.payment_status <> 'paid' AND o.status <> 'cancelled')
         AND EXISTS (SELECT 1 FROM orders o WHERE o.tab_id = t.id)`,
    )
    const mismatches: string[] = []
    for (const { id } of paidTabs) {
      const f = await financials(id)
      const m = tabMoney(id)
      if (m.saleCents + m.allocSettledCents !== f.tab.live_cents || f.tab.outstanding_cents !== 0) {
        mismatches.push(`${id}: sale ${m.saleCents} + alloc ${m.allocSettledCents} vs live ${f.tab.live_cents}, outstanding ${f.tab.outstanding_cents}`)
      }
    }
    expect(mismatches).toEqual([])
    row.expected = paidTabs.length
    row.asked = `${gw.asks.length} charges, ${perRef.size} references`
    row.ledger = 'no duplicate sale rows'
    row.allocated = `${paidTabs.length} paid tabs reconcile to the cent`
    row.final = `0 double-charge alarms; ${gw.queries.length} order.query calls`
  })
})
