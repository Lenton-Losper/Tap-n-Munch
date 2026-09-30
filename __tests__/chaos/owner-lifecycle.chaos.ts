/**
 * THE OWNER'S LONG TAB -- the 28-step lifecycle as ONE scenario, on the real chaos harness.
 *
 *   node supabase/tests/chaos-e2e.mjs --scenario=owner-lifecycle
 *   node supabase/tests/chaos-e2e.mjs --scenario=owner-lifecycle --mutate=all
 *
 * Launched only by that runner (the file name does not match jest's testMatch). It builds its own
 * Postgres + PostgREST from the real baseline and every production migration; see its header.
 *
 * The owner's steps, in order (Sprint 2026-09-30 brief, L): open a tab; 5+ items with different
 * notes and variants; send; another round; pay about half; another round; cancel 3; add 4; cancel
 * 2; re-add those 2; reduce quantities; attempt a cooked-item cancellation; a send whose response
 * is lost; its retry (duplicate); a changed-basket resend (409); start another payment; an
 * uncertain payment (reader 9027, Finatic E04111); recover with Check; another round; complete the
 * payment; invoice; the dashboard read path, order history, kitchen/bar station lines and the
 * ledger; the tab owes nothing. Interleaved, the partial-payment / amendment chaos (F1-F10):
 * amending an order that is part-paid, cancelling a paid item, variants added after a partial
 * payment, a variant cancelled and re-added as a different one, a split card that needs two attempts.
 *
 * EVERY CHECKPOINT calls `stage()`, which asserts the SERVER's state against an independent oracle
 * (what the waiter did, priced from the seeded menu): the gross historical order total, the live
 * payable, paid, outstanding -- per order and per tab, through the real terminal lines route and
 * the tables route -- the item allocations, BOTH ledgers (payment_events + non_gateway_payment_
 * events, plus confirmed split-card intents), each paid order's payment reference and method, every
 * order's payment status, the tab status, and the READ-ONLY reconciliation script
 * (scripts/reconcile/tab-reconciliation.sql), whose 'money' rows must hold at every stage. Every
 * charge records what was asked and asserts it was the live outstanding, never the stored
 * orders.total.
 *
 * WHAT IS REAL / SIMULATED / MOCKED: exactly as payment-simulation.chaos.ts -- real routes, real
 * PostgREST, real Postgres, the real payments/paycloud.js client; Finatic answered at the wire
 * (fetch to open.finatic.africa), Resend answered at the wire (fetch to api.resend.com, the real
 * SDK builds the request and the PDF attachment is read back). Terminal JWT (jose) and dashboard
 * auth (GoTrue) are replaced by mocks that still require their header; realtime broadcast is
 * stubbed.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ------------------------------------------------------------------------------------------------
// SAFETY
// ------------------------------------------------------------------------------------------------
const REST_URL = process.env.FT_CHAOS_REST_URL ?? ''
const SERVICE_KEY = process.env.FT_CHAOS_SERVICE_KEY ?? ''
const DB = process.env.FT_CHAOS_DB ?? ''
const CONTAINER = process.env.FT_CHAOS_CONTAINER ?? ''
const REPORT_FILE = process.env.FT_CHAOS_REPORT ?? ''
if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(REST_URL)) {
  throw new Error(`lifecycle: FT_CHAOS_REST_URL must be the harness's 127.0.0.1 proxy, got "${REST_URL}".`)
}
if (!/^[a-z][a-z0-9_]{0,40}$/.test(DB) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/.test(CONTAINER)) {
  throw new Error('lifecycle: FT_CHAOS_DB / FT_CHAOS_CONTAINER missing or malformed')
}
for (const k of Object.keys(process.env)) {
  if (/SUPABASE|UPSTASH|RESEND|PAYCLOUD|FINATIC|REDIS|WEBHOOK|SENTRY|TWILIO|WHATSAPP/i.test(k)) delete process.env[k]
}
process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'lifecycle-anon-key-unused'
// The Resend SDK is real; its host is answered below and never resolved.
process.env.RESEND_API_KEY = 're_chaos_local_only'

const FINATIC_HOST = 'open.finatic.africa'
const RESEND_HOST = 'api.resend.com'
process.env.PAYCLOUD_ENDPOINT = `https://${FINATIC_HOST}/api/entry`
process.env.PAYCLOUD_APP_ID = 'wz663lifecyclelocal'
process.env.PAYCLOUD_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

// ------------------------------------------------------------------------------------------------
// THE SIMULATED WIRE: Finatic order.query and Resend
// ------------------------------------------------------------------------------------------------
type GatewayState = { kind: 'no_record' } | { kind: 'paid'; cents: number; txn: string } | { kind: 'declined'; cents: number }
const gw = { state: new Map<string, GatewayState>(), asks: [] as Array<{ mo: string; cents: number; outcome: string }>, queries: [] as string[], txn: 0 }
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
  return { code: '0', msg: 'Success', data: JSON.stringify({ merchant_order_no: mo, trans_status: 1, paid_amount: '0', order_amount: major(s.cents), trans_error_code: 'N003' }) }
}
const emails: Array<Record<string, any>> = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname === FINATIC_HOST) {
    if (!url.pathname.endsWith('/api/entry/orderquery')) throw new Error(`lifecycle: unexpected Finatic call ${url.pathname}`)
    const body = JSON.parse(String(init?.body ?? '{}')) as { merchant_order_no?: string; sign?: string }
    if (!body.sign) throw new Error('lifecycle: order.query arrived unsigned')
    const mo = String(body.merchant_order_no ?? '')
    gw.queries.push(mo)
    return new Response(JSON.stringify(finaticOrderQuery(mo)), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.hostname === RESEND_HOST) {
    emails.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(JSON.stringify({ id: `re_lifecycle_${emails.length}` }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.hostname !== '127.0.0.1') throw new Error(`lifecycle: refused a request to ${url.origin}`)
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

// ------------------------------------------------------------------------------------------------
// FIXTURE (supabase/tests/chaos/seed.sql)
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
/** THE ORACLE: unit price in cents for an item + selection, from the seeded menu, not the code. */
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

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async (req: Request) => {
    if (req.headers.get('authorization') !== 'Bearer lifecycle-terminal') {
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
jest.mock('@/lib/supabase/admin-restaurant-auth', () => ({
  ...jest.requireActual('@/lib/supabase/admin-restaurant-auth'),
  // No GoTrue here. Membership and permission are still checked by the real helpers.
  getUserFromRequest: async (req: Request) => {
    if (req.headers.get('authorization') !== 'Bearer lifecycle-manager') throw new Error('Missing authorization')
    return { id: 'c4a05000-0000-4000-8000-000000005001', email: 'manager@chaos.invalid' }
  },
}))

import { POST as openTable } from '@/app/api/terminal/tables/[tableId]/open/route'
import { POST as closeTable } from '@/app/api/terminal/tables/[tableId]/close/route'
import { GET as getTables } from '@/app/api/terminal/tables/route'
import { POST as postRound } from '@/app/api/terminal/rounds/route'
import { GET as getLines } from '@/app/api/terminal/tabs/[tabId]/lines/route'
import { POST as amendTab } from '@/app/api/terminal/tabs/[tabId]/amend/route'
import { POST as allocateLine } from '@/app/api/terminal/tabs/[tabId]/lines/[lineId]/allocate/route'
import { POST as settleAllocations } from '@/app/api/terminal/tabs/[tabId]/settle-allocations/route'
import { POST as settleTab } from '@/app/api/terminal/tabs/[tabId]/settle/route'
import { POST as prepareSplit } from '@/app/api/terminal/tabs/[tabId]/prepare-split-payment/route'
import { POST as recordSplit } from '@/app/api/terminal/tabs/[tabId]/record-split-payment/route'
import { POST as preparePayment } from '@/app/api/terminal/orders/[orderId]/prepare-payment/route'
import { POST as attemptStarted } from '@/app/api/terminal/orders/[orderId]/attempt-started/route'
import { POST as orderPayment } from '@/app/api/terminal/orders/[orderId]/payment/route'
import { POST as verifyPayment } from '@/app/api/terminal/orders/[orderId]/verify-payment/route'
import { POST as stationLineState } from '@/app/api/station/order-lines/[lineId]/state/route'
import { GET as stationLines } from '@/app/api/station/lines/route'
import { POST as paycloudWebhook } from '@/app/api/webhooks/paycloud/route'
import { GET as orderHistory } from '@/app/api/orders/history/route'
import { POST as invoiceFromOrder } from '@/app/api/admin/documents/from-order/route'
import { GET as documentPdf } from '@/app/api/admin/documents/[id]/pdf/route'
import { POST as documentSend } from '@/app/api/admin/documents/[id]/send/route'
import { extractPdfText } from '../helpers/extract-pdf-text'

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
  execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8' })
}
const cents = (m: unknown) => Math.round(Number(m) * 100)
const inList = (ids: string[]) => `('${ids.join("','")}')`
type Json = Record<string, any>

async function call(
  handler: (req: Request, ctx: any) => Promise<Response>,
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string>; auth?: string; raw?: string } = {},
): Promise<{ status: number; body: Json; bytes?: Uint8Array }> {
  const req = new Request(`https://lifecycle.test${path}`, {
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json', authorization: opts.auth ?? 'Bearer lifecycle-terminal', ...(opts.headers ?? {}) },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  })
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) })
  if ((res.headers.get('content-type') ?? '').includes('application/pdf')) {
    return { status: res.status, body: {}, bytes: new Uint8Array(await res.arrayBuffer()) }
  }
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

// ------------------------------------------------------------------------------------------------
// THE ORACLE -- what the waiter did, independent of anything the server computes
// ------------------------------------------------------------------------------------------------
type Want = { key: ItemKey; qty: number; note?: string; v?: Record<string, string> }
type Line = { id: string; order_id: string; key: ItemKey; qty: number; note: string | null; v: Record<string, string>; unitCents: number; totalCents: number; state: 'live' | 'voided' }
type OrderOracle = {
  label: string
  /** orders.total as stored at creation -- historical, never rewritten, never the charge. */
  grossCents: number
  /** Whole-order charge (settled_charge_cents) once paid. */
  wholeCents: number
  paymentStatus: 'pending' | 'paid'
  method: string | null
  reference: string | null
}
const lines: Line[] = []
const orders = new Map<string, OrderOracle>()
const allocPaidByOrder = new Map<string, number>()
let tabId = ''
let tabStatus: 'open' | 'closed' = 'open'
/** Every charge the scenario made: what was asked vs what orders.total would have said. */
const charges: Array<{ step: string; kind: string; asked: number; live: number; storedTotal: number }> = []
const ledgerRows = { sale: 0, nonGateway: 0, splitConfirmed: 0 }

const liveOf = (orderId?: string) =>
  lines.filter((l) => l.state === 'live' && (!orderId || l.order_id === orderId)).reduce((s, l) => s + l.totalCents, 0)
const paidOf = (orderId: string) => (allocPaidByOrder.get(orderId) ?? 0) + (orders.get(orderId)?.wholeCents ?? 0)
const outstandingOf = (orderId: string) => (orders.get(orderId)?.paymentStatus === 'paid' ? 0 : Math.max(0, liveOf(orderId) - paidOf(orderId)))
const paidTotal = () => [...orders.keys()].reduce((s, id) => s + paidOf(id), 0)
const outstandingTotal = () => [...orders.keys()].reduce((s, id) => s + outstandingOf(id), 0)
const owingOrderIds = () => [...orders.keys()].filter((id) => outstandingOf(id) > 0)
const lineOf = (pred: (l: Line) => boolean) => {
  const hit = lines.filter(pred)
  if (hit.length !== 1) throw new Error(`oracle: expected one matching line, found ${hit.length}`)
  return hit[0]
}
function recordCharge(step: string, kind: string, asked: number, orderIds: string[]) {
  const live = orderIds.reduce((s, id) => s + outstandingOf(id), 0)
  const storedTotal = orderIds.reduce((s, id) => s + (orders.get(id)?.grossCents ?? 0), 0)
  charges.push({ step, kind, asked, live, storedTotal })
  // THE INVARIANT: a charge is what is still owed, never the stored orders.total.
  expect({ step, asked }).toEqual({ step, asked: live })
}

function roundItems(wants: Want[]) {
  return wants.map((w) => ({
    menuItemId: ITEM[w.key], name: NAME[w.key], quantity: w.qty,
    ...(w.note ? { note: w.note } : {}),
    ...(w.v ? { selectedVariants: w.v } : {}),
    // A deliberately wrong client price: the server must reprice every line.
    price: 1, unitPrice: 1,
  }))
}
function sendRound(key: string, wants: Want[]) {
  return call(postRound, '/api/terminal/rounds', {
    body: { tab_id: tabId, items: roundItems(wants), subtotal: 1, total: 1 },
    headers: { 'x-idempotency-key': key, 'x-flashtap-variant-protocol': '1' },
  })
}
/** Record a round (or an amend replacement order) the server accepted, from Postgres. */
function recordOrder(label: string, orderId: string, wants: Want[]) {
  const [o] = sql<{ total: string; items: Json[] }>(`SELECT total, items FROM orders WHERE id = '${orderId}'`)
  const rows = sql<{ id: string; source_item_index: number; line_note: string | null; quantity: string }>(
    `SELECT id, source_item_index, line_note, quantity FROM order_lines WHERE order_id = '${orderId}' ORDER BY source_item_index`,
  )
  expect(rows).toHaveLength(wants.length)
  rows.forEach((row, i) => {
    const w = wants[i]
    const unit = priceCents(w.key, w.v)
    expect({ label, i, qty: Number(row.quantity), note: row.line_note, v: o.items[i].selectedVariants ?? {}, total: cents(o.items[i].total) })
      .toEqual({ label, i, qty: w.qty, note: w.note ?? null, v: w.v ?? {}, total: unit * w.qty })
    lines.push({ id: row.id, order_id: orderId, key: w.key, qty: w.qty, note: w.note ?? null, v: w.v ?? {}, unitCents: unit, totalCents: unit * w.qty, state: 'live' })
  })
  const gross = wants.reduce((s, w) => s + priceCents(w.key, w.v) * w.qty, 0)
  expect({ label, stored: cents(o.total) }).toEqual({ label, stored: gross })
  orders.set(orderId, { label, grossCents: gross, wholeCents: 0, paymentStatus: 'pending', method: null, reference: null })
}

// ------------------------------------------------------------------------------------------------
// THE CHECKPOINT
// ------------------------------------------------------------------------------------------------
async function financials() {
  const res = await call(getLines, `/api/terminal/tabs/${tabId}/lines`, { method: 'GET', params: { tabId } })
  expectStatus(res, 200)
  return res.body
}
async function tableRow() {
  const res = await call(getTables, '/api/terminal/tables', { method: 'GET' })
  expectStatus(res, 200)
  return (res.body.tables as Json[]).find((t) => t.id === TABLE)
}
/** Both ledgers, from Postgres: gateway sale rows, non-gateway rows, confirmed split-card intents. */
function ledger() {
  const ids = [...orders.keys()]
  const arr = ids.length ? `ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]` : 'ARRAY[]::uuid[]'
  const sale = sql<{ c: number; n: number }>(`SELECT coalesce(sum(round(amount*100)),0)::int AS c, count(*)::int AS n FROM payment_events WHERE event_type = 'sale' AND order_ids && ${arr}`)[0]
  const ngpe = sql<{ c: number; n: number }>(`SELECT coalesce(sum(amount_cents - tip_cents),0)::int AS c, count(*)::int AS n FROM non_gateway_payment_events WHERE order_ids && ${arr}`)[0]
  const split = sql<{ c: number; n: number }>(
    `SELECT coalesce(sum(i.amount_cents),0)::int AS c, count(*)::int AS n FROM terminal_payment_intents i
      WHERE i.tab_id = '${tabId}' AND i.scope = 'allocations' AND i.status = 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM payment_events e WHERE e.event_type = 'sale' AND e.business_order_no = i.merchant_order_no)`,
  )[0]
  const alloc = sql<{ c: number; n: number }>(`SELECT coalesce(sum(amount_cents),0)::int AS c, count(*)::int AS n FROM order_line_allocation_settlements WHERE tab_id = '${tabId}'`)[0]
  return { sale, ngpe, split, alloc, total: sale.c + ngpe.c + split.c }
}
/** The reconciliation script, run exactly as a human would run it (READ ONLY). */
function reconcile(): Array<{ check: string; severity: string; ok: boolean; expected: number; actual: number; delta: number; detail: string }> {
  const res = spawnSync(process.execPath, [
    join(process.cwd(), 'scripts/reconcile/run-tab-reconciliation.mjs'),
    `--container=${CONTAINER}`, `--db=${DB}`, `--tab=${tabId}`, '--json',
  ], { encoding: 'utf8' })
  if (res.status === 2 || !res.stdout.trim().startsWith('[')) throw new Error(`reconciliation did not run: ${res.stderr}${res.stdout}`)
  return JSON.parse(res.stdout)
}
const checkpointLog: Array<{ step: string; gross: number; live: number; paid: number; outstanding: number; alloc: number; ledger: number; sale: number; nonGateway: number; split: number; tab: string }> = []

async function stage(step: string) {
  const live = liveOf()
  const paid = paidTotal()
  const outstanding = outstandingTotal()
  const f = await financials()

  // 1. Gross historical total: orders.total as stored, never rewritten.
  const gross = sql<{ c: number }>(`SELECT coalesce(sum(round(total*100)),0)::int AS c FROM orders WHERE tab_id = '${tabId}' AND tab_settlement_for_tab_id IS NULL`)[0].c
  expect({ step, gross }).toEqual({ step, gross: [...orders.values()].reduce((s, o) => s + o.grossCents, 0) })

  // 2. Live payable / paid / outstanding -- tab, through the terminal lines route.
  expect({ step, live: f.financials.tab.live_cents, paid: f.financials.tab.paid_cents, outstanding: f.financials.tab.outstanding_cents })
    .toEqual({ step, live, paid, outstanding })
  // ...and per order.
  for (const [id, o] of orders) {
    const got = f.financials.orders[id]
    expect({ step, order: o.label, live: got?.live_cents, paid: got?.paid_cents, outstanding: got?.outstanding_cents })
      .toEqual({ step, order: o.label, live: liveOf(id), paid: paidOf(id), outstanding: outstandingOf(id) })
  }
  // ...and the tables route the floor plan reads.
  if (tabStatus === 'open') {
    const t = await tableRow()
    expect({ step, unpaid: cents(t?.tab?.unpaid_total), outstanding: t?.tab?.financials?.outstanding_cents }).toEqual({ step, unpaid: outstanding, outstanding })
  }

  // 3. Allocations and both ledgers.
  const l = ledger()
  const allocOracle = [...allocPaidByOrder.values()].reduce((s, c) => s + c, 0)
  expect({ step, alloc: l.alloc.c, ledger: l.total }).toEqual({ step, alloc: allocOracle, ledger: paid })
  expect({ step, sale: l.sale.n, nonGateway: l.ngpe.n, split: l.split.n }).toEqual({ step, ...{ sale: ledgerRows.sale, nonGateway: ledgerRows.nonGateway, split: ledgerRows.splitConfirmed } })

  // 4. Payment status, method and reference of every order.
  const rows = sql<{ id: string; payment_status: string; status: string; payment_method: string | null; payment_reference: string | null; settled_charge_cents: number | null }>(
    `SELECT id, payment_status, status, payment_method, payment_reference, settled_charge_cents FROM orders WHERE tab_id = '${tabId}' AND tab_settlement_for_tab_id IS NULL`,
  )
  expect(rows.map((r) => r.id).sort()).toEqual([...orders.keys()].sort())
  for (const r of rows) {
    const o = orders.get(r.id)!
    expect({ step, order: o.label, ps: r.payment_status, cancelled: r.status === 'cancelled' }).toEqual({ step, order: o.label, ps: o.paymentStatus, cancelled: false })
    if (o.paymentStatus === 'paid') {
      expect({ step, order: o.label, method: r.payment_method, ref: r.payment_reference, charged: r.settled_charge_cents })
        .toEqual({ step, order: o.label, method: o.method, ref: o.reference, charged: o.wholeCents })
    }
  }

  // 5. Tab status.
  expect({ step, tab: sql(`SELECT status FROM tabs WHERE id = '${tabId}'`)[0].status }).toEqual({ step, tab: tabStatus })

  // 6. The reconciliation script: no unexplained money, at every stage.
  const rec = reconcile()
  const bad = rec.filter((r) => r.severity === 'money' && !r.ok)
  expect({ step, unexplained: bad.map((r) => `${r.check}: expected ${r.expected} got ${r.actual} (${r.detail})`) }).toEqual({ step, unexplained: [] })
  const recRow = (name: string) => rec.find((r) => r.check === name)!
  expect({ step, recLive: recRow('live_payable').actual, recGross: recRow('gross_historical_total').actual, recOutstanding: recRow('outstanding').actual })
    .toEqual({ step, recLive: live, recGross: gross, recOutstanding: outstanding })

  checkpointLog.push({ step, gross, live, paid, outstanding, alloc: l.alloc.c, ledger: l.total, sale: l.sale.c, nonGateway: l.ngpe.c, split: l.split.c, tab: tabStatus })
}

let broken: string | null = null
function step(title: string, fn: () => Promise<void>) {
  test(title, async () => {
    if (broken) throw new Error(`not run: an earlier checkpoint failed (${broken})`)
    broken = title
    await fn()
    await stage(title.split(' ')[0])
    broken = null
  }, 120_000)
}

beforeAll(() => {
  // Real Finatic credentials on the row, so the real credentials lookup runs.
  sqlExec(`UPDATE public.restaurants SET finatic_merchant_no = 'LIFE-MERCHANT', finatic_store_no = 'LIFE-STORE' WHERE id = '${R}';`)
})

afterAll(() => {
  const out = {
    checkpoints: checkpointLog,
    charges,
    reconciliation: tabId ? (() => { try { return reconcile() } catch (e) { return String(e) } })() : null,
    gatewayAsks: gw.asks,
    orderQueries: gw.queries.length,
  }
  console.log(`\n[lifecycle] CHECKPOINTS\n${checkpointLog.map((c) => `${c.step} gross ${c.gross} live ${c.live} paid ${c.paid} outstanding ${c.outstanding} alloc ${c.alloc} ledger ${c.ledger} (sale ${c.sale} + non-gateway ${c.nonGateway} + split ${c.split}) tab ${c.tab}`).join('\n')}`)
  console.log(`[lifecycle] CHARGES\n${charges.map((c) => `${c.step} ${c.kind}: asked ${c.asked} = outstanding ${c.live}; stored orders.total ${c.storedTotal}`).join('\n')}`)
  if (REPORT_FILE) writeFileSync(REPORT_FILE.replace(/report\.json$/, 'lifecycle.json'), JSON.stringify(out, null, 2))
})

// ================================================================================================
describe("the owner's long tab", () => {
  step('L01 open the tab', async () => {
    const res = await call(openTable, `/api/terminal/tables/${TABLE}/open`, {
      params: { tableId: TABLE },
      body: { user_id: WAITER, authorization_token_id: mintToken('service_session', WAITER), customer_name: 'The long table' },
    })
    expectStatus(res, 200)
    tabId = String(res.body.tab.id)
    expect(sql(`SELECT status FROM tabs WHERE id = '${tabId}'`)[0].status).toBe('open')
    expect(sql(`SELECT status FROM restaurant_tables WHERE id = '${TABLE}'`)[0].status).toBe('occupied')
  })

  // F1: an order of ten items, five+ lines with different notes and variants.
  const r1: Want[] = [
    { key: 'pasta', qty: 2, note: 'one without parmesan', v: { Size: 'Large', Sauce: 'Cream' } },
    { key: 'ribeye', qty: 1, note: 'sauce on the side', v: { Doneness: 'Medium' } },
    { key: 'burger', qty: 2, note: 'no onion' },
    { key: 'lager', qty: 3, note: 'ice cold' },
    { key: 'wine', qty: 1, v: { Glass: 'Large' } },
    { key: 'salad', qty: 1, note: 'dressing on the side' },
  ]
  const rounds: Record<string, string> = {}

  step('L02 five+ items with notes and variants, sent (F1: ten items)', async () => {
    expect(r1.reduce((s, w) => s + w.qty, 0)).toBe(10)
    const res = await sendRound('life-K1', r1)
    expectStatus(res, 200)
    expect(res.body).toMatchObject({ success: true, duplicate: false, line_count: 6 })
    rounds.R1 = String(res.body.order_id)
    recordOrder('R1', rounds.R1, r1)
    expect(orders.get(rounds.R1)!.grossCents).toBe(98800)
    const names = sql<{ name_snapshot: string }>(`SELECT name_snapshot FROM order_lines WHERE order_id = '${rounds.R1}' ORDER BY source_item_index`)
    expect(names[0].name_snapshot).toMatch(/Large/)
    expect(names[1].name_snapshot).toMatch(/Medium/)
  })

  const r2: Want[] = [
    { key: 'chips', qty: 2, note: 'extra salt' },
    { key: 'espresso', qty: 2, note: 'after mains' },
  ]
  step('L03 another round (F2)', async () => {
    const res = await sendRound('life-K2', r2)
    expectStatus(res, 200)
    rounds.R2 = String(res.body.order_id)
    recordOrder('R2', rounds.R2, r2)
  })

  const itemAllocationIds: string[] = []
  step('L04 pay about half, by item, cash (F1)', async () => {
    const pasta = lineOf((l) => l.key === 'pasta' && l.order_id === rounds.R1)
    const burger = lineOf((l) => l.key === 'burger' && l.order_id === rounds.R1)
    for (const l of [pasta, burger]) {
      const res = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${l.id}/allocate`, {
        params: { tabId, lineId: l.id }, body: { shares: [{ allocated_to: 'Guest A', quantity_allocated: l.qty }] },
      })
      expectStatus(res, 200)
      expect(res.body.line_total_cents).toBe(l.totalCents)
      itemAllocationIds.push(...(res.body.allocations as Json[]).map((a) => String(a.id)))
    }
    const asked = pasta.totalCents + burger.totalCents
    expect(asked).toBe(50700) // of 111000: about half
    const res = await call(settleAllocations, `/api/terminal/tabs/${tabId}/settle-allocations`, {
      params: { tabId }, body: { allocation_ids: itemAllocationIds, method: 'cash' },
    })
    expectStatus(res, 200)
    const applied = (res.body.applied as Json[]).reduce((s, a) => s + Number(a.amount_cents), 0)
    expect(applied).toBe(asked)
    charges.push({ step: 'L04', kind: 'cash by item', asked: applied, live: asked, storedTotal: orders.get(rounds.R1)!.grossCents })
    allocPaidByOrder.set(rounds.R1, asked)
    ledgerRows.nonGateway += 1
    // Part-paid: the order still owes the rest and is not paid.
    expect(sql(`SELECT payment_status FROM orders WHERE id = '${rounds.R1}'`)[0].payment_status).toBe('pending')
    const ng = sql(`SELECT method, amount_cents, payment_reference FROM non_gateway_payment_events WHERE tab_id = '${tabId}'`)
    expect(ng).toHaveLength(1)
    expect({ method: ng[0].method, amount: ng[0].amount_cents }).toEqual({ method: 'cash', amount: asked })
    expect(ng[0].payment_reference).toBeTruthy()
    // Which allocations that row pays for is checked by the reconciliation script at this
    // checkpoint (item_settlements_unexplained), deliberately not here: mutation OL5 proves the
    // script sees a ledger row that no longer explains its settlements when every total agrees.
  })

  const r3: Want[] = [
    { key: 'pasta', qty: 1, note: 'kid portion, mild', v: { Size: 'Regular', Sauce: 'Tomato' } },
    { key: 'wine', qty: 2, note: 'for the ladies', v: { Glass: 'Small' } },
    { key: 'ribeye', qty: 1, note: 'rare means rare', v: { Doneness: 'Rare' } },
  ]
  step('L05 another round, with variants, after the partial payment (F8)', async () => {
    const res = await sendRound('life-K3', r3)
    expectStatus(res, 200)
    rounds.R3 = String(res.body.order_id)
    recordOrder('R3', rounds.R3, r3)
    // The part-paid order is untouched by a later round.
    expect(outstandingOf(rounds.R1)).toBe(98800 - 50700)
  })

  async function voidLines(targets: Line[], reason: string) {
    return call(amendTab, `/api/terminal/tabs/${tabId}/amend`, {
      params: { tabId },
      body: { amendments: targets.map((l) => ({ line_id: l.id, new_quantity: 0 })), staff_user_id: MANAGER, authorization_token_id: mintToken('line_void'), void_reason: reason },
    })
  }
  function expectVoided(l: Line) {
    const [row] = sql(`SELECT kitchen_state, bar_state FROM order_lines WHERE id = '${l.id}'`)
    expect({ line: l.id, state: STATION[l.key] === 'kitchen' ? row.kitchen_state : row.bar_state }).toEqual({ line: l.id, state: 'voided' })
    expect(sql(`SELECT count(*)::int AS n FROM order_line_events WHERE order_line_id = '${l.id}' AND to_state = 'voided'`)[0].n).toBe(1)
  }

  step('L06 cancel 3 unpaid items, one on the part-paid order, one a variant (F3, F7)', async () => {
    const targets = [
      lineOf((l) => l.key === 'salad' && l.order_id === rounds.R1),
      lineOf((l) => l.key === 'chips' && l.order_id === rounds.R2),
      lineOf((l) => l.key === 'wine' && l.order_id === rounds.R3),
    ]
    const res = await voidLines(targets, 'guest changed their mind')
    expectStatus(res, 200)
    expect(res.body.refused).toEqual([])
    expect((res.body.applied as Json[]).map((a) => a.line_id).sort()).toEqual(targets.map((t) => t.id).sort())
    for (const t of targets) { expectVoided(t); t.state = 'voided' }
    // The part-paid order: its item payment stands, its live value fell by the salad only.
    expect(liveOf(rounds.R1)).toBe(98800 - 7200)
  })

  const r4: Want[] = [
    { key: 'burger', qty: 1, note: 'medium-well' },
    { key: 'wine', qty: 1, note: 'no ice', v: { Glass: 'Large' } },
    { key: 'cheesecake', qty: 1, note: 'birthday candle' },
    { key: 'pasta', qty: 1, note: 'extra cheese', v: { Size: 'Large', Sauce: 'Cream' } },
  ]
  step('L07 add 4', async () => {
    const res = await sendRound('life-K4', r4)
    expectStatus(res, 200)
    rounds.R4 = String(res.body.order_id)
    recordOrder('R4', rounds.R4, r4)
  })

  step('L08 cancel 2 of them', async () => {
    const targets = [lineOf((l) => l.key === 'burger' && l.order_id === rounds.R4), lineOf((l) => l.key === 'wine' && l.order_id === rounds.R4)]
    const res = await voidLines(targets, 'sent to the wrong table')
    expectStatus(res, 200)
    expect((res.body.applied as Json[]).length).toBe(2)
    for (const t of targets) { expectVoided(t); t.state = 'voided' }
  })

  const r5: Want[] = [
    { key: 'burger', qty: 1, note: 'medium-well' },
    { key: 'wine', qty: 1, note: 'no ice', v: { Glass: 'Large' } },
  ]
  step('L09 re-add those 2', async () => {
    const res = await sendRound('life-K5', r5)
    expectStatus(res, 200)
    rounds.R5 = String(res.body.order_id)
    expect(rounds.R5).not.toBe(rounds.R4)
    recordOrder('R5', rounds.R5, r5)
    // Net: one live medium-well burger and one live no-ice wine across R4 + R5.
    const live = lines.filter((l) => l.state === 'live' && (l.order_id === rounds.R4 || l.order_id === rounds.R5) && ['burger', 'wine'].includes(l.key))
    expect(live.map((l) => `${l.key}:${l.note}`).sort()).toEqual(['burger:medium-well', 'wine:no ice'])
  })

  const r6: Want[] = [{ key: 'pasta', qty: 1, note: 'extra cheese', v: { Size: 'Regular', Sauce: 'Cream' } }]
  step('L10 cancel a variant and re-add a different variant (F9)', async () => {
    const large = lineOf((l) => l.key === 'pasta' && l.order_id === rounds.R4)
    const v = await voidLines([large], 'wanted the regular size')
    expectStatus(v, 200)
    expect((v.body.applied as Json[]).map((a) => a.line_id)).toEqual([large.id])
    expectVoided(large)
    large.state = 'voided'
    const res = await sendRound('life-K6', r6)
    expectStatus(res, 200)
    rounds.R6 = String(res.body.order_id)
    recordOrder('R6', rounds.R6, r6)
    const [row] = sql(`SELECT l.name_snapshot, o.items->0 AS item FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.order_id = '${rounds.R6}'`)
    expect(row.item.selectedVariants).toEqual({ Size: 'Regular', Sauce: 'Cream' })
    expect(cents(row.item.total)).toBe(12000) // priced from the NEW option, not the cancelled one
    expect(row.name_snapshot).toMatch(/Regular/)
  })

  step('L11 reduce quantities, one on the part-paid order (F4, F7)', async () => {
    const lager = lineOf((l) => l.key === 'lager' && l.order_id === rounds.R1)
    const espresso = lineOf((l) => l.key === 'espresso' && l.order_id === rounds.R2)
    const res = await call(amendTab, `/api/terminal/tabs/${tabId}/amend`, {
      params: { tabId },
      body: { amendments: [{ line_id: lager.id, new_quantity: 1 }, { line_id: espresso.id, new_quantity: 1 }], staff_user_id: MANAGER, authorization_token_id: mintToken('line_void'), void_reason: 'over-ordered' },
    })
    expectStatus(res, 200)
    expect(res.body.refused).toEqual([])
    expect(res.body.lines.map((l: Json) => [l.outcome, l.previous_quantity, l.quantity])).toEqual([['reduced', 3, 1], ['reduced', 2, 1]])
    const replacement = String(res.body.order_id)
    for (const old of [lager, espresso]) { expectVoided(old); old.state = 'voided' }
    recordOrder('AMEND', replacement, [
      { key: 'lager', qty: 1, note: 'ice cold' },
      { key: 'espresso', qty: 1, note: 'after mains' },
    ])
    rounds.AMEND = replacement
    // The part-paid R1: the item payment stands; its live value dropped by the whole lager line,
    // whose surviving pint now lives (and is owed) on the replacement order.
    expect({ live: liveOf(rounds.R1), paid: paidOf(rounds.R1) }).toEqual({ live: 98800 - 7200 - 9600, paid: 50700 })
  })

  step('L12 attempt to cancel a cooked item: refused, still owed, still cooked', async () => {
    const ribeye = lineOf((l) => l.key === 'ribeye' && l.order_id === rounds.R1)
    const cook = await call(stationLineState, `/api/station/order-lines/${ribeye.id}/state`, { params: { lineId: ribeye.id }, body: { station: 'kitchen', to_state: 'cooked' } })
    expectStatus(cook, 200)
    const res = await voidLines([ribeye], 'guest complained')
    expectStatus(res, 200)
    expect(res.body.applied).toEqual([])
    expect(res.body.refused).toEqual([{ line_id: ribeye.id, reason: 'window_closed' }])
    expect(sql(`SELECT kitchen_state FROM order_lines WHERE id = '${ribeye.id}'`)[0].kitchen_state).toBe('cooked')
  })

  step('L13 attempt to cancel an already-paid item: refused (F5)', async () => {
    const pasta = lineOf((l) => l.key === 'pasta' && l.order_id === rounds.R1)
    const res = await voidLines([pasta], 'too salty')
    expectStatus(res, 200)
    expect(res.body.applied).toEqual([])
    expect(res.body.refused).toEqual([{ line_id: pasta.id, reason: 'line_settled' }])
    // Nor can the paid line be split and paid a second way.
    const resplit = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${pasta.id}/allocate`, {
      params: { tabId, lineId: pasta.id }, body: { shares: [{ allocated_to: 'Guest B', quantity_allocated: 2 }] },
    })
    expect({ status: resplit.status, code: resplit.body.code }).toEqual({ status: 409, code: 'ALREADY_SETTLED' })
  })

  const r7: Want[] = [
    { key: 'espresso', qty: 2, note: 'decaf' },
    { key: 'cheesecake', qty: 1, note: 'to share' },
  ]
  step('L14 a send whose response is lost (the server accepted it)', async () => {
    const before = sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}'`)[0].n
    await sendRound('life-K7', r7) // the terminal never sees this answer
    const [o] = sql(`SELECT id FROM orders WHERE idempotency_key = 'life-K7'`)
    expect(sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}'`)[0].n).toBe(before + 1)
    rounds.R7 = String(o.id)
    recordOrder('R7', rounds.R7, r7)
  })

  step('L15 the retry is a duplicate: same order, nothing new', async () => {
    const counts = () => ({ orders: sql(`SELECT count(*)::int AS n FROM orders WHERE tab_id = '${tabId}'`)[0].n, lines: sql(`SELECT count(*)::int AS n FROM order_lines WHERE tab_id = '${tabId}'`)[0].n })
    const before = counts()
    const retry = await sendRound('life-K7', r7)
    expectStatus(retry, 200)
    expect({ duplicate: retry.body.duplicate, order: retry.body.order_id }).toEqual({ duplicate: true, order: rounds.R7 })
    expect(counts()).toEqual(before)
    expect(sql(`SELECT count(*)::int AS n FROM orders WHERE idempotency_key = 'life-K7'`)[0].n).toBe(1)
  })

  step('L16 a changed basket under the same key: 409, nothing new', async () => {
    const before = sql(`SELECT count(*)::int AS n FROM order_lines WHERE tab_id = '${tabId}'`)[0].n
    const res = await sendRound('life-K7', [{ key: 'espresso', qty: 3, note: 'decaf' }])
    expect({ status: res.status, code: res.body.code, order: res.body.order_id }).toEqual({ status: 409, code: 'IDEMPOTENCY_KEY_BODY_MISMATCH', order: rounds.R7 })
    expect(sql(`SELECT count(*)::int AS n FROM order_lines WHERE tab_id = '${tabId}'`)[0].n).toBe(before)
  })

  step('L17 a split card that needs two attempts: declined, released, charged once (F6)', async () => {
    const cake = lineOf((l) => l.key === 'cheesecake' && l.order_id === rounds.R4)
    const alloc = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${cake.id}/allocate`, {
      params: { tabId, lineId: cake.id }, body: { shares: [{ allocated_to: 'Birthday guest', quantity_allocated: 1 }] },
    })
    expectStatus(alloc, 200)
    const allocationIds = (alloc.body.allocations as Json[]).map((a) => String(a.id))

    // Attempt 1: prepared, the item is held -- no second card and no cash may take it meanwhile.
    const p1 = await call(prepareSplit, `/api/terminal/tabs/${tabId}/prepare-split-payment`, { params: { tabId }, body: { allocation_ids: allocationIds } })
    expectStatus(p1, 200)
    // A split charge asks for the item's value, never its order's stored total.
    expect(Number(p1.body.amount_cents)).toBe(cake.totalCents)
    charges.push({ step: 'L17', kind: 'split card attempt 1 (declined)', asked: Number(p1.body.amount_cents), live: cake.totalCents, storedTotal: orders.get(rounds.R4)!.grossCents })
    const held = await call(prepareSplit, `/api/terminal/tabs/${tabId}/prepare-split-payment`, { params: { tabId }, body: { allocation_ids: allocationIds } })
    expect({ status: held.status, code: held.body.code }).toEqual({ status: 409, code: 'ITEMS_HELD_BY_CARD' })
    const cashMeanwhile = await call(settleAllocations, `/api/terminal/tabs/${tabId}/settle-allocations`, { params: { tabId }, body: { allocation_ids: allocationIds, method: 'cash' } })
    expect(cashMeanwhile.status).toBeGreaterThanOrEqual(400)
    gw.asks.push({ mo: String(p1.body.merchant_order_no), cents: Number(p1.body.amount_cents), outcome: 'declined' })
    gw.state.set(String(p1.body.merchant_order_no), { kind: 'declined', cents: Number(p1.body.amount_cents) })
    const failed = await call(recordSplit, `/api/terminal/tabs/${tabId}/record-split-payment`, { params: { tabId }, body: { merchant_order_no: p1.body.merchant_order_no, outcome: 'failed' } })
    expectStatus(failed, 200)
    expect(failed.body.status).toBe('failed')
    expect(sql(`SELECT count(*)::int AS n FROM order_line_allocation_settlements WHERE tab_id = '${tabId}' AND order_line_allocation_id IN ${inList(allocationIds)}`)[0].n).toBe(0)

    // Attempt 2: a fresh reference for the same item, approved.
    const p2 = await call(prepareSplit, `/api/terminal/tabs/${tabId}/prepare-split-payment`, { params: { tabId }, body: { allocation_ids: allocationIds } })
    expectStatus(p2, 200)
    expect(p2.body.merchant_order_no).not.toBe(p1.body.merchant_order_no)
    expect(Number(p2.body.amount_cents)).toBe(cake.totalCents)
    charges.push({ step: 'L17', kind: 'split card attempt 2 (approved)', asked: Number(p2.body.amount_cents), live: cake.totalCents, storedTotal: orders.get(rounds.R4)!.grossCents })
    gw.txn += 1
    const txn = `LIFE-TXN-${gw.txn}`
    gw.asks.push({ mo: String(p2.body.merchant_order_no), cents: Number(p2.body.amount_cents), outcome: 'approved' })
    gw.state.set(String(p2.body.merchant_order_no), { kind: 'paid', cents: Number(p2.body.amount_cents), txn })
    const ok = await call(recordSplit, `/api/terminal/tabs/${tabId}/record-split-payment`, { params: { tabId }, body: { merchant_order_no: p2.body.merchant_order_no, outcome: 'success', transaction_id: txn } })
    expectStatus(ok, 200)
    expect(ok.body.status).toBe('confirmed')
    // A replayed success changes nothing.
    const again = await call(recordSplit, `/api/terminal/tabs/${tabId}/record-split-payment`, { params: { tabId }, body: { merchant_order_no: p2.body.merchant_order_no, outcome: 'success', transaction_id: txn } })
    expect(again.body).toMatchObject({ status: 'confirmed', already_resolved: true })
    const settled = sql(`SELECT amount_cents, method, payment_reference FROM order_line_allocation_settlements WHERE order_line_allocation_id IN ${inList(allocationIds)}`)
    expect(settled).toEqual([{ amount_cents: cake.totalCents, method: 'card', payment_reference: String(p2.body.merchant_order_no) }])
    expect(sql(`SELECT status FROM terminal_payment_intents WHERE tab_id = '${tabId}' AND scope = 'allocations' ORDER BY created_at`).map((r) => r.status)).toEqual(['failed', 'confirmed'])
    allocPaidByOrder.set(rounds.R4, (allocPaidByOrder.get(rounds.R4) ?? 0) + cake.totalCents)
    ledgerRows.splitConfirmed += 1
    // The cheesecake was R4's last live item: paying it by item pays the whole order, with NO
    // whole-order charge on top (settled_charge 0) -- the voided burger/wine/pasta are not charged.
    expect(liveOf(rounds.R4)).toBe(cake.totalCents)
    expect(ok.body.orders_closed).toEqual([rounds.R4])
    const [r4] = sql(`SELECT payment_status, payment_method, payment_reference, settled_charge_cents FROM orders WHERE id = '${rounds.R4}'`)
    expect({ ps: r4.payment_status, charged: r4.settled_charge_cents }).toEqual({ ps: 'paid', charged: 0 })
    Object.assign(orders.get(rounds.R4)!, { paymentStatus: 'paid', wholeCents: 0, method: r4.payment_method, reference: r4.payment_reference })
  })

  const card: { mo: string; lead: string; orderIds: string[]; cents: number } = { mo: '', lead: '', orderIds: [], cents: 0 }
  step('L18 start another payment: every owing order, by card', async () => {
    const owing = owingOrderIds()
    card.lead = rounds.R1
    const prep = await call(preparePayment, `/api/terminal/orders/${card.lead}/prepare-payment`, { params: { orderId: card.lead }, body: { order_ids: owing } })
    expectStatus(prep, 200)
    card.mo = String(prep.body.merchantOrderNo)
    card.cents = Number(prep.body.chargeCents)
    card.orderIds = (prep.body.orderIds as string[]).map(String)
    expect([...card.orderIds].sort()).toEqual([...owing].sort())
    recordCharge('L18', 'card (prepared)', card.cents, owing)
    const stored = owing.reduce((s, id) => s + orders.get(id)!.grossCents, 0)
    expect(card.cents).toBeLessThan(stored) // voids and item payments are NOT charged again
    const started = await call(attemptStarted, `/api/terminal/orders/${card.lead}/attempt-started`, {
      params: { orderId: card.lead }, body: { businessOrderNo: card.mo, appVersion: '2.41', launchedAt: new Date().toISOString() },
    })
    expectStatus(started, 200)
    // Each order carries exactly its own outstanding as the charge expectation.
    const pend = sql<{ id: string; c: number }>(`SELECT id, pending_charge_cents AS c FROM orders WHERE id IN ${inList(owing)}`)
    for (const p of pend) expect({ id: p.id, c: p.c }).toEqual({ id: p.id, c: outstandingOf(p.id) })
    // A void while the card is being charged is refused -- it would leave the reader asking for more.
    const target = lineOf((l) => l.key === 'espresso' && l.order_id === rounds.R7)
    const v = await voidLines([target], 'during the charge')
    expect(v.body.refused).toEqual([{ line_id: target.id, reason: 'payment_in_flight' }])
  })

  step('L19 uncertain payment: reader 9027, Finatic E04111 -- nothing settled, nothing cancelled', async () => {
    gw.asks.push({ mo: card.mo, cents: card.cents, outcome: 'no_answer' })
    gw.state.set(card.mo, { kind: 'no_record' })
    const v = await call(verifyPayment, `/api/terminal/orders/${card.lead}/verify-payment`, { params: { orderId: card.lead }, body: {} })
    expectStatus(v, 200)
    expect(v.body).toMatchObject({ ok: true, paid: false, isE04111: true, outcome: 'left_pending_finatic_uncertain' })
    const cb = await call(orderPayment, `/api/terminal/orders/${card.lead}/payment`, {
      params: { orderId: card.lead },
      body: { status: 'failed', reference: `UNCONFIRMED-${Date.now()}`, amount: card.cents / 100, paymentMethod: 'card', businessOrderNo: card.mo, gatewayResult: '9027' },
    })
    expectStatus(cb, 200)
    expect(cb.body).toMatchObject({ success: false, canClose: false, outcome: 'left_pending_finatic_uncertain' })
    const rows = sql<{ payment_status: string; status: string; c: number | null }>(`SELECT payment_status, status, pending_charge_cents AS c FROM orders WHERE id IN ${inList(card.orderIds)}`)
    expect(rows.every((r) => r.payment_status === 'pending' && r.status !== 'cancelled' && r.c != null)).toBe(true)
    expect(sql(`SELECT status FROM terminal_payment_intents WHERE merchant_order_no = '${card.mo}'`)[0].status).toBe('launched')
    expect(gw.asks.filter((a) => a.mo === card.mo)).toHaveLength(1) // no second charge by itself
  })

  step('L20 recover with Check: Finatic now reports it paid -- settled once, at the charged figure', async () => {
    gw.txn += 1
    const txn = `LIFE-TXN-${gw.txn}`
    gw.state.set(card.mo, { kind: 'paid', cents: card.cents, txn })
    const check = await call(verifyPayment, `/api/terminal/orders/${card.lead}/verify-payment`, { params: { orderId: card.lead }, body: {} })
    expectStatus(check, 200)
    expect(check.body).toMatchObject({ ok: true, paid: true, applied: true, transactionId: txn })
    // Pressed again, and Finatic's notify arriving late: nothing more happens.
    const again = await call(verifyPayment, `/api/terminal/orders/${card.lead}/verify-payment`, { params: { orderId: card.lead }, body: {} })
    expect(again.body).toMatchObject({ paid: true, source: 'supabase' })
    const hook = await call(paycloudWebhook, '/api/webhooks/paycloud', {
      raw: JSON.stringify({ merchant_order_no: card.mo, trans_status: 2, amount: card.cents / 100, transaction_id: txn, sign: 'unverifiable' }),
      headers: { 'x-forwarded-for': '203.0.113.9' },
    })
    expectStatus(hook, 200)
    const sale = sql(`SELECT amount, business_order_no FROM payment_events WHERE event_type = 'sale' AND business_order_no = '${card.mo}'`)
    expect(sale).toHaveLength(1)
    expect(cents(sale[0].amount)).toBe(card.cents)
    for (const id of card.orderIds) {
      const o = orders.get(id)!
      o.wholeCents = outstandingOf(id)
      o.paymentStatus = 'paid'
      o.method = 'card'
    }
    const refs = sql<{ id: string; payment_reference: string }>(`SELECT id, payment_reference FROM orders WHERE id IN ${inList(card.orderIds)}`)
    expect(new Set(refs.map((r) => r.payment_reference)).size).toBe(1)
    for (const r of refs) orders.get(r.id)!.reference = r.payment_reference
    ledgerRows.sale += 1
    // The charge's intent is resolved by the settlement it produced, not left 'launched' forever.
    const [intent] = sql(`SELECT status, consumed_at IS NOT NULL AS consumed, gateway_amount_cents FROM terminal_payment_intents WHERE merchant_order_no = '${card.mo}'`)
    expect(intent).toEqual({ status: 'confirmed', consumed: true, gateway_amount_cents: card.cents })
  })

  const r8: Want[] = [
    { key: 'lager', qty: 2 },
    { key: 'chips', qty: 1, note: 'for the table' },
  ]
  step('L21 another round after the card settled', async () => {
    const res = await sendRound('life-K8', r8)
    expectStatus(res, 200)
    rounds.R8 = String(res.body.order_id)
    recordOrder('R8', rounds.R8, r8)
    expect(owingOrderIds()).toEqual([rounds.R8])
  })

  step('L22 complete the payment: cash for what is left (F10)', async () => {
    const owing = owingOrderIds()
    const amount = owing.reduce((s, id) => s + outstandingOf(id), 0)
    recordCharge('L22', 'cash (tab settle)', amount, owing)
    const res = await call(settleTab, `/api/terminal/tabs/${tabId}/settle`, { params: { tabId }, body: { order_ids: owing, method: 'cash', amount: amount / 100 } })
    expectStatus(res, 200)
    expect(res.body.can_close).toBe(true)
    const ref = String(res.body.payment_reference)
    for (const id of owing) {
      const o = orders.get(id)!
      o.wholeCents = outstandingOf(id)
      o.paymentStatus = 'paid'
      o.method = 'cash'
      o.reference = ref
    }
    ledgerRows.nonGateway += 1
    expect(outstandingTotal()).toBe(0)
  })

  let invoice: Json = {}
  let pdfText = ''
  step('L23 invoice for the whole tab: real PDF, emailed with the PDF attached', async () => {
    const res = await call(invoiceFromOrder, '/api/admin/documents/from-order', {
      auth: 'Bearer lifecycle-manager',
      body: { tab_id: tabId, restaurant_id: R, bill_to: { name: 'The Long Table Ltd', email: 'ap@longtable.test', address: '28 Step Street' } },
    })
    expectStatus(res, 201)
    invoice = res.body.document
    expect({ total: cents(invoice.total), balance: cents(invoice.balance), status: invoice.status }).toEqual({ total: liveOf(), balance: 0, status: 'paid' })
    const pdf = await call(documentPdf, `/api/admin/documents/${invoice.id}/pdf`, { method: 'GET', params: { id: String(invoice.id) }, auth: 'Bearer lifecycle-manager' })
    expect(pdf.status).toBe(200)
    pdfText = (await extractPdfText(pdf.bytes!)).replace(/\s+/g, ' ')
    const sent = await call(documentSend, `/api/admin/documents/${invoice.id}/send`, { params: { id: String(invoice.id) }, auth: 'Bearer lifecycle-manager', body: {} })
    expectStatus(sent, 200)
    expect(emails).toHaveLength(1)
    const attachment = emails[0].attachments[0]
    const mailed = (await extractPdfText(new Uint8Array(Buffer.from(String(attachment.content), 'base64')))).replace(/\s+/g, ' ')
    expect(mailed).toBe(pdfText) // the customer got the document the download gives
    const money = (c: number) => `NAD ${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    expect(pdfText).toContain(`Total ${money(liveOf())}`)
    expect(pdfText).toContain(`Amount paid ${money(paidTotal())}`)
    expect(pdfText).toContain(`Amount outstanding ${money(0)}`)
    // (The em dash is outside the standard font's encoding; the extractor drops it.)
    expect(pdfText).toMatch(/Cancelled \S? ?not charged/)
    expect(pdfText).toContain('Modena Pasta - Large / Cream (voided')
    expect(pdfText).not.toContain('UNPAID')
    // Variants are named on the lines; the cancelled Large pasta is not billed, the Regular one is.
    expect(pdfText).toMatch(/Modena Pasta[^|]*Regular/)
    // No line billed twice: document lines = live lines, one per live oracle line.
    const docLines = sql<{ n: number }>(`SELECT jsonb_array_length(line_items)::int AS n FROM business_documents WHERE id = '${invoice.id}'`)[0].n
    expect(docLines).toBe(lines.filter((l) => l.state === 'live').length)
    const cancelledLines = sql<{ n: number }>(`SELECT jsonb_array_length(cancelled_line_items)::int AS n FROM business_documents WHERE id = '${invoice.id}'`)[0].n
    expect(cancelledLines).toBe(lines.filter((l) => l.state === 'voided').length)
    // Payments on the document = the ledger, by method.
    const dp = sql<{ method: string; c: number }>(`SELECT method, sum(round(amount*100))::int AS c FROM document_payments WHERE document_id = '${invoice.id}' GROUP BY method ORDER BY method`)
    const byMethod = new Map(dp.map((r) => [r.method, r.c]))
    expect(byMethod.get('cash')).toBe(50700 + orders.get(rounds.R8)!.wholeCents)
    expect(byMethod.get('card')).toBe(card.cents + lineOf((l) => l.key === 'cheesecake' && l.order_id === rounds.R4).totalCents)
    // VAT is inside the total, not on top of it.
    expect(cents(invoice.subtotal) + cents(invoice.vat_amount)).toBe(cents(invoice.total))
  })

  step('L24 dashboard read path and order history agree with the ledger', async () => {
    const hist = await call(orderHistory, `/api/orders/history?restaurantId=${R}&startDate=2026-01-01&endDate=2099-12-31`, { method: 'GET', auth: 'Bearer lifecycle-manager' })
    expectStatus(hist, 200)
    const mine = (hist.body.orders as Json[]).filter((o) => orders.has(String(o.id)))
    expect(mine.map((o) => String(o.id)).sort()).toEqual([...orders.keys()].sort())
    for (const o of mine) {
      const id = String(o.id)
      // An order whose every line was voided or moved to a replacement (R2 here) owes nothing and
      // was never charged: it stays 'pending' at live 0. Recorded as observed, not "fixed" -- see
      // the report; payment_status is a cross-layer contract.
      expect({ order: orders.get(id)!.label, live: cents(o.live_amount), ps: o.payment_status })
        .toEqual({ order: orders.get(id)!.label, live: liveOf(id), ps: liveOf(id) > 0 ? 'paid' : 'pending' })
    }
    expect(cents(hist.body.totalRevenue)).toBe(ledger().total)
    const t = await tableRow()
    expect(cents(t?.tab?.unpaid_total ?? 0)).toBe(0)
  })

  step('L25 kitchen and bar station lines: live food only, notes and variants intact', async () => {
    const board = async (station: 'kitchen' | 'bar') => {
      const res = await call(stationLines, `/api/station/lines?station=${station}`, { method: 'GET' })
      expectStatus(res, 200)
      return (res.body.orders as Json[]).flatMap((o) => o.lines as Json[]).filter((l) => lines.some((x) => x.id === l.id))
    }
    const kitchen = await board('kitchen')
    const bar = await board('bar')
    const shown = new Set([...kitchen, ...bar].map((l) => String(l.id)))
    // Voided lines are on neither board; every live uncollected line is on its own station's board.
    for (const l of lines) {
      if (l.state === 'voided') expect({ line: l.key, shown: shown.has(l.id) }).toEqual({ line: l.key, shown: false })
      else expect({ line: `${l.key}:${l.note}`, shown: (STATION[l.key] === 'kitchen' ? kitchen : bar).some((x) => x.id === l.id) }).toEqual({ line: `${l.key}:${l.note}`, shown: true })
    }
    for (const x of [...kitchen, ...bar]) {
      const l = lines.find((y) => y.id === x.id)!
      expect({ id: x.id, qty: Number(x.quantity), note: x.line_note ?? x.note ?? null }).toEqual({ id: x.id, qty: l.qty, note: l.note })
    }
    // Paid is not cooked: paid food is still on the board to be made.
    expect(kitchen.length).toBeGreaterThan(0)
  })

  step('L26 the ledger, row by row', async () => {
    const l = ledger()
    expect({ sale: l.sale, split: l.split, alloc: l.alloc }).toEqual({
      sale: { c: card.cents, n: 1 },
      split: { c: 5500, n: 1 },
      alloc: { c: 50700 + 5500, n: 3 },
    })
    const ng = sql<{ method: string; c: number; allocs: boolean }>(`SELECT method, amount_cents AS c, allocation_ids IS NOT NULL AS allocs FROM non_gateway_payment_events WHERE tab_id = '${tabId}' ORDER BY created_at`)
    expect(ng).toEqual([{ method: 'cash', c: 50700, allocs: true }, { method: 'cash', c: orders.get(rounds.R8)!.wholeCents, allocs: false }])
    expect(l.total).toBe(liveOf())
    // Never the stored totals: the gross of every order is more than was ever taken.
    const gross = [...orders.values()].reduce((s, o) => s + o.grossCents, 0)
    expect(gross).toBeGreaterThan(l.total)
    expect(gross - l.total).toBe(lines.filter((x) => x.state === 'voided').reduce((s, x) => s + x.totalCents, 0))
  })

  step('L27 reconciliation: every row holds, nothing unexplained, nothing in flight', async () => {
    const rec = reconcile()
    const bad = rec.filter((r) => r.severity !== 'info' && !r.ok)
    expect(bad).toEqual([])
    console.log(`[lifecycle] RECONCILIATION\n${rec.map((r) => `${r.check} | ${r.severity} | ${r.ok ? 'OK' : 'FAIL'} | expected ${r.expected} | actual ${r.actual} | ${r.detail}`).join('\n')}`)
  })

  step('L28 close the table: the tab owes nothing and is closed', async () => {
    expect((await financials()).financials.tab.outstanding_cents).toBe(0)
    const res = await call(closeTable, `/api/terminal/tables/${TABLE}/close`, { params: { tableId: TABLE }, body: {} })
    expectStatus(res, 200)
    tabStatus = String(sql(`SELECT status FROM tabs WHERE id = '${tabId}'`)[0].status) as 'closed'
    expect(tabStatus).not.toBe('open')
  })
})
