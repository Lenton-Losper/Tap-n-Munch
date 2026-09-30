/**
 * INVOICE CHAOS -- J1..J10 (Sprint 2026-09-30 brief), through REAL PDF generation and the REAL
 * email-with-PDF send route, on the real chaos harness.
 *
 *   node supabase/tests/chaos-e2e.mjs --scenario=invoice-chaos
 *   node supabase/tests/chaos-e2e.mjs --scenario=invoice-chaos --mutate=all
 *
 * Each case gets a tab of its own. Money moves only through the real terminal routes (rounds,
 * amend, allocate, settle-allocations, split card, prepare-payment + verify-payment against
 * Finatic simulated at the wire, tab settle). The invoice is raised through
 * POST /api/admin/documents/from-order, downloaded through GET .../[id]/pdf, and emailed through
 * POST .../[id]/send with Resend answered at the wire -- the real SDK builds the request, and the
 * attached PDF is decoded and read back with the text extractor.
 *
 * EVERY CASE asserts, against the terminal lines route's projection over exactly the orders the
 * invoice covers: total = live; balance = outstanding; Σ document_payments = paid (by method and
 * reference); status; VAT inside the total (a 15% inclusive default rate is seeded, so VAT is not
 * zero); one document line per live line (no duplicates); one cancelled line per voided line
 * (history preserved, never charged); variant labels on the lines; and the same figures in the PDF
 * text. A paid invoice never shows the full balance due -- J8 is the case where the payment lands
 * AFTER the invoice exists.
 *
 * J8 -- THE RULE (documented in lib/documents/refresh-invoice-payments.ts and migration
 * 20260930120000): an invoice's LINES AND TOTAL are a snapshot; its PAYMENTS are the ledger. Every
 * surface that shows or sends an order/tab invoice first adds, through the append-only
 * document_payments path, whatever the projection says was paid since issue. A document that
 * cannot be brought up to date is refused (409), never rendered demanding money already paid.
 */
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'

// ------------------------------------------------------------------------------------------------
// SAFETY -- as owner-lifecycle.chaos.ts
// ------------------------------------------------------------------------------------------------
const REST_URL = process.env.FT_CHAOS_REST_URL ?? ''
const SERVICE_KEY = process.env.FT_CHAOS_SERVICE_KEY ?? ''
const DB = process.env.FT_CHAOS_DB ?? ''
const CONTAINER = process.env.FT_CHAOS_CONTAINER ?? ''
if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(REST_URL)) throw new Error(`invoice-chaos: FT_CHAOS_REST_URL must be the harness proxy, got "${REST_URL}"`)
if (!/^[a-z][a-z0-9_]{0,40}$/.test(DB) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/.test(CONTAINER)) throw new Error('invoice-chaos: FT_CHAOS_DB / FT_CHAOS_CONTAINER missing')
for (const k of Object.keys(process.env)) {
  if (/SUPABASE|UPSTASH|RESEND|PAYCLOUD|FINATIC|REDIS|WEBHOOK|SENTRY|TWILIO|WHATSAPP/i.test(k)) delete process.env[k]
}
process.env.NEXT_PUBLIC_SUPABASE_URL = REST_URL
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'invoice-chaos-anon-unused'
process.env.RESEND_API_KEY = 're_chaos_local_only'
const FINATIC_HOST = 'open.finatic.africa'
const RESEND_HOST = 'api.resend.com'
process.env.PAYCLOUD_ENDPOINT = `https://${FINATIC_HOST}/api/entry`
process.env.PAYCLOUD_APP_ID = 'wz663invoicechaos'
process.env.PAYCLOUD_PRIVATE_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey

const paidAtGateway = new Map<string, { cents: number; txn: string }>()
let txnSeq = 0
const emails: Array<Record<string, any>> = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname === FINATIC_HOST) {
    const body = JSON.parse(String(init?.body ?? '{}')) as { merchant_order_no?: string; sign?: string }
    if (!body.sign || !url.pathname.endsWith('/api/entry/orderquery')) throw new Error('invoice-chaos: unexpected Finatic call')
    const mo = String(body.merchant_order_no ?? '')
    const paid = paidAtGateway.get(mo)
    const answer = paid
      ? { code: '0', msg: 'Success', psn: paid.txn, data: JSON.stringify({ merchant_order_no: mo, trans_status: 2, paid_amount: (paid.cents / 100).toFixed(2), order_amount: (paid.cents / 100).toFixed(2), transactionID: paid.txn }) }
      : { code: 'E04111', msg: '[E04111]Merchant order number is invalid', merchant_order_no: mo }
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.hostname === RESEND_HOST) {
    emails.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(JSON.stringify({ id: `re_inv_${emails.length}` }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.hostname !== '127.0.0.1') throw new Error(`invoice-chaos: refused a request to ${url.origin}`)
  return realFetch(input as RequestInfo, init)
}) as typeof fetch

const R = 'c4a05000-0000-4000-8000-000000000001'
const TERM = 'c4a05000-0000-4000-8000-00000000e001'
const MANAGER = 'c4a05000-0000-4000-8000-000000005001'
const WAITER = 'c4a05000-0000-4000-8000-000000005002'
const ITEM = {
  pasta: 'c4a05000-0000-4000-8000-000000001001', ribeye: 'c4a05000-0000-4000-8000-000000001002',
  burger: 'c4a05000-0000-4000-8000-000000001003', chips: 'c4a05000-0000-4000-8000-000000001004',
  salad: 'c4a05000-0000-4000-8000-000000001005', cheesecake: 'c4a05000-0000-4000-8000-000000001006',
  lager: 'c4a05000-0000-4000-8000-000000002001', wine: 'c4a05000-0000-4000-8000-000000002002',
  espresso: 'c4a05000-0000-4000-8000-000000002003',
} as const
type ItemKey = keyof typeof ITEM
const NAME: Record<ItemKey, string> = {
  pasta: 'Modena Pasta', ribeye: 'Ribeye', burger: 'Burger', chips: 'Chips', salad: 'Caesar Salad',
  cheesecake: 'Cheesecake', lager: 'Lager', wine: 'House Wine', espresso: 'Espresso',
}
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
const tableId = (n: number) => `c4a05000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`

jest.mock('@/lib/terminal-auth', () => ({
  requireTerminalAuth: async (req: Request) => {
    if (req.headers.get('authorization') !== 'Bearer invoice-terminal') throw new Response(JSON.stringify({ error: 'Missing terminal token' }), { status: 401 })
    return { terminalId: 'c4a05000-0000-4000-8000-00000000e001', restaurantId: 'c4a05000-0000-4000-8000-000000000001', deviceSerial: 'CHAOS-P5-0001', permissions: ['orders:read', 'orders:update', 'payments:process'] }
  },
  validateTerminalRecord: async (supabase: { from: (t: string) => any }, terminal: { terminalId: string; restaurantId: string }) => {
    const { data, error } = await supabase.from('restaurant_terminals').select('id, status, restaurant_id, device_serial').eq('id', terminal.terminalId).eq('restaurant_id', terminal.restaurantId).single()
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
    if (req.headers.get('authorization') !== 'Bearer invoice-manager') throw new Error('Missing authorization')
    return { id: 'c4a05000-0000-4000-8000-000000005001', email: 'manager@chaos.invalid' }
  },
}))

import { POST as openTable } from '@/app/api/terminal/tables/[tableId]/open/route'
import { POST as postRound } from '@/app/api/terminal/rounds/route'
import { GET as getLines } from '@/app/api/terminal/tabs/[tabId]/lines/route'
import { POST as amendTab } from '@/app/api/terminal/tabs/[tabId]/amend/route'
import { POST as allocateLine } from '@/app/api/terminal/tabs/[tabId]/lines/[lineId]/allocate/route'
import { POST as settleAllocations } from '@/app/api/terminal/tabs/[tabId]/settle-allocations/route'
import { POST as settleTab } from '@/app/api/terminal/tabs/[tabId]/settle/route'
import { POST as prepareSplit } from '@/app/api/terminal/tabs/[tabId]/prepare-split-payment/route'
import { POST as recordSplit } from '@/app/api/terminal/tabs/[tabId]/record-split-payment/route'
import { POST as preparePayment } from '@/app/api/terminal/orders/[orderId]/prepare-payment/route'
import { POST as verifyPayment } from '@/app/api/terminal/orders/[orderId]/verify-payment/route'
import { POST as stationLineState } from '@/app/api/station/order-lines/[lineId]/state/route'
import { POST as invoiceFromOrder } from '@/app/api/admin/documents/from-order/route'
import { GET as listDocuments } from '@/app/api/admin/documents/route'
import { GET as agedReceivables } from '@/app/api/admin/documents/aged-receivables/route'
import { GET as documentPdf } from '@/app/api/admin/documents/[id]/pdf/route'
import { POST as documentSend } from '@/app/api/admin/documents/[id]/send/route'
import { extractPdfText } from '../helpers/extract-pdf-text'

function sql<T = Record<string, any>>(query: string): T[] {
  const out = execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { input: `SELECT coalesce(json_agg(t), '[]'::json) FROM (${query}) t;`, encoding: 'utf8' })
  return JSON.parse(out.trim()) as T[]
}
function sqlExec(statement: string): void {
  execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-q', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8' })
}
const cents = (m: unknown) => Math.round(Number(m) * 100)
const money = (c: number) => `NAD ${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
type Json = Record<string, any>

async function call(
  handler: (req: Request, ctx: any) => Promise<Response>,
  path: string,
  opts: { method?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string>; auth?: string } = {},
): Promise<{ status: number; body: Json; bytes?: Uint8Array }> {
  const req = new Request(`https://invoice.test${path}`, {
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json', authorization: opts.auth ?? 'Bearer invoice-terminal', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const res = await handler(req, { params: Promise.resolve(opts.params ?? {}) })
  if ((res.headers.get('content-type') ?? '').includes('application/pdf')) return { status: res.status, body: {}, bytes: new Uint8Array(await res.arrayBuffer()) }
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
const MANAGER_AUTH = 'Bearer invoice-manager'

// ------------------------------------------------------------------------------------------------
// THE WAITER
// ------------------------------------------------------------------------------------------------
type Want = { key: ItemKey; qty: number; note?: string; v?: Record<string, string> }
let tableSeq = 0
async function openTab(label: string): Promise<string> {
  tableSeq += 1
  const t = tableId(tableSeq)
  const res = await call(openTable, `/api/terminal/tables/${t}/open`, {
    params: { tableId: t }, body: { user_id: WAITER, authorization_token_id: mintToken('service_session', WAITER), customer_name: label },
  })
  expectStatus(res, 200)
  return String(res.body.tab.id)
}
async function round(tabId: string, wants: Want[]): Promise<{ orderId: string; lineIds: string[] }> {
  const res = await call(postRound, '/api/terminal/rounds', {
    body: {
      tab_id: tabId, subtotal: 1, total: 1,
      items: wants.map((w) => ({ menuItemId: ITEM[w.key], name: NAME[w.key], quantity: w.qty, ...(w.note ? { note: w.note } : {}), ...(w.v ? { selectedVariants: w.v } : {}), price: 1, unitPrice: 1 })),
    },
    headers: { 'x-idempotency-key': `inv-${randomUUID()}`, 'x-flashtap-variant-protocol': '1' },
  })
  expectStatus(res, 200)
  const orderId = String(res.body.order_id)
  // The server priced it from the menu (the client said N$1), VAT inclusive: the total is the menu price.
  expect(cents(sql(`SELECT total FROM orders WHERE id = '${orderId}'`)[0].total)).toBe(wants.reduce((s, w) => s + priceCents(w.key, w.v) * w.qty, 0))
  const lineIds = sql<{ id: string }>(`SELECT id FROM order_lines WHERE order_id = '${orderId}' ORDER BY source_item_index`).map((r) => r.id)
  return { orderId, lineIds }
}
/** The kitchen and bar start every line, so the order's money is final (invoice eligibility). */
async function startAll(tabId: string) {
  const rows = sql<{ id: string; kitchen_state: string | null; bar_state: string | null }>(`SELECT id, kitchen_state, bar_state FROM order_lines WHERE tab_id = '${tabId}'`)
  for (const l of rows) {
    if (l.kitchen_state === 'outstanding') expectStatus(await call(stationLineState, `/api/station/order-lines/${l.id}/state`, { params: { lineId: l.id }, body: { station: 'kitchen', to_state: 'cooked' } }), 200)
    if (l.bar_state === 'outstanding') expectStatus(await call(stationLineState, `/api/station/order-lines/${l.id}/state`, { params: { lineId: l.id }, body: { station: 'bar', to_state: 'ready' } }), 200)
  }
}
async function amend(tabId: string, amendments: Array<{ line_id: string; new_quantity: number }>) {
  const res = await call(amendTab, `/api/terminal/tabs/${tabId}/amend`, {
    params: { tabId }, body: { amendments, staff_user_id: MANAGER, authorization_token_id: mintToken('line_void'), void_reason: 'invoice chaos' },
  })
  expectStatus(res, 200)
  expect(res.body.refused).toEqual([])
  return res.body
}
async function financials(tabId: string) {
  const res = await call(getLines, `/api/terminal/tabs/${tabId}/lines`, { method: 'GET', params: { tabId } })
  expectStatus(res, 200)
  return res.body as Json
}
async function payItemCash(tabId: string, lineId: string, qty: number) {
  const alloc = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${lineId}/allocate`, { params: { tabId, lineId }, body: { shares: [{ allocated_to: 'Guest', quantity_allocated: qty }] } })
  expectStatus(alloc, 200)
  const res = await call(settleAllocations, `/api/terminal/tabs/${tabId}/settle-allocations`, { params: { tabId }, body: { allocation_ids: (alloc.body.allocations as Json[]).map((a) => a.id), method: 'cash' } })
  expectStatus(res, 200)
}
async function payItemSplitCard(tabId: string, lineId: string, qty: number) {
  const alloc = await call(allocateLine, `/api/terminal/tabs/${tabId}/lines/${lineId}/allocate`, { params: { tabId, lineId }, body: { shares: [{ allocated_to: 'Guest', quantity_allocated: qty }] } })
  expectStatus(alloc, 200)
  const prep = await call(prepareSplit, `/api/terminal/tabs/${tabId}/prepare-split-payment`, { params: { tabId }, body: { allocation_ids: (alloc.body.allocations as Json[]).map((a) => a.id) } })
  expectStatus(prep, 200)
  txnSeq += 1
  const rec = await call(recordSplit, `/api/terminal/tabs/${tabId}/record-split-payment`, { params: { tabId }, body: { merchant_order_no: prep.body.merchant_order_no, outcome: 'success', transaction_id: `INV-SPLIT-${txnSeq}` } })
  expectStatus(rec, 200)
  expect(rec.body.status).toBe('confirmed')
}
/** Whole-order card: prepare-payment, the reader is approved, "Check payment status" settles it. */
async function payCard(tabId: string): Promise<{ mo: string; cents: number }> {
  const f = await financials(tabId)
  const owing = Object.entries(f.financials.orders as Record<string, Json>).filter(([, o]) => o.outstanding_cents > 0).map(([id]) => id)
  const prep = await call(preparePayment, `/api/terminal/orders/${owing[0]}/prepare-payment`, { params: { orderId: owing[0] }, body: { order_ids: owing } })
  expectStatus(prep, 200)
  const mo = String(prep.body.merchantOrderNo)
  const chargeCents = Number(prep.body.chargeCents)
  expect(chargeCents).toBe(f.financials.tab.outstanding_cents)
  txnSeq += 1
  paidAtGateway.set(mo, { cents: chargeCents, txn: `INV-TXN-${txnSeq}` })
  const v = await call(verifyPayment, `/api/terminal/orders/${owing[0]}/verify-payment`, { params: { orderId: owing[0] }, body: {} })
  expectStatus(v, 200)
  expect(v.body).toMatchObject({ paid: true, applied: true })
  return { mo, cents: chargeCents }
}
async function payCash(tabId: string) {
  const f = await financials(tabId)
  const owing = Object.entries(f.financials.orders as Record<string, Json>).filter(([, o]) => o.outstanding_cents > 0).map(([id]) => id)
  const res = await call(settleTab, `/api/terminal/tabs/${tabId}/settle`, { params: { tabId }, body: { order_ids: owing, method: 'cash', amount: f.financials.tab.outstanding_cents / 100 } })
  expectStatus(res, 200)
}

// ------------------------------------------------------------------------------------------------
// THE INVOICE
// ------------------------------------------------------------------------------------------------
async function invoiceTab(tabId: string, extra: Json = {}) {
  return call(invoiceFromOrder, '/api/admin/documents/from-order', {
    auth: MANAGER_AUTH,
    body: { tab_id: tabId, restaurant_id: R, bill_to: { name: 'Acme (Pty) Ltd', email: 'ap@acme.test', address: '1 Invoice Road' }, ...extra },
  })
}
async function pdfText(docId: string): Promise<{ status: number; text: string; body: Json }> {
  const res = await call(documentPdf, `/api/admin/documents/${docId}/pdf`, { method: 'GET', params: { id: docId }, auth: MANAGER_AUTH })
  if (res.status !== 200) return { status: res.status, text: '', body: res.body }
  return { status: 200, text: (await extractPdfText(res.bytes!)).replace(/\s+/g, ' '), body: {} }
}
async function sendAndRead(docId: string): Promise<string> {
  const before = emails.length
  const res = await call(documentSend, `/api/admin/documents/${docId}/send`, { params: { id: docId }, auth: MANAGER_AUTH, body: {} })
  expectStatus(res, 200)
  expect(emails.length).toBe(before + 1)
  const attachment = emails[emails.length - 1].attachments[0]
  expect(attachment.content_type).toBe('application/pdf')
  return (await extractPdfText(new Uint8Array(Buffer.from(String(attachment.content), 'base64')))).replace(/\s+/g, ' ')
}

/**
 * THE INVARIANTS every case asserts, over exactly the orders the invoice covers, against the
 * terminal lines route's projection (not against the invoice engine's own arithmetic).
 */
async function assertInvoice(label: string, tabId: string, docId: string, text: string) {
  const [doc] = sql(`SELECT total, subtotal, vat_amount, balance, status, order_ids, line_items, cancelled_line_items FROM business_documents WHERE id = '${docId}'`)
  const covered: string[] = doc.order_ids
  const f = await financials(tabId)
  const per = covered.map((id) => f.financials.orders[id] as Json)
  const live = per.reduce((s, o) => s + o.live_cents, 0)
  const paid = per.reduce((s, o) => s + o.paid_cents, 0)
  const outstanding = per.reduce((s, o) => s + o.outstanding_cents, 0)
  const recorded = sql<{ c: number }>(`SELECT coalesce(sum(round(amount*100)),0)::int AS c FROM document_payments WHERE document_id = '${docId}'`)[0].c
  const status = outstanding === 0 ? 'paid' : paid > 0 ? 'partially_paid' : null
  expect({ label, total: cents(doc.total), balance: cents(doc.balance), recorded, ...(status ? { status: doc.status } : {}) })
    .toEqual({ label, total: live, balance: outstanding, recorded: paid, ...(status ? { status } : {}) })
  // VAT is inside the total (15% inclusive), never on top of it, and never zero here.
  expect({ label, sum: cents(doc.subtotal) + cents(doc.vat_amount) }).toEqual({ label, sum: cents(doc.total) })
  expect(cents(doc.vat_amount)).toBeGreaterThan(0)
  expect(Math.abs(cents(doc.vat_amount) - Math.round(cents(doc.total) * 15 / 115))).toBeLessThanOrEqual(doc.line_items.length)
  // One document line per LIVE line; one cancelled line per VOIDED line. No duplicates.
  const allLines = (f.orders as Json[]).filter((o) => covered.includes(String(o.order_id))).flatMap((o) => o.lines as Json[])
  expect({ label, billed: doc.line_items.length, cancelled: (doc.cancelled_line_items ?? []).length })
    .toEqual({ label, billed: allLines.filter((l) => !l.is_voided).length, cancelled: allLines.filter((l) => l.is_voided).length })
  const billed = (doc.line_items as Json[]).reduce((s, l) => s + cents(l.line_total), 0)
  expect({ label, billed }).toEqual({ label, billed: live })
  // The PDF says the same.
  expect(text).toContain(`Total ${money(live)}`)
  expect(text).toContain(`Amount paid ${money(paid)}`)
  expect(text).toContain(`Amount outstanding ${money(outstanding)}`)
  expect(text).toContain(`VAT ${money(cents(doc.vat_amount))}`)
  const stamp = outstanding === 0 ? 'PAID' : paid > 0 ? 'PARTIALLY PAID' : 'UNPAID'
  expect({ label, stamp: text.includes(`TAX INVOICE ${stamp}`) }).toEqual({ label, stamp: true })
  // A paid invoice never shows the full balance due.
  if (paid > 0) expect(text).not.toContain(`Amount outstanding ${money(live)}`)
  return { live, paid, outstanding, doc }
}

beforeAll(() => {
  sqlExec(`UPDATE public.restaurants SET finatic_merchant_no = 'INV-MERCHANT', finatic_store_no = 'INV-STORE' WHERE id = '${R}';`)
  // A real VAT rate, so every invoice carries VAT (inclusive: the menu price is the gross).
  sqlExec(`INSERT INTO public.tax_rates (restaurant_id, name, percentage, is_inclusive, is_default) VALUES ('${R}', 'VAT 15%', 15, true, true);`)
  for (let n = 1; n <= 12; n += 1) {
    sqlExec(`INSERT INTO public.restaurant_tables (id, restaurant_id, table_number, table_name, active, status)
             VALUES ('${tableId(n)}', '${R}', ${200 + n}, 'Invoice ${n}', true, 'available') ON CONFLICT DO NOTHING;`)
  }
})

let broken: string | null = null
function scenario(title: string, fn: () => Promise<void>) {
  test(title, async () => {
    if (broken) throw new Error(`not run: an earlier case failed (${broken})`)
    broken = title
    await fn()
    broken = null
  }, 180_000)
}

// ================================================================================================
describe('invoice chaos', () => {
  scenario('J1 unpaid: full balance due, nothing paid, the tab untouched', async () => {
    const tab = await openTab('J1')
    const { orderId } = await round(tab, [{ key: 'burger', qty: 2, note: 'no onion' }, { key: 'lager', qty: 1 }])
    // Not final yet: a line nobody has started can still leave the bill.
    const early = await invoiceTab(tab)
    expect({ status: early.status, code: early.body.code }).toEqual({ status: 409, code: 'ORDER_NOT_FINAL' })
    await startAll(tab)
    const res = await invoiceTab(tab)
    expectStatus(res, 201)
    const pdf = await pdfText(res.body.document.id)
    expect(pdf.status).toBe(200)
    const r = await assertInvoice('J1', tab, res.body.document.id, pdf.text)
    expect({ paid: r.paid, outstanding: r.outstanding, status: r.doc.status }).toEqual({ paid: 0, outstanding: 9850 * 2 + 3200, status: 'draft' })
    // An invoice is not a payment.
    expect(sql(`SELECT payment_status FROM orders WHERE id = '${orderId}'`)[0].payment_status).toBe('pending')
    expect(sql(`SELECT count(*)::int AS n FROM document_payments WHERE document_id = '${res.body.document.id}'`)[0].n).toBe(0)
  })

  scenario('J2 partial: one item paid in cash before the invoice', async () => {
    const tab = await openTab('J2')
    const { lineIds } = await round(tab, [{ key: 'salad', qty: 1 }, { key: 'lager', qty: 2, note: 'pints' }])
    await payItemCash(tab, lineIds[1], 2)
    await startAll(tab)
    const res = await invoiceTab(tab)
    expectStatus(res, 201)
    const r = await assertInvoice('J2', tab, res.body.document.id, (await pdfText(res.body.document.id)).text)
    expect({ paid: r.paid, outstanding: r.outstanding, status: r.doc.status }).toEqual({ paid: 6400, outstanding: 7200, status: 'partially_paid' })
    expect(sql(`SELECT method FROM document_payments WHERE document_id = '${res.body.document.id}'`).map((p) => p.method)).toEqual(['cash'])
  })

  scenario('J3 fully paid by card: masked reference, balance 0, emailed', async () => {
    const tab = await openTab('J3')
    await round(tab, [{ key: 'ribeye', qty: 1, v: { Doneness: 'Rare' } }, { key: 'wine', qty: 1, v: { Glass: 'Large' } }])
    const card = await payCard(tab)
    const res = await invoiceTab(tab)
    expectStatus(res, 201)
    const pdf = (await pdfText(res.body.document.id)).text
    await assertInvoice('J3', tab, res.body.document.id, pdf)
    const [p] = sql(`SELECT method, reference FROM document_payments WHERE document_id = '${res.body.document.id}'`)
    expect(p.method).toBe('card')
    expect(pdf).toContain(`CARD ${'*'.repeat(String(p.reference).length - 4)}${String(p.reference).slice(-4)}`)
    expect(pdf).not.toContain(String(p.reference)) // never printed in full
    expect(card.cents).toBe(24500 + 6800)
    const mailed = await sendAndRead(res.body.document.id)
    expect(mailed).toBe(pdf)
  })

  scenario('J4 cancelled lines: shown, never charged', async () => {
    const tab = await openTab('J4')
    const { lineIds } = await round(tab, [{ key: 'burger', qty: 1 }, { key: 'salad', qty: 1, note: 'no croutons' }, { key: 'espresso', qty: 2 }])
    await amend(tab, [{ line_id: lineIds[1], new_quantity: 0 }])
    await payCash(tab)
    const res = await invoiceTab(tab)
    expectStatus(res, 201)
    const pdf = (await pdfText(res.body.document.id)).text
    const r = await assertInvoice('J4', tab, res.body.document.id, pdf)
    expect(r.live).toBe(9850 + 5200)
    expect(r.doc.cancelled_line_items).toEqual([expect.objectContaining({ description: 'Caesar Salad', quantity: 1, line_total: 72, reason: 'voided' })])
    expect(pdf).toContain('Caesar Salad (voided')
    expect((r.doc.line_items as Json[]).some((l) => l.description === 'Caesar Salad')).toBe(false)
  })

  scenario('J5 amended: a reduced line is billed once, at the new quantity', async () => {
    const tab = await openTab('J5')
    const { lineIds } = await round(tab, [{ key: 'lager', qty: 4, note: 'jug' }, { key: 'chips', qty: 1 }])
    const a = await amend(tab, [{ line_id: lineIds[0], new_quantity: 1 }])
    expect(a.lines.map((l: Json) => [l.outcome, l.previous_quantity, l.quantity])).toEqual([['reduced', 4, 1]])
    await payCard(tab)
    const res = await invoiceTab(tab)
    expectStatus(res, 201)
    const r = await assertInvoice('J5', tab, res.body.document.id, (await pdfText(res.body.document.id)).text)
    const lagers = (r.doc.line_items as Json[]).filter((l) => l.description === 'Lager')
    expect(lagers).toEqual([expect.objectContaining({ quantity: 1, line_total: 32 })])
    expect(r.doc.cancelled_line_items).toEqual([expect.objectContaining({ description: 'Lager', quantity: 4, reason: 'voided' })])
    expect(r.live).toBe(3200 + 3500)
  })

  scenario('J6 whole tab: every round on one invoice, once', async () => {
    const tab = await openTab('J6')
    const a = await round(tab, [{ key: 'burger', qty: 1 }])
    const b = await round(tab, [{ key: 'cheesecake', qty: 2 }, { key: 'espresso', qty: 2 }])
    await payCash(tab)
    const res = await invoiceTab(tab)
    expectStatus(res, 201)
    const r = await assertInvoice('J6', tab, res.body.document.id, (await pdfText(res.body.document.id)).text)
    expect([...r.doc.order_ids].sort()).toEqual([a.orderId, b.orderId].sort())
    const again = await invoiceTab(tab)
    expect({ status: again.status, code: again.body.code }).toEqual({ status: 409, code: 'INVOICE_ALREADY_EXISTS' })
    const perOrder = await call(invoiceFromOrder, '/api/admin/documents/from-order', { auth: MANAGER_AUTH, body: { order_id: a.orderId, restaurant_id: R, bill_to: { name: 'Acme' } } })
    expect({ status: perOrder.status, code: perOrder.body.code }).toEqual({ status: 409, code: 'INVOICE_ALREADY_EXISTS' })
  })

  scenario('J7 variants: the option is named and priced on every line', async () => {
    const tab = await openTab('J7')
    await round(tab, [
      { key: 'pasta', qty: 2, v: { Size: 'Large', Sauce: 'Cream' } },
      { key: 'pasta', qty: 1, v: { Size: 'Regular', Sauce: 'Tomato' } },
      { key: 'wine', qty: 3, v: { Glass: 'Small' } },
    ])
    await payCash(tab)
    const res = await invoiceTab(tab)
    expectStatus(res, 201)
    const pdf = (await pdfText(res.body.document.id)).text
    const r = await assertInvoice('J7', tab, res.body.document.id, pdf)
    expect((r.doc.line_items as Json[]).map((l) => [l.description, l.quantity, cents(l.unit_price)])).toEqual([
      ['Modena Pasta - Large / Cream', 2, 15500],
      ['Modena Pasta - Regular / Tomato', 1, 12000],
      ['House Wine - Small', 3, 4500],
    ])
    expect(pdf).toContain('Modena Pasta - Large / Cream')
  })

  scenario('J8 paid AFTER the invoice: the invoice follows the ledger everywhere it is shown or sent', async () => {
    const tab = await openTab('J8')
    const { lineIds } = await round(tab, [{ key: 'ribeye', qty: 1, v: { Doneness: 'Medium' } }, { key: 'salad', qty: 1 }, { key: 'lager', qty: 2 }])
    await startAll(tab)
    // Issued unpaid, due in the past, and sent -- the customer now holds an UNPAID invoice.
    const res = await invoiceTab(tab, { due_date: '2026-01-31' })
    expectStatus(res, 201)
    const docId = String(res.body.document.id)
    const snapshot = sql(`SELECT total, subtotal, vat_amount, line_items, cancelled_line_items FROM business_documents WHERE id = '${docId}'`)[0]
    const first = await sendAndRead(docId)
    expect(first).toContain('TAX INVOICE UNPAID')
    await assertInvoice('J8 at issue', tab, docId, first)
    const aged = async () => {
      const a = await call(agedReceivables, `/api/admin/documents/aged-receivables?restaurant_id=${R}`, { method: 'GET', auth: MANAGER_AUTH })
      expectStatus(a, 200)
      return (a.body.invoices as Json[]).find((i) => i.id === docId)
    }
    expect(cents((await aged())?.balance)).toBe(24500 + 7200 + 6400)

    // Part of it is paid at the table: one item, cash.
    await payItemCash(tab, lineIds[2], 2)
    const partial = await pdfText(docId)
    expect(partial.status).toBe(200)
    await assertInvoice('J8 after the item payment', tab, docId, partial.text)
    expect(partial.text).toContain('TAX INVOICE PARTIALLY PAID')
    expect(cents((await aged())?.balance)).toBe(24500 + 7200)

    // The rest by card. Two surfaces refresh at the same moment: one payment row, not two.
    const card = await payCard(tab)
    const [a, b] = await Promise.all([pdfText(docId), pdfText(docId)])
    expect([a.status, b.status]).toEqual([200, 200])
    const cardRows = sql(`SELECT amount, method, reference FROM document_payments WHERE document_id = '${docId}' AND method = 'card'`)
    expect(cardRows).toHaveLength(1)
    expect(cents(cardRows[0].amount)).toBe(card.cents)
    const settled = await assertInvoice('J8 after the card payment', tab, docId, a.text)
    expect(settled.outstanding).toBe(0)
    expect(a.text).toContain('TAX INVOICE PAID')
    expect(a.text).toContain('Amount outstanding NAD 0.00')
    // Every other surface agrees: nobody is chased, the list says paid.
    expect(await aged()).toBeUndefined()
    const list = await call(listDocuments, `/api/admin/documents?restaurant_id=${R}&type=invoice`, { method: 'GET', auth: MANAGER_AUTH })
    expectStatus(list, 200)
    const row = (list.body.documents as Json[]).find((d) => d.id === docId)
    expect({ status: row?.status, balance: cents(row?.balance) }).toEqual({ status: 'paid', balance: 0 })
    // The lines and total never moved: the snapshot is the snapshot.
    expect(sql(`SELECT total, subtotal, vat_amount, line_items, cancelled_line_items FROM business_documents WHERE id = '${docId}'`)[0]).toEqual(snapshot)
    // Payment rows are append-only: the cash row from before is still there, unchanged.
    expect(sql(`SELECT method, round(amount*100)::int AS c FROM document_payments WHERE document_id = '${docId}' ORDER BY method`)).toEqual([
      { method: 'card', c: card.cents }, { method: 'cash', c: 6400 },
    ])
  })

  scenario('J9 after several payments: each payment on the invoice, by method and reference', async () => {
    const tab = await openTab('J9')
    const a = await round(tab, [{ key: 'burger', qty: 1 }, { key: 'chips', qty: 2 }, { key: 'lager', qty: 1 }])
    const b = await round(tab, [{ key: 'cheesecake', qty: 1 }])
    await payItemCash(tab, a.lineIds[1], 2)        // cash, by item
    await payItemSplitCard(tab, a.lineIds[2], 1)   // split card, by item
    const card = await payCard(tab)                 // card, whole-order, the rest of both rounds
    const res = await invoiceTab(tab)
    expectStatus(res, 201)
    const pdf = (await pdfText(res.body.document.id)).text
    const r = await assertInvoice('J9', tab, res.body.document.id, pdf)
    const rows = sql<{ method: string; c: number }>(`SELECT method, round(amount*100)::int AS c FROM document_payments WHERE document_id = '${res.body.document.id}' ORDER BY c`)
    expect(rows).toEqual([{ method: 'card', c: 3200 }, { method: 'cash', c: 7000 }, { method: 'card', c: card.cents }])
    expect(card.cents).toBe(9850 + 5500)
    expect(rows.reduce((s, x) => s + x.c, 0)).toBe(r.live)
    expect(b.orderId).toBeTruthy()
  })

  scenario('J10 after cancel and re-add: the re-added item billed once, the cancelled one shown', async () => {
    const tab = await openTab('J10')
    const a = await round(tab, [{ key: 'wine', qty: 1, v: { Glass: 'Large' } }, { key: 'burger', qty: 1 }])
    await amend(tab, [{ line_id: a.lineIds[0], new_quantity: 0 }])
    await round(tab, [{ key: 'wine', qty: 1, v: { Glass: 'Small' } }])
    await payCash(tab)
    const res = await invoiceTab(tab)
    expectStatus(res, 201)
    const pdf = (await pdfText(res.body.document.id)).text
    const r = await assertInvoice('J10', tab, res.body.document.id, pdf)
    expect((r.doc.line_items as Json[]).map((l) => l.description).sort()).toEqual(['Burger', 'House Wine - Small'])
    expect(r.doc.cancelled_line_items).toEqual([expect.objectContaining({ description: 'House Wine - Large', reason: 'voided' })])
    expect(r.live).toBe(9850 + 4500)
    expect(pdf).toContain('House Wine - Large (voided')
  })
})
