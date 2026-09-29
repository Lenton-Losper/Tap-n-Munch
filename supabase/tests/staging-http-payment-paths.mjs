#!/usr/bin/env node
/**
 * STAGING HTTP — the payment paths the chaos tab does not walk. Deployed staging worker, 'staging
 * test' venue, real HTTP. Everything created carries MARKER and is deleted in `finally`.
 *
 *   STAGING_MANAGER_BEARER=<token> node supabase/tests/staging-http-payment-paths.mjs
 *
 *   V  variants over HTTP: valid variant priced by the server; required variant missing with the
 *      protocol header refused 400 (nothing written); the same request WITHOUT the header (a 2.39
 *      device) accepted at legacy pricing
 *   I  invoice for a single order: real PDF bytes, then the existing email-with-PDF send route
 *      (recipient: Resend's test address delivered@resend.dev — no real inbox)
 *   F  payment failure: prepare a card charge, the device reports FAILED; the order still owes,
 *      no ledger row of any kind
 *   N  SETTLEMENT_SET_NOT_CLAIMABLE: one order paid in cash, then a card prepare naming it
 *   M  manual Mark-as-Paid: immutable non-gateway ledger row with the server amount and the staff
 *      actor; a replay is 409; cancelling the paid order is refused
 *   R  staff reconcile: an unbound reference is refused, unauthenticated is refused, nothing paid
 *   S  security over PostgREST with the PUBLIC anon key: the three line RPCs and correct_invoice
 *      refuse anon; positive control: an RLS helper anon may call answers
 *
 * NEVER PRODUCTION: the base URL must be the staging worker, and connectStaging() refuses a
 * database without the 'staging test' venue.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const STAGING_HOST = 'flashtap-staging.llosperofficial.workers.dev'
const BASE = `https://${STAGING_HOST}`
const VENUE = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const MARKER = 'HTTPPAY-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const MANAGER_BEARER = process.env.STAGING_MANAGER_BEARER ?? ''
const ENV_TEST = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.test'
if (!MANAGER_BEARER) throw new Error('STAGING_MANAGER_BEARER is required')
const envTest = Object.fromEntries(
  readFileSync(ENV_TEST, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]),
)
const SUPA = envTest.SUPABASE_URL
const ANON = envTest.SUPABASE_ANON_KEY
if (!SUPA.startsWith(`https://${STAGING_REF}.`) || SUPA.includes(PROD_REF)) throw new Error('REFUSING: not the staging project')

const { connectStaging } = await import('./staging-db.mjs')
const client = await connectStaging()
const q = async (sql, params = []) => (await client.query(sql, params)).rows

let pass = 0
let fail = 0
const ok = (n, c, d) => {
  if (c) { pass += 1; console.log('  PASS  ' + n) } else { fail += 1; console.log('  FAIL  ' + n + (d ? ' -- ' + d : '')) }
}
const made = { category: null, items: {}, table: null, terminal: null, tab: null, tokens: [], docs: [], featureWasOff: false }
let token = ''
async function http(method, path, body, headers = {}, bearer = token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const buf = Buffer.from(await r.arrayBuffer())
  let json = null
  try { json = JSON.parse(buf.toString('utf8')) } catch { json = null }
  return { status: r.status, body: json, bytes: buf, type: r.headers.get('content-type') ?? '' }
}
async function mint(purpose, userId) {
  const id = randomUUID()
  await q(`insert into public.privileged_authorization_tokens (id,user_id,restaurant_id,terminal_id,purpose,nonce,ttl_seconds,expires_at)
           values ($1,$2,$3,$4,$5,$6,90, now() + interval '90 seconds')`, [id, userId, VENUE, made.terminal, purpose, randomUUID()])
  made.tokens.push(id)
  return id
}
async function round(key, items, protocol = true) {
  return http('POST', '/api/terminal/rounds', { tab_id: made.tab, items, subtotal: 1, total: 1 },
    { 'x-idempotency-key': `${MARKER}-${key}`, ...(protocol ? { 'x-flashtap-variant-protocol': '1' } : {}) })
}
const orderRow = async (id) => (await q('select id, total, payment_status, status, payment_method from public.orders where id = $1', [id]))[0]

try {
  // ---- fixture -------------------------------------------------------------------------------
  const [feature] = await q('select station_screens_enabled from public.restaurant_features where restaurant_id = $1', [VENUE])
  if (!feature?.station_screens_enabled) {
    made.featureWasOff = true
    await q('update public.restaurant_features set station_screens_enabled = true where restaurant_id = $1', [VENUE])
  }
  const [staff] = await q("select user_id from public.restaurant_users where restaurant_id = $1 and deleted_at is null and role in ('owner','manager') order by (role='owner') desc limit 1", [VENUE])
  const MANAGER = staff.user_id
  made.category = randomUUID()
  await q("insert into public.menu_categories (id, restaurant_id, name, active, route_to) values ($1,$2,$3,true,'bar')", [made.category, VENUE, MARKER + ' bar'])
  const ITEMS = [
    ['latte', 'Latte', 0, [{ name: 'Size', required: true, type: 'price', options: [{ label: 'Small', price: 30 }, { label: 'Large', price: 45 }] }]],
    ['bun', 'Bun', 20, [{ name: 'Size', required: true, type: 'price', options: [{ label: 'Small', price: 20 }, { label: 'Large', price: 35 }] }]],
    ['water', 'Water', 15, []],
  ]
  for (const [key, name, price, groups] of ITEMS) {
    const id = randomUUID()
    await q("insert into public.menu_items (id, restaurant_id, category_id, name, base_price, status, variant_groups) values ($1,$2,$3,$4,$5,'active',$6::jsonb)",
      [id, VENUE, made.category, `${MARKER} ${name}`, price, JSON.stringify(groups)])
    made.items[key] = id
  }
  made.table = randomUUID()
  await q("insert into public.restaurant_tables (id, restaurant_id, table_number, status, active) values ($1,$2,$3,'available',true)", [made.table, VENUE, 9000 + Math.floor(Math.random() * 900)])
  made.terminal = randomUUID()
  const code = String(Math.floor(100000 + Math.random() * 899999))
  await q("insert into public.restaurant_terminals (id, restaurant_id, name, active, activation_code, activation_code_expires_at) values ($1,$2,$3,false,$4, now() + interval '1 hour')", [made.terminal, VENUE, MARKER + '-term', code])
  const act = await fetch(BASE + '/api/terminals/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceId: MARKER + '-dev', terminalSn: MARKER + '-sn' }) })
  token = (await act.json().catch(() => ({})))?.accessToken
  ok('CONTROL terminal activated over HTTP', act.status === 200 && !!token, `status=${act.status}`)
  const open = await http('POST', `/api/terminal/tables/${made.table}/open`, { user_id: MANAGER, authorization_token_id: await mint('service_session', MANAGER), customer_name: MARKER })
  made.tab = open.body?.tab?.id
  ok('CONTROL tab opened', open.status === 200 && !!made.tab)

  // ---- V: variants ------------------------------------------------------------------------------
  const menu = await http('GET', `/api/menu/${VENUE}/category/${made.category}`, undefined, {}, '')
  // The route answers { [group]: { items: [...] } } (lib/supabase/menu.ts withResolvedVariantGroups).
  const menuItems = Object.values(menu.body ?? {}).flatMap((g) => (Array.isArray(g?.items) ? g.items : []))
  const latteWire = menuItems.find((i) => i.id === made.items.latte)
  ok('V0 catalog carries resolved_variant_groups for the terminal', Array.isArray(latteWire?.resolved_variant_groups) && latteWire.resolved_variant_groups[0]?.options?.length === 2, JSON.stringify(latteWire?.resolved_variant_groups ?? menu.status).slice(0, 160))
  const ordersBefore = (await q('select count(*)::int n from public.orders where tab_id = $1', [made.tab]))[0].n
  const vMissing = await round('VM', [{ menuItemId: made.items.latte, name: 'Latte', quantity: 1, price: 999 }])
  const ordersAfter = (await q('select count(*)::int n from public.orders where tab_id = $1', [made.tab]))[0].n
  ok('V1 required variant missing (protocol 1): 400 MENU_ITEM_VARIANT_REQUIRED, nothing written', vMissing.status === 400 && vMissing.body?.code === 'MENU_ITEM_VARIANT_REQUIRED' && ordersAfter === ordersBefore, `status=${vMissing.status} code=${vMissing.body?.code}`)
  const vBad = await round('VB', [{ menuItemId: made.items.latte, name: 'Latte', quantity: 1, selectedVariants: { Size: 'Gigantic' } }])
  ok('V2 invalid option: 400 MENU_ITEM_UNPRICEABLE_SELECTION', vBad.status === 400 && vBad.body?.code === 'MENU_ITEM_UNPRICEABLE_SELECTION', `status=${vBad.status} code=${vBad.body?.code}`)
  const A = await round('A', [{ menuItemId: made.items.water, name: 'Water', quantity: 2, price: 1 }, { menuItemId: made.items.latte, name: 'Latte', quantity: 1, selectedVariants: { Size: 'Large' }, price: 1 }])
  const a = await orderRow(A.body?.order_id)
  const aLines = await q('select name_snapshot from public.order_lines where order_id = $1 order by source_item_index', [A.body?.order_id])
  ok('V3 valid variant on a base-0 item: server price 45, stale client price 1 ignored, order 75.00', A.status === 200 && Math.round(Number(a?.total) * 100) === 7500, `status=${A.status} total=${a?.total}`)
  ok('V4 the variant reaches the station line name', aLines.some((l) => /Latte.*Large/.test(l.name_snapshot)), JSON.stringify(aLines))
  const legacy = await round('L', [{ menuItemId: made.items.bun, name: 'Bun', quantity: 1 }], false)
  const l = await orderRow(legacy.body?.order_id)
  ok('V5 2.39 device (no protocol header), required variant missing: accepted at legacy base price 20.00', legacy.status === 200 && Math.round(Number(l?.total) * 100) === 2000, `status=${legacy.status} total=${l?.total}`)

  // ---- I: invoice, PDF, email -------------------------------------------------------------------
  const C = await round('C', [{ menuItemId: made.items.latte, name: 'Latte', quantity: 1, selectedVariants: { Size: 'Small' } }])
  const cLine = (await q('select id from public.order_lines where order_id = $1', [C.body?.order_id]))[0]
  const bump = await http('POST', `/api/station/order-lines/${cLine.id}/state`, { station: 'bar', to_state: 'ready' })
  const inv = await http('POST', '/api/admin/documents/from-order', { order_id: C.body?.order_id, restaurant_id: VENUE, bill_to: { name: MARKER, email: 'delivered@resend.dev' } }, {}, MANAGER_BEARER)
  const doc = inv.body?.document
  if (doc?.id) made.docs.push(doc.id)
  ok('I1 order invoice created: total 30.00 = live, UNPAID balance 30.00, variant on the line', inv.status === 201 && Number(doc?.total) === 30 && Number(doc?.balance) === 30 && JSON.stringify(doc?.line_items ?? '').includes('Small'), `bump=${bump.status} status=${inv.status} ${JSON.stringify(inv.body).slice(0, 200)}`)
  if (doc?.id) {
    const pdf = await http('GET', `/api/admin/documents/${doc.id}/pdf`, undefined, {}, MANAGER_BEARER)
    ok('I2 real PDF bytes from the PDF route', pdf.status === 200 && pdf.bytes.subarray(0, 5).toString('latin1') === '%PDF-', `status=${pdf.status} type=${pdf.type} first=${pdf.bytes.subarray(0, 8).toString('latin1')}`)
    const send = await http('POST', `/api/admin/documents/${doc.id}/send`, {}, {}, MANAGER_BEARER)
    const [after] = await q('select status, sent_at from public.business_documents where id = $1', [doc.id])
    const audit = await q("select action from public.audit_logs where entity_id = $1 order by created_at desc limit 3", [doc.id])
    ok('I3 email-with-PDF send route: provider accepted, document marked sent, attempt audited', send.status === 200 && after?.status === 'sent' && !!after?.sent_at && audit.length > 0, `status=${send.status} ${JSON.stringify(send.body).slice(0, 200)} doc=${after?.status} audit=${audit.map((x) => x.action)}`)
  }

  // ---- F: card failure --------------------------------------------------------------------------
  const prep = await http('POST', `/api/terminal/orders/${A.body?.order_id}/prepare-payment`, { order_ids: [A.body?.order_id] })
  ok('F1 card prepare for A charges the live 75.00', prep.status === 200 && Number(prep.body?.chargeCents) === 7500, `status=${prep.status} ${JSON.stringify(prep.body).slice(0, 160)}`)
  // D1 (owner ruling 2026-09-29): a gateway-VERIFIED decline on a TAB order. The staging-only stub
  // makes Finatic answer "recognisably not paid" (the real sandbox has no record of an uncharged
  // reference and would answer E04111, which never reaches the decline branch). Honoured only when
  // the worker's ENVIRONMENT is staging (lib/payments/staging-finatic-stub.ts).
  const failed = await http('POST', `/api/terminal/orders/${A.body?.order_id}/payment`, { status: 'failed', amount: 75, reference: MARKER + '-fail', cancellationReason: 'declined', __stagingFinaticStub: 'not_paid' })
  const aAfter = await orderRow(A.body?.order_id)
  const saleRows = (await q('select count(*)::int n from public.payment_events where order_ids && $1::uuid[]', [[A.body?.order_id]]))[0].n
  const ngRows = (await q('select count(*)::int n from public.non_gateway_payment_events where $1 = any(order_ids)', [A.body?.order_id]))[0].n
  ok('F2 device reports FAILED: no gateway or non-gateway ledger row', failed.status < 500 && aAfter?.payment_status !== 'paid' && saleRows === 0 && ngRows === 0, `status=${failed.status} ps=${aAfter?.payment_status} sale=${saleRows} ng=${ngRows}`)
  const [aPend] = await q('select status, payment_status, pending_charge_cents, cancellation_reason from public.orders where id = $1', [A.body?.order_id])
  const intentsA = await q('select status from public.terminal_payment_intents where $1 = any(order_ids)', [A.body?.order_id])
  const kept = (await q("select count(*)::int n from public.audit_logs where entity_id = $1 and action = 'payment.attempt_failed_order_kept'", [A.body?.order_id]))[0].n
  ok('F3 D1: a verified decline on a TAB keeps the order owed (attempt_released_order_kept), attempt released, intent failed, audited',
    failed.body?.outcome === 'attempt_released_order_kept' && aPend?.payment_status !== 'cancelled' && aPend?.status !== 'cancelled' && aPend?.pending_charge_cents == null && intentsA.every((i) => i.status === 'failed') && kept === 1,
    `outcome=${failed.body?.outcome} order=${aPend?.status}/${aPend?.payment_status} reason=${aPend?.cancellation_reason} pending=${aPend?.pending_charge_cents} intents=${intentsA.map((i) => i.status)} kept=${kept}`)
  const linesF = await http('GET', `/api/terminal/tabs/${made.tab}/lines`)
  const owedA = linesF.body?.financials?.orders?.[A.body?.order_id]?.outstanding_cents
  ok('F4 D1: the tab still owes the full 75.00 for order A', owedA === 7500, `outstanding=${owedA}`)

  // ---- N: SETTLEMENT_SET_NOT_CLAIMABLE ----------------------------------------------------------
  const B = await round('B', [{ menuItemId: made.items.water, name: 'Water', quantity: 1 }])
  const cashB = await http('POST', `/api/terminal/tabs/${made.tab}/settle`, { order_ids: [B.body?.order_id], method: 'cash', amount: 15 })
  ok('N1 order B paid in cash', cashB.status === 200 && (await orderRow(B.body?.order_id))?.payment_status === 'paid', `status=${cashB.status}`)
  const ngB = await q('select amount_cents, method, origin from public.non_gateway_payment_events where $1 = any(order_ids)', [B.body?.order_id])
  ok('N2 cash settle wrote one immutable non-gateway ledger row of 1500 cash', ngB.length === 1 && ngB[0].amount_cents === 1500 && ngB[0].method === 'cash', JSON.stringify(ngB))
  // Wait out the in-flight window? Not needed: the not-claimable refusal is checked before anything else.
  const mixed = await http('POST', `/api/terminal/orders/${A.body?.order_id}/prepare-payment`, { order_ids: [A.body?.order_id, B.body?.order_id] })
  const nc = mixed.body?.not_claimable ?? []
  ok('N3 prepare naming a paid order: 409 SETTLEMENT_SET_NOT_CLAIMABLE, B named with reason paid', mixed.status === 409 && mixed.body?.code === 'SETTLEMENT_SET_NOT_CLAIMABLE' && nc.some((x) => x.order_id === B.body?.order_id && x.reason === 'paid'), `status=${mixed.status} ${JSON.stringify(mixed.body).slice(0, 200)}`)

  // ---- M: manual Mark-as-Paid (legacy order L, no card attempt) ---------------------------------
  const mp = await http('PATCH', `/api/orders/${legacy.body?.order_id}/status`, { payment_status: 'paid', payment_method: 'cash' }, {}, MANAGER_BEARER)
  const ngL = await q('select amount_cents, method, origin, recorded_by from public.non_gateway_payment_events where $1 = any(order_ids)', [legacy.body?.order_id])
  ok('M1 Mark-as-Paid: one ledger row, server amount 2000, cash, staff_mark_paid, staff recorded', mp.status === 200 && ngL.length === 1 && ngL[0].amount_cents === 2000 && ngL[0].method === 'cash' && ngL[0].origin === 'staff_mark_paid' && !!ngL[0].recorded_by, `status=${mp.status} ${JSON.stringify(mp.body).slice(0, 160)} rows=${JSON.stringify(ngL)}`)
  const mp2 = await http('PATCH', `/api/orders/${legacy.body?.order_id}/status`, { payment_status: 'paid', payment_method: 'cash' }, {}, MANAGER_BEARER)
  const ngL2 = (await q('select count(*)::int n from public.non_gateway_payment_events where $1 = any(order_ids)', [legacy.body?.order_id]))[0].n
  ok('M2 replayed Mark-as-Paid: 409, still exactly one ledger row', mp2.status === 409 && ngL2 === 1, `status=${mp2.status} rows=${ngL2}`)
  const cancelPaid = await http('PATCH', `/api/orders/${legacy.body?.order_id}/status`, { status: 'cancelled' }, {}, MANAGER_BEARER)
  const lAfter = await orderRow(legacy.body?.order_id)
  ok('M3 cancelling the paid order: refused, payment_status still paid', cancelPaid.status === 409 && lAfter?.payment_status === 'paid', `status=${cancelPaid.status} code=${cancelPaid.body?.code} ps=${lAfter?.payment_status}`)
  try {
    await client.query('BEGIN')
    await client.query('update public.non_gateway_payment_events set amount_cents = amount_cents + 1 where $1 = any(order_ids)', [legacy.body?.order_id])
    await client.query('ROLLBACK')
    ok('M4 ledger row is immutable (UPDATE refused)', false, 'update succeeded')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    ok('M4 ledger row is immutable (UPDATE refused)', true)
  }

  // ---- R: staff reconcile ----------------------------------------------------------------------
  const rUnbound = await http('POST', '/api/payments/reconcile', { restaurantId: VENUE, orderIds: [A.body?.order_id], merchantOrderNo: MARKER + '-UNBOUND' }, {}, MANAGER_BEARER)
  ok('R1 reference not bound to these orders: refused, nothing paid', rUnbound.status >= 400 && rUnbound.status < 500 && (await orderRow(A.body?.order_id))?.payment_status !== 'paid', `status=${rUnbound.status} code=${rUnbound.body?.code}`)
  const rAnon = await http('POST', '/api/payments/reconcile', { restaurantId: VENUE, orderIds: [A.body?.order_id], merchantOrderNo: MARKER }, {}, '')
  ok('R2 unauthenticated reconcile refused', rAnon.status === 401 || rAnon.status === 403, `status=${rAnon.status}`)

  // ---- S: anon over PostgREST ------------------------------------------------------------------
  const rpc = async (fn, args) => {
    const r = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'content-type': 'application/json' }, body: JSON.stringify(args) })
    return { status: r.status, text: (await r.text()).slice(0, 160) }
  }
  const zero = '00000000-0000-0000-0000-000000000000'
  const s1 = await rpc('amend_order_lines', { p_restaurant_id: zero, p_tab_id: zero, p_order_number: 1, p_actor_kind: 'x', p_actor_user_id: zero, p_amendments: [] })
  const s2 = await rpc('settle_order_line_allocations', { p_restaurant_id: zero, p_tab_id: zero, p_allocation_ids: [], p_method: 'cash', p_payment_reference: 'x', p_staff_user_id: zero })
  const s3 = await rpc('order_is_fully_paid_by_allocations', { p_order_id: zero })
  const s4 = await rpc('correct_invoice', { p_original_invoice_id: zero, p_corrected_line_items: [], p_reason: 'x', p_created_by: zero })
  const denied = (r) => r.status === 401 || r.status === 403 || /permission denied|42501/.test(r.text)
  ok('S1 anon cannot call amend_order_lines', denied(s1), JSON.stringify(s1))
  ok('S2 anon cannot call settle_order_line_allocations', denied(s2), JSON.stringify(s2))
  ok('S3 anon cannot call order_is_fully_paid_by_allocations', denied(s3), JSON.stringify(s3))
  ok('S4 anon cannot call correct_invoice', denied(s4), JSON.stringify(s4))
  const ctl = await rpc('user_restaurant_ids', {})
  ok('S5 CONTROL: an RLS helper anon IS allowed to call answers 200', ctl.status === 200, JSON.stringify(ctl))
} finally {
  console.log('\nTEARDOWN')
  const del = async (label, sql, params) => {
    const r = await client.query(sql, params).catch((e) => ({ rowCount: 'ERR ' + String(e.message).slice(0, 80) }))
    console.log(`  ${label}: ${r.rowCount}`)
  }
  if (made.tab) {
    const orderIds = (await q('select id from public.orders where tab_id = $1', [made.tab])).map((r) => r.id)
    await del('document_payments', 'delete from public.document_payments where document_id = any($1::uuid[])', [made.docs])
    await del('business_documents', 'delete from public.business_documents where id = any($1::uuid[])', [made.docs])
    await del('terminal_payment_intents', 'delete from public.terminal_payment_intents where tab_id = $1', [made.tab])
    await del('order_line_events', 'delete from public.order_line_events where order_line_id in (select id from public.order_lines where tab_id = $1)', [made.tab])
    await del('order_lines', 'delete from public.order_lines where tab_id = $1', [made.tab])
    // The non-gateway ledger is immutable BY DESIGN; test rows are removed by disabling its user
    // triggers for this one statement, in a transaction, and re-enabling them.
    await client.query('BEGIN')
    await client.query('ALTER TABLE public.non_gateway_payment_events DISABLE TRIGGER USER')
    await del('non_gateway_payment_events', 'delete from public.non_gateway_payment_events where order_ids && $1::uuid[]', [orderIds])
    await client.query('ALTER TABLE public.non_gateway_payment_events ENABLE TRIGGER USER')
    await client.query('COMMIT')
    await del('payments', 'delete from public.payments where tab_id = $1', [made.tab])
    await del('receipt_documents', 'delete from public.receipt_documents where order_id = any($1::uuid[])', [orderIds])
    await del('payment_events', 'delete from public.payment_events where order_ids && $1::uuid[]', [orderIds])
    await del('audit_logs', 'delete from public.audit_logs where entity_id = any($1::text[])', [[made.tab, ...orderIds, ...made.docs]])
    await del('orders', 'delete from public.orders where tab_id = $1', [made.tab])
    await del('tabs', 'delete from public.tabs where id = $1', [made.tab])
  }
  await del('authorization_events', 'delete from public.authorization_events where token_id = any($1::uuid[])', [made.tokens])
  await del('privileged_authorization_tokens', 'delete from public.privileged_authorization_tokens where id = any($1::uuid[])', [made.tokens])
  if (made.table) {
    await del('table_assignments', 'delete from public.service_table_assignments where table_id = $1', [made.table])
    await del('restaurant_tables', 'delete from public.restaurant_tables where id = $1', [made.table])
  }
  if (made.terminal) await del('restaurant_terminals', 'delete from public.restaurant_terminals where id = $1', [made.terminal])
  await del('menu_items', 'delete from public.menu_items where id = any($1::uuid[])', [Object.values(made.items)])
  await del('menu_categories', 'delete from public.menu_categories where id = $1', [made.category])
  if (made.featureWasOff) await del('restaurant_features (restored)', 'update public.restaurant_features set station_screens_enabled = false where restaurant_id = $1', [VENUE])
  const ngTrig = await q("select count(*)::int n from pg_trigger where tgrelid = 'public.non_gateway_payment_events'::regclass and not tgisinternal and tgenabled = 'D'")
  if (ngTrig[0].n > 0) { fail += 1; console.log('  FAIL  ledger immutability triggers left DISABLED') }
  await client.end()
}
console.log(`\nSTAGING HTTP PAYMENT PATHS: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
