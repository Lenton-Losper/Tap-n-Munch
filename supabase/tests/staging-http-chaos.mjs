#!/usr/bin/env node
/**
 * STAGING HTTP CHAOS TAB -- the local chaos scenario (supabase/tests/chaos-e2e.mjs), replayed over
 * real HTTP against the deployed STAGING worker, on the 'staging test' venue.
 *
 *   node supabase/tests/staging-http-chaos.mjs --dry-run     validate config + guards, no network
 *   node supabase/tests/staging-http-chaos.mjs               run it (staging phase only)
 *
 * Optional: STAGING_MANAGER_BEARER=<a staging Supabase access token for a venue manager> enables
 * the invoice step. Without it the invoice step is reported SKIPPED, never passed.
 *
 * NEVER PRODUCTION. Three independent refusals, each sufficient on its own:
 *   1. the base URL must be the staging worker (or a loopback dev server) -- an allowlist, not a
 *      denylist, so a new production hostname is refused without anyone remembering to add it;
 *   2. the production project ref ihlmmpmolnpchzgwyhgh anywhere in the base URL or the env file
 *      path aborts before anything is sent;
 *   3. connectStaging() (staging-db.mjs) refuses a production connection and aborts unless the
 *      database holds the 'staging test' venue.
 *
 * WHAT DIFFERS FROM THE LOCAL RUN. There is no card leg: staging's gateway is real, so the final
 * balance is settled in CASH through the tab settle route. The card path to settle_order_payment
 * is covered by the local harness only. The double-tap in S13 is two concurrent HTTP requests with
 * no barrier, so it may not interleave; it still proves "exactly one claim". Manager PIN
 * authorizations are minted as rows, as app/api/terminal/authorize writes them.
 *
 * EVERYTHING IT CREATES carries MARKER and is deleted in `finally`: menu items and category,
 * table, terminal, tab, orders, lines, events, allocations, settlements, payments, tokens, audit
 * rows, the invoice (if made). If the venue's station_screens_enabled was off, it is switched on
 * for the run and restored.
 */
import { randomUUID } from 'node:crypto'

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_HOST = 'flashtap-staging.llosperofficial.workers.dev'
const BASE = (process.env.STAGING_BASE ?? `https://${STAGING_HOST}`).replace(/\/+$/, '')
const VENUE = 'a1999166-ddfa-40d1-ad1f-2f01282a1652' // the "staging test" restaurant
const MARKER = 'HTTPCHAOS-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const DRY = process.argv.includes('--dry-run')

/** The allowlist. Exported shape is tested by --dry-run below. */
export function baseRefusal(base, envFile = process.env.FLASHTAP_ENV_FILE ?? '') {
  if (String(base).includes(PROD_REF) || String(envFile).includes(PROD_REF)) return 'names the production project ref'
  let url
  try {
    url = new URL(base)
  } catch {
    return 'not a URL'
  }
  if (url.hostname === STAGING_HOST && url.protocol === 'https:') return null
  if ((url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.protocol === 'http:') return null
  return `host ${url.hostname} is not the staging worker`
}

function selfTestGuards() {
  const cases = [
    [`https://${STAGING_HOST}`, true],
    ['http://127.0.0.1:3000', true],
    ['https://flashtap.app', false],
    ['https://www.flashtap.app', false],
    ['https://riviera.flashtap.app', false],
    ['https://flashtap.llosperofficial.workers.dev', false],
    [`https://${PROD_REF}.supabase.co`, false],
    [`https://${STAGING_HOST}.evil.example`, false],
    [`http://${STAGING_HOST}`, false],
    [`https://${STAGING_HOST}/?x=${PROD_REF}`, false],
  ]
  let bad = 0
  for (const [base, allowed] of cases) {
    const refused = baseRefusal(base, '')
    const okay = allowed ? refused === null : refused !== null
    if (!okay) bad += 1
    console.log(`  ${okay ? 'PASS' : 'FAIL'}  guard ${allowed ? 'allows' : 'refuses'} ${base}${refused ? ` (${refused})` : ''}`)
  }
  return bad
}

const refusal = baseRefusal(BASE)
if (refusal) {
  console.error(`REFUSING: ${BASE} -- ${refusal}`)
  process.exit(2)
}

const ITEMS = [
  // key, name, station, base price, variant groups
  ['pasta', 'Modena Pasta', 'kitchen', 120, [{ name: 'Size', required: true, type: 'price', options: [{ label: 'Regular', price: 120 }, { label: 'Large', price: 155 }] }, { name: 'Sauce', required: false, type: 'text', options: ['Tomato', 'Cream'] }]],
  ['ribeye', 'Ribeye', 'kitchen', 245, [{ name: 'Doneness', required: true, type: 'text', options: ['Rare', 'Medium', 'Well done'] }]],
  ['burger', 'Burger', 'kitchen', 98.5, []],
  ['chips', 'Chips', 'kitchen', 35, []],
  ['salad', 'Caesar Salad', 'kitchen', 72, []],
  ['cheesecake', 'Cheesecake', 'kitchen', 55, []],
  ['lager', 'Lager', 'bar', 32, []],
  ['wine', 'House Wine', 'bar', 45, [{ name: 'Glass', required: true, type: 'price', options: [{ label: 'Small', price: 45 }, { label: 'Large', price: 68 }] }]],
  ['espresso', 'Espresso', 'bar', 26, []],
]
const priceCents = (key, v = {}) => {
  const base = { pasta: v.Size === 'Large' ? 15500 : 12000, ribeye: 24500, burger: 9850, chips: 3500, salad: 7200, cheesecake: 5500, lager: 3200, wine: v.Glass === 'Large' ? 6800 : 4500, espresso: 2600 }
  return base[key]
}

const PLAN = [
  'S01 open the tab over HTTP (terminal activated over HTTP)',
  'S02 first round: 5 lines, variants, notes, server prices (789.00)',
  'S03 pay 406.00 by item (allocate + settle-allocations cash)',
  'S04 replay the item payment: 409, no second settlement',
  'S05 rounds 2-4 (10 items); kitchen cooks round 1 ribeye',
  'S06 void three items: voided on the server',
  'S07 add four, void two, add them again',
  'S08 reduce two quantities (replacement order)',
  'S09 void the cooked ribeye: refused window_closed',
  'S10 timed-out round K7 replayed: duplicate, one order',
  'S11 K7 replayed with an edited basket: 409 IDEMPOTENCY_KEY_BODY_MISMATCH',
  'S12 new key K8 + K9 while earlier rounds pending',
  'S13 double-tapped cash settle of two orders: one claim, one payments row',
  'S14 void on a paid order (order_paid), a paid-by-item line (line_settled), cancel a paid order: all refused',
  'S15 settle the remaining balance in cash',
  'S16 replay rounds/amend/settle/settle-allocations: nothing moves',
  'S17 invoice for the tab (needs STAGING_MANAGER_BEARER; else SKIPPED)',
  'S18 final: lines route, tables route and the money tables agree to the cent',
]

if (DRY) {
  console.log(`DRY RUN -- nothing is sent.\n  base   ${BASE}\n  venue  ${VENUE}\n  marker ${MARKER}\n`)
  const bad = selfTestGuards()
  console.log('\nplan:')
  for (const p of PLAN) console.log('  ' + p)
  console.log(`\nguards: ${bad === 0 ? 'all correct' : bad + ' WRONG'}`)
  process.exit(bad === 0 ? 0 : 1)
}

const { connectStaging } = await import('./staging-db.mjs')

let pass = 0
let fail = 0
let skipped = 0
const ok = (n, c, d) => {
  if (c) {
    pass += 1
    console.log('  PASS  ' + n)
  } else {
    fail += 1
    console.log('  FAIL  ' + n + (d ? ' -- ' + d : ''))
  }
}

const client = await connectStaging()
const q = async (sql, params = []) => (await client.query(sql, params)).rows
const made = { category: null, items: {}, table: null, terminal: null, tab: null, tokens: [], invoice: null, featureWasOff: false }
let token = ''

async function http(method, path, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await r.json() } catch { json = null }
  return { status: r.status, body: json }
}

async function mint(purpose, userId) {
  const id = randomUUID()
  await q(
    `insert into public.privileged_authorization_tokens (id,user_id,restaurant_id,terminal_id,purpose,nonce,ttl_seconds,expires_at)
     values ($1,$2,$3,$4,$5,$6,90, now() + interval '90 seconds')`,
    [id, userId, VENUE, made.terminal, purpose, randomUUID()],
  )
  made.tokens.push(id)
  return id
}

const lines = [] // { id, order_id, key, qty, note, v, total, state }
const rounds = {}
let paid = 0
const live = () => lines.filter((l) => l.state === 'live').reduce((s, l) => s + l.total, 0)

async function round(key, wants, label) {
  const items = wants.map((w) => ({
    menuItemId: made.items[w.key], name: w.key, quantity: w.qty,
    ...(w.note ? { note: w.note } : {}), ...(w.v ? { selectedVariants: w.v } : {}), price: 1, unitPrice: 1,
  }))
  const res = await http('POST', '/api/terminal/rounds', { tab_id: made.tab, items, subtotal: 1, total: 1 }, {
    'x-idempotency-key': `${MARKER}-${key}`, 'x-flashtap-variant-protocol': '1',
  })
  if (label && res.status === 200 && !res.body.duplicate) {
    const rows = await q('select id, source_item_index from public.order_lines where order_id = $1 order by source_item_index', [res.body.order_id])
    rows.forEach((r, i) => lines.push({ id: r.id, order_id: res.body.order_id, key: wants[i].key, qty: wants[i].qty, note: wants[i].note ?? null, v: wants[i].v ?? {}, total: priceCents(wants[i].key, wants[i].v) * wants[i].qty, state: 'live' }))
    rounds[label] = res.body.order_id
  }
  return res
}
const line = (key, label) => lines.find((l) => l.key === key && l.order_id === rounds[label])
async function voidLines(targets, reason, userId) {
  return http('POST', `/api/terminal/tabs/${made.tab}/amend`, {
    amendments: targets.map((l) => ({ line_id: l.id, new_quantity: 0 })),
    staff_user_id: userId, authorization_token_id: await mint('line_void', userId), void_reason: reason,
  })
}
async function tabFinancials() {
  const r = await http('GET', `/api/terminal/tabs/${made.tab}/lines`)
  return r.body?.financials
}
async function ledger() {
  const [a] = await q('select coalesce(sum(amount_cents),0)::int c from public.order_line_allocation_settlements where tab_id = $1', [made.tab])
  const [p] = await q("select coalesce(sum(round(amount*100)),0)::int c from public.payments where tab_id = $1 and status = 'completed'", [made.tab])
  return a.c + p.c
}
async function figures(label) {
  const f = await tabFinancials()
  ok(`${label}: lines route live/paid/outstanding = oracle`,
    f && f.tab.live_cents === live() && f.tab.paid_cents === paid && f.tab.outstanding_cents === live() - paid,
    JSON.stringify(f?.tab) + ` oracle live=${live()} paid=${paid}`)
  const t = await http('GET', '/api/terminal/tables')
  const row = (t.body?.tables ?? []).find((x) => x.id === made.table)
  if (row?.tab) ok(`${label}: tables unpaid_total = outstanding`, Math.round(Number(row.tab.unpaid_total) * 100) === live() - paid, `unpaid=${row.tab.unpaid_total}`)
  ok(`${label}: money tables = paid`, (await ledger()) === paid, `ledger=${await ledger()} paid=${paid}`)
}

try {
  // ---- fixture -----------------------------------------------------------------------------
  const [feature] = await q('select station_screens_enabled from public.restaurant_features where restaurant_id = $1', [VENUE])
  if (!feature?.station_screens_enabled) {
    made.featureWasOff = true
    await q('update public.restaurant_features set station_screens_enabled = true where restaurant_id = $1', [VENUE])
  }
  const [staff] = await q(
    "select user_id from public.restaurant_users where restaurant_id = $1 and deleted_at is null order by (role = 'owner') desc, (role = 'manager') desc limit 1",
    [VENUE],
  )
  if (!staff) throw new Error('the staging test venue has no staff member to authorize with')
  const MANAGER = staff.user_id

  made.category = randomUUID()
  await q("insert into public.menu_categories (id, restaurant_id, name, active, route_to) values ($1,$2,$3,true,'kitchen')", [made.category, VENUE, MARKER + ' kitchen'])
  const barCategory = randomUUID()
  made.barCategory = barCategory
  await q("insert into public.menu_categories (id, restaurant_id, name, active, route_to) values ($1,$2,$3,true,'bar')", [barCategory, VENUE, MARKER + ' bar'])
  for (const [key, name, station, price, groups] of ITEMS) {
    const id = randomUUID()
    await q("insert into public.menu_items (id, restaurant_id, category_id, name, base_price, status, variant_groups) values ($1,$2,$3,$4,$5,'active',$6::jsonb)",
      [id, VENUE, station === 'kitchen' ? made.category : barCategory, `${MARKER} ${name}`, price, JSON.stringify(groups)])
    made.items[key] = id
  }
  made.table = randomUUID()
  const tableNumber = 9000 + Math.floor(Math.random() * 900)
  await q("insert into public.restaurant_tables (id, restaurant_id, table_number, status, active) values ($1,$2,$3,'available',true)", [made.table, VENUE, tableNumber])
  made.terminal = randomUUID()
  const code = String(Math.floor(100000 + Math.random() * 899999))
  await q("insert into public.restaurant_terminals (id, restaurant_id, name, active, activation_code, activation_code_expires_at) values ($1,$2,$3,false,$4, now() + interval '1 hour')",
    [made.terminal, VENUE, MARKER + '-term', code])
  const act = await fetch(BASE + '/api/terminals/activate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceId: MARKER + '-dev', terminalSn: MARKER + '-sn' }),
  })
  const actBody = await act.json().catch(() => null)
  ok('CONTROL terminal activated over HTTP', act.status === 200 && !!actBody?.accessToken, `status=${act.status}`)
  token = actBody?.accessToken
  if (!token) throw new Error('no terminal token')

  // ---- S01 ---------------------------------------------------------------------------------
  const open = await http('POST', `/api/terminal/tables/${made.table}/open`, { user_id: MANAGER, authorization_token_id: await mint('service_session', MANAGER), customer_name: MARKER })
  made.tab = open.body?.tab?.id ?? null
  ok('S01 tab opened', open.status === 200 && !!made.tab, JSON.stringify(open.body).slice(0, 200))
  if (!made.tab) throw new Error('no tab')

  // ---- S02 ---------------------------------------------------------------------------------
  const r1 = [
    { key: 'pasta', qty: 2, note: 'one without parmesan', v: { Size: 'Large', Sauce: 'Cream' } },
    { key: 'ribeye', qty: 1, note: 'sauce on the side', v: { Doneness: 'Medium' } },
    { key: 'lager', qty: 3, note: 'ice cold' },
    { key: 'wine', qty: 1, v: { Glass: 'Large' } },
    { key: 'chips', qty: 2, note: 'extra salt' },
  ]
  const s2 = await round('K1', r1, 'R1')
  const [o1] = await q('select total from public.orders where id = $1', [s2.body?.order_id])
  ok('S02 round accepted, 5 lines, server-priced 789.00', s2.status === 200 && lines.length === 5 && Math.round(Number(o1?.total) * 100) === 78900, `status=${s2.status} total=${o1?.total}`)
  const notes = await q('select source_item_index, line_note from public.order_lines where order_id = $1 order by 1', [rounds.R1])
  ok('S02 notes on the right lines', JSON.stringify(notes.map((n) => n.line_note)) === JSON.stringify(r1.map((w) => w.note ?? null)))
  await figures('S02')

  // ---- S03 / S04 ---------------------------------------------------------------------------
  const allocIds = []
  for (const l of [line('pasta', 'R1'), line('lager', 'R1')]) {
    const a = await http('POST', `/api/terminal/tabs/${made.tab}/lines/${l.id}/allocate`, { shares: [{ allocated_to: 'Guest A', quantity_allocated: l.qty }] })
    allocIds.push(...(a.body?.allocations ?? []).map((x) => x.id))
  }
  const s3 = await http('POST', `/api/terminal/tabs/${made.tab}/settle-allocations`, { allocation_ids: allocIds, method: 'cash' })
  ok('S03 item payment of 406.00 applied', s3.status === 200 && (s3.body?.applied ?? []).reduce((s, x) => s + x.amount_cents, 0) === 40600, JSON.stringify(s3.body).slice(0, 200))
  if (s3.status === 200) paid += 40600
  await figures('S03')
  const s4 = await http('POST', `/api/terminal/tabs/${made.tab}/settle-allocations`, { allocation_ids: allocIds, method: 'cash' })
  ok('S04 replay refused NOTHING_SETTLED', s4.status === 409 && s4.body?.code === 'NOTHING_SETTLED', `status=${s4.status}`)
  await figures('S04')

  // ---- S05 ---------------------------------------------------------------------------------
  await round('K2', [{ key: 'burger', qty: 2, note: 'no onion' }, { key: 'salad', qty: 1, note: 'dressing on the side' }, { key: 'espresso', qty: 2, note: 'after mains' }, { key: 'wine', qty: 2, note: 'for the ladies', v: { Glass: 'Small' } }], 'R2')
  await round('K3', [{ key: 'pasta', qty: 1, note: 'kid portion, mild', v: { Size: 'Regular', Sauce: 'Tomato' } }, { key: 'ribeye', qty: 2, note: 'rare means rare', v: { Doneness: 'Rare' } }, { key: 'chips', qty: 1, note: 'well done' }], 'R3')
  await round('K4', [{ key: 'cheesecake', qty: 3, note: 'birthday candle on one' }, { key: 'lager', qty: 2 }, { key: 'espresso', qty: 1, note: 'double shot' }], 'R4')
  ok('S05 three more rounds, 15 lines', lines.length === 15, `lines=${lines.length}`)
  const cook = await http('POST', `/api/station/order-lines/${line('ribeye', 'R1').id}/state`, { station: 'kitchen', to_state: 'cooked' })
  ok('S05 kitchen cooked the ribeye', cook.status === 200, `status=${cook.status}`)
  await figures('S05')

  // ---- S06 - S09 -----------------------------------------------------------------------------
  const three = [line('salad', 'R2'), line('chips', 'R3'), line('lager', 'R4')]
  const s6 = await voidLines(three, 'guest changed their mind', MANAGER)
  const voidedRows = await q("select id from public.order_lines where id = any($1::uuid[]) and (kitchen_state = 'voided' or bar_state = 'voided')", [three.map((l) => l.id)])
  ok('S06 three voided on the server', s6.status === 200 && (s6.body?.applied ?? []).length === 3 && voidedRows.length === 3, JSON.stringify(s6.body).slice(0, 200))
  three.forEach((l) => (l.state = 'voided'))
  await figures('S06')

  await round('K5', [{ key: 'burger', qty: 1, note: 'medium-well' }, { key: 'cheesecake', qty: 1 }, { key: 'wine', qty: 1, note: 'no ice', v: { Glass: 'Small' } }, { key: 'salad', qty: 1, note: 'no croutons' }], 'R5')
  const two = [line('burger', 'R5'), line('wine', 'R5')]
  const s7 = await voidLines(two, 'wrong table', MANAGER)
  two.forEach((l) => (l.state = 'voided'))
  await round('K6', [{ key: 'burger', qty: 1, note: 'medium-well' }, { key: 'wine', qty: 1, note: 'no ice', v: { Glass: 'Small' } }], 'R6')
  ok('S07 add four, void two, re-add', s7.status === 200 && (s7.body?.applied ?? []).length === 2 && !!rounds.R6)
  await figures('S07')

  const rb = line('ribeye', 'R3')
  const ck = line('cheesecake', 'R4')
  const s8 = await http('POST', `/api/terminal/tabs/${made.tab}/amend`, {
    amendments: [{ line_id: rb.id, new_quantity: 1 }, { line_id: ck.id, new_quantity: 2 }],
    staff_user_id: MANAGER, authorization_token_id: await mint('line_void', MANAGER), void_reason: 'over-ordered',
  })
  const replaced = s8.body?.applied ?? []
  ok('S08 two quantities reduced via a replacement order', s8.status === 200 && replaced.length === 2 && replaced.every((a) => a.action === 'replaced'))
  if (replaced.length === 2) {
    rb.state = 'voided'
    ck.state = 'voided'
    lines.push({ ...rb, id: replaced[0].new_line_id, order_id: s8.body.order_id, qty: 1, total: 24500, state: 'live' })
    lines.push({ ...ck, id: replaced[1].new_line_id, order_id: s8.body.order_id, qty: 2, total: 11000, state: 'live' })
    rounds.AMEND = s8.body.order_id
  }
  await figures('S08')

  const s9 = await voidLines([line('ribeye', 'R1')], 'complaint', MANAGER)
  ok('S09 cooked item refused window_closed', s9.status === 200 && s9.body?.refused?.[0]?.reason === 'window_closed', JSON.stringify(s9.body?.refused))
  await figures('S09')

  // ---- S10 - S12 ---------------------------------------------------------------------------
  const r7 = [{ key: 'espresso', qty: 2, note: 'decaf' }, { key: 'chips', qty: 1, note: 'for the table' }]
  await round('K7', r7, 'R7')
  const again = await round('K7', r7)
  const k7 = await q('select count(*)::int n from public.orders where idempotency_key = $1', [`${MARKER}-K7`])
  ok('S10 timed-out round replay is a duplicate, one order', again.status === 200 && again.body?.duplicate === true && k7[0].n === 1)
  const edited = await round('K7', [{ key: 'espresso', qty: 3, note: 'decaf' }])
  ok('S11 edited replay 409 IDEMPOTENCY_KEY_BODY_MISMATCH', edited.status === 409 && edited.body?.code === 'IDEMPOTENCY_KEY_BODY_MISMATCH')
  await round('K8', [{ key: 'espresso', qty: 1, note: 'decaf' }], 'R8')
  await round('K9', [{ key: 'cheesecake', qty: 1, note: 'to share' }, { key: 'lager', qty: 1, note: 'no glass' }], 'R9')
  ok('S12 two more rounds while earlier ones pending', !!rounds.R8 && !!rounds.R9)
  await figures('S12')

  // ---- S13 / S14 ---------------------------------------------------------------------------
  const cashIds = [rounds.R2, rounds.R5]
  const fin = await tabFinancials()
  const cashCents = cashIds.reduce((s, id) => s + (fin?.orders?.[id]?.outstanding_cents ?? 0), 0)
  const tap = () => http('POST', `/api/terminal/tabs/${made.tab}/settle`, { order_ids: cashIds, method: 'cash', amount: cashCents / 100 })
  const taps = await Promise.all([tap(), tap()])
  const pay = await q('select count(*)::int n from public.payments where tab_id = $1', [made.tab])
  ok('S13 double tap: exactly one 200 and one payments row', taps.filter((t) => t.status === 200).length === 1 && pay[0].n === 1, JSON.stringify(taps.map((t) => [t.status, t.body?.code])))
  paid += cashCents
  await figures('S13')

  const s14a = await voidLines([line('burger', 'R2')], 'wrong', MANAGER)
  const s14b = await voidLines([line('pasta', 'R1')], 'salty', MANAGER)
  const s14c = await http('PATCH', `/api/terminal/orders/${rounds.R2}/status`, { status: 'cancelled', reason: MARKER })
  ok('S14 paid order line refused order_paid', s14a.body?.refused?.[0]?.reason === 'order_paid', JSON.stringify(s14a.body?.refused))
  ok('S14 paid-by-item line refused line_settled', s14b.body?.refused?.[0]?.reason === 'line_settled', JSON.stringify(s14b.body?.refused))
  ok('S14 paid order cannot be cancelled', s14c.status >= 400)
  await figures('S14')

  // ---- S15 / S16 ---------------------------------------------------------------------------
  const fin2 = await tabFinancials()
  const owing = Object.entries(fin2?.orders ?? {}).filter(([, o]) => o.outstanding_cents > 0).map(([id]) => id)
  const rest = owing.reduce((s, id) => s + fin2.orders[id].outstanding_cents, 0)
  const s15 = await http('POST', `/api/terminal/tabs/${made.tab}/settle`, { order_ids: owing, method: 'cash', amount: rest / 100 })
  ok('S15 remaining balance settled in cash', s15.status === 200 && rest === live() - paid, `status=${s15.status} rest=${rest} oracle=${live() - paid}`)
  if (s15.status === 200) paid += rest
  await figures('S15')

  const counts = async () => JSON.stringify(await q(
    `select (select count(*) from public.orders where tab_id = $1) o, (select count(*) from public.order_lines where tab_id = $1) l,
            (select count(*) from public.payments where tab_id = $1) p, (select count(*) from public.order_line_allocation_settlements where tab_id = $1) s`, [made.tab]))
  const before = await counts()
  await round('K1', r1)
  await voidLines([three[0]], 'replay', MANAGER)
  await http('POST', `/api/terminal/tabs/${made.tab}/settle-allocations`, { allocation_ids: allocIds, method: 'cash' })
  const rs = await tap()
  ok('S16 replayed cash settle refused ALREADY_PAID', rs.status === 409)
  ok('S16 nothing moved after replaying every request', (await counts()) === before, `${before} -> ${await counts()}`)
  await figures('S16')

  // ---- S17 ---------------------------------------------------------------------------------
  if (process.env.STAGING_MANAGER_BEARER) {
    const inv = await fetch(BASE + '/api/admin/documents/from-order', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.STAGING_MANAGER_BEARER },
      body: JSON.stringify({ tab_id: made.tab, restaurant_id: VENUE, bill_to: { name: MARKER } }),
    })
    const invBody = await inv.json().catch(() => null)
    made.invoice = invBody?.document?.id ?? null
    ok('S17 invoice created with total = live and balance 0', inv.status === 201 && Math.round(Number(invBody.document.total) * 100) === live() && Number(invBody.document.balance) === 0, `status=${inv.status}`)
  } else {
    skipped += 1
    console.log('  SKIP  S17 invoice -- set STAGING_MANAGER_BEARER to run it')
  }

  // ---- S18 ---------------------------------------------------------------------------------
  const final = await tabFinancials()
  ok('S18 outstanding 0, paid = live = money tables', final?.tab?.outstanding_cents === 0 && final.tab.paid_cents === live() && (await ledger()) === live(),
    JSON.stringify(final?.tab) + ` ledger=${await ledger()}`)
} finally {
  console.log('\nTEARDOWN')
  const del = async (label, sql, params) => {
    const r = await client.query(sql, params).catch((e) => ({ rowCount: 'ERR ' + String(e.message).slice(0, 80) }))
    console.log(`  ${label}: ${r.rowCount}`)
  }
  if (made.tab) {
    const orderIds = (await q('select id from public.orders where tab_id = $1', [made.tab])).map((r) => r.id)
    await del('document_payments', 'delete from public.document_payments where document_id in (select id from public.business_documents where tab_id = $1)', [made.tab])
    await del('business_documents', 'delete from public.business_documents where tab_id = $1', [made.tab])
    await del('terminal_payment_intents', 'delete from public.terminal_payment_intents where tab_id = $1', [made.tab])
    await del('payment_tips', 'delete from public.payment_tips where tab_id = $1', [made.tab])
    await del('order_line_allocation_settlements', 'delete from public.order_line_allocation_settlements where tab_id = $1', [made.tab])
    await del('order_line_allocations', 'delete from public.order_line_allocations where tab_id = $1', [made.tab])
    await del('order_line_events', 'delete from public.order_line_events where order_line_id in (select id from public.order_lines where tab_id = $1)', [made.tab])
    await del('order_lines', 'delete from public.order_lines where tab_id = $1', [made.tab])
    await del('payments', 'delete from public.payments where tab_id = $1', [made.tab])
    await del('receipt_documents', 'delete from public.receipt_documents where order_id = any($1::uuid[])', [orderIds])
    await del('payment_events', 'delete from public.payment_events where order_ids && $1::uuid[]', [orderIds])
    await del('audit_logs', "delete from public.audit_logs where entity_id = any($1::text[])", [[made.tab, ...orderIds]])
    await del('orders', 'delete from public.orders where tab_id = $1', [made.tab])
    await del('tabs', 'delete from public.tabs where id = $1', [made.tab])
    const [left] = await q('select (select count(*) from public.orders where tab_id = $1)::int + (select count(*) from public.tabs where id = $1)::int n', [made.tab])
    if (left.n > 0) { fail += 1; console.log(`  FAIL  teardown left ${left.n} order/tab rows for tab ${made.tab} -- delete by hand`) }
  }
  await del('authorization_events', 'delete from public.authorization_events where token_id = any($1::uuid[])', [made.tokens])
  await del('privileged_authorization_tokens', 'delete from public.privileged_authorization_tokens where id = any($1::uuid[])', [made.tokens])
  if (made.table) {
    await del('table_assignments', 'delete from public.service_table_assignments where table_id = $1', [made.table])
    await del('restaurant_tables', 'delete from public.restaurant_tables where id = $1', [made.table])
  }
  if (made.terminal) await del('restaurant_terminals', 'delete from public.restaurant_terminals where id = $1', [made.terminal])
  await del('menu_items', 'delete from public.menu_items where id = any($1::uuid[])', [Object.values(made.items)])
  await del('menu_categories', 'delete from public.menu_categories where id = any($1::uuid[])', [[made.category, made.barCategory].filter(Boolean)])
  if (made.featureWasOff) await del('restaurant_features (restored)', 'update public.restaurant_features set station_screens_enabled = false where restaurant_id = $1', [VENUE])
  await client.end()
}
console.log(`\nSTAGING HTTP CHAOS: ${pass} passed, ${fail} failed, ${skipped} skipped`)
process.exit(fail === 0 ? 0 : 1)
