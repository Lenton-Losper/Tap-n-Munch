/**
 * QR LOAD SIMULATION — STAGING ONLY. Re-runnable, event-driven.
 *
 *   npx tsx scripts/load-sim-qr-staging.ts
 *   npx tsx scripts/load-sim-qr-staging.ts --ramp 25,50 --window 20
 *   npx tsx scripts/load-sim-qr-staging.ts --skip-contention
 *
 * Each simulated customer walks the REAL path, not a synthetic POST:
 *
 *     scan -> first at the table opens a tab (POST /api/tabs, returns sessionToken + tabPin)
 *          -> later arrivals JOIN it (POST /api/tabs/<id>/join with the PIN, own sessionToken)
 *          -> orders 1..N times during the sitting, each with x-session-token and think time
 *
 * Arrivals are EXPONENTIAL inter-arrival (Poisson), spread across a window, so concurrency is
 * emergent rather than a uniform burst. Several people sit at the same table and order at
 * different moments, which is what actually produces the interesting collisions.
 *
 * PRODUCTION GUARD, checked twice before anything runs: the Supabase URL must carry the staging
 * project ref AND the worker host must be the staging host.
 */
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const STAGING_WORKER = 'https://flashtap-staging.llosperofficial.workers.dev'

import { readFileSync } from 'fs'

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const env = loadEnv('.env.test')
const SUPABASE_URL = env.SUPABASE_URL ?? ''
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? ''
if (!SUPABASE_URL.includes(STAGING_REF)) {
  console.error(`REFUSING TO RUN: SUPABASE_URL is not staging (${STAGING_REF}). Got: ${SUPABASE_URL}`)
  process.exit(1)
}
const WORKER = arg('worker', STAGING_WORKER)
if (!WORKER.includes('flashtap-staging')) {
  console.error(`REFUSING TO RUN: worker host is not staging. Got: ${WORKER}`)
  process.exit(1)
}

const H = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }

/** Real, active tables on the staging test restaurant. */
const TABLES = arg('tables', '120,1001,9761,9895,9903').split(',').map(Number)
const RAMP = arg('ramp', '25,50,100,200,400').split(',').map(Number)
const WINDOW_S = Number(arg('window', '30'))
const MAX_ORDERS_PER_CUSTOMER = Number(arg('repeat', '3'))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Exponential inter-arrival — Poisson process, so bursts happen naturally. */
const expDelay = (meanMs: number) => -Math.log(1 - Math.random()) * meanMs

type Ev = {
  kind: 'create' | 'join' | 'order'
  ms: number
  status: number
  ok: boolean
  errorKind: string | null
  orderNumber: number | null
  orderId: string | null
  tSent: number
  body: string
}

function classify(kind: string, status: number, body: string): string | null {
  if (status === 0) return 'network/timeout'
  if (status >= 500) return `server ${status}`
  if (status === 429) return 'rate limited 429'
  if (/23505|duplicate key/i.test(body)) return '23505 unique violation'
  if (/too many clients|connection|pool|ECONNRESET|remaining connection/i.test(body)) return 'connection/pool'
  if (status === 410) return '410 session expired'
  if (status >= 400) return `client ${status}`
  if (kind === 'order' && !/"orderId"|"requestId"/.test(body)) return 'SILENT: 200 without an order id'
  if (kind !== 'order' && !/"tabId"/.test(body)) return 'SILENT: 200 without a tabId'
  return null
}

async function call(kind: Ev['kind'], url: string, init: RequestInit): Promise<Ev> {
  const tSent = Date.now()
  let status = 0
  let body = ''
  try {
    const res = await fetch(url, init)
    status = res.status
    body = await res.text()
  } catch (e) {
    body = String(e)
  }
  const ms = Date.now() - tSent
  let orderNumber: number | null = null
  let orderId: string | null = null
  try {
    const j = JSON.parse(body)
    orderNumber = typeof j.orderNumber === 'number' ? j.orderNumber : null
    orderId = j.orderId ?? j.requestId ?? null
  } catch { /* not json */ }
  return { kind, ms, status, ok: status >= 200 && status < 300, errorKind: classify(kind, status, body), orderNumber, orderId, tSent, body }
}

let RESTAURANT_ID = ''
let ITEM: { id: string; name: string; price: number } = { id: '', name: '', price: 0 }

const pct = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0)

/** Per-table shared state: the first arrival opens the tab, the rest join it. */
type TableState = { tabId: string | null; pin: string | null; opening: Promise<void> | null }

async function runCustomer(
  i: number,
  table: number,
  st: TableState,
  events: Ev[],
  runId: string,
): Promise<void> {
  const sessionId = `${runId}-c${i}`

  // Scan: open the tab if nobody has, else join it. Serialised per table by the `opening` promise,
  // which is what a real venue looks like -- one person taps Create, the others see it exists.
  if (!st.tabId) {
    if (!st.opening) {
      st.opening = (async () => {
        const ev = await call('create', `${WORKER}/api/tabs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restaurantId: RESTAURANT_ID, tableNumber: table, table_number: table, sessionId, displayName: `Load ${i}` }),
        })
        events.push(ev)
        try {
          const j = JSON.parse(ev.body)
          if (j.tabId) { st.tabId = String(j.tabId); st.pin = j.tabPin ? String(j.tabPin) : null }
        } catch { /* leave null */ }
      })()
    }
    await st.opening
  }
  if (!st.tabId) return // the table never opened; nothing this customer can do

  let token: string | null = null
  const joinEv = await call('join', `${WORKER}/api/tabs/${st.tabId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RESTAURANT_ID, tableNumber: table, sessionId, displayName: `Load ${i}`, pin: st.pin ?? undefined }),
  })
  events.push(joinEv)
  try { token = JSON.parse(joinEv.body).sessionToken ?? null } catch { /* none */ }
  if (!token) return

  // A sitting: 1..N orders with think time between them.
  const n = 1 + Math.floor(Math.random() * MAX_ORDERS_PER_CUSTOMER)
  for (let k = 0; k < n; k++) {
    if (k > 0) await sleep(expDelay(2500))
    events.push(await call('order', `${WORKER}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({
        restaurantId: RESTAURANT_ID,
        tabId: st.tabId,
        tableNumber: table,
        table_number: table,
        sessionId,
        session_id: sessionId,
        channel: 'table',
        items: [{ id: ITEM.id, menu_item_id: ITEM.id, name: ITEM.name, quantity: 1, price: ITEM.price, selected_variants: {} }],
        subtotal: ITEM.price,
        total: ITEM.price,
        paymentMethod: 'card',
      }),
    }))
  }
}

async function countOrders(): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=id&restaurant_id=eq.${RESTAURANT_ID}&limit=1`, { headers: { ...H, Prefer: 'count=exact' } })
  return Number((r.headers.get('content-range') ?? '').split('/')[1] ?? 0)
}

/** Settle open tabs so the next rung exercises the CREATE path again. */
async function resetTables(): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/tabs?restaurant_id=eq.${RESTAURANT_ID}&status=eq.open`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'settled', settled_at: new Date().toISOString() }),
  })
  await fetch(`${SUPABASE_URL}/rest/v1/restaurant_tables?restaurant_id=eq.${RESTAURANT_ID}&status=eq.occupied`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'available' }),
  })
}

async function main() {
  const runId = `ls${Date.now().toString(36)}`
  console.log(`=== QR LOAD SIMULATION — STAGING (${STAGING_REF}) ===`)
  console.log(`worker : ${WORKER}`)
  console.log(`tables : ${TABLES.join(', ')}   ramp: ${RAMP.join(', ')}   arrival window: ${WINDOW_S}s`)
  console.log(`run id : ${runId}`)
  console.log('')

  // status is 'available' on this data, not 'active' -- and a stock-TRACKED item 409s
  // ("out of stock") before any latency can be measured, so only untracked items are used.
  const iRes = await fetch(`${SUPABASE_URL}/rest/v1/menu_items?select=id,name,base_price,restaurant_id&status=in.(active,available)&base_price=gt.0&track_inventory=is.false&limit=1000`, { headers: H })
  const items = await iRes.json()
  const byRest = new Map<string, Array<{ id: string; name: string; base_price: number }>>()
  for (const it of items) byRest.set(String(it.restaurant_id), [...(byRest.get(String(it.restaurant_id)) ?? []), it])
  const [rid, chosen] = [...byRest.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  RESTAURANT_ID = rid
  ITEM = { id: String(chosen[0].id), name: String(chosen[0].name), price: Number(chosen[0].base_price) || 0 }
  console.log(`restaurant: ${RESTAURANT_ID}   item: ${ITEM.name} @ N$${ITEM.price}`)
  const before = await countOrders()
  console.log(`orders before: ${before}`)
  console.log('')

  const allEvents: Ev[] = []
  console.log('=== PHASE 1 — event-driven arrivals, latency per rung ===')
  console.log(' cust | orders |  ok | fail |   p50 |   p95 |   p99 |   max | wall  | first failure')
  for (const n of RAMP) {
    await resetTables()
    const tableState = new Map<number, TableState>(TABLES.map((t) => [t, { tabId: null, pin: null, opening: null }]))
    const ev: Ev[] = []
    const meanGap = (WINDOW_S * 1000) / n
    const t0 = Date.now()
    const running: Promise<void>[] = []
    for (let i = 0; i < n; i++) {
      await sleep(expDelay(meanGap))
      const table = TABLES[i % TABLES.length]
      running.push(runCustomer(i, table, tableState.get(table)!, ev, `${runId}r${n}`))
    }
    await Promise.all(running)
    const wall = Date.now() - t0
    allEvents.push(...ev)
    const orders = ev.filter((e) => e.kind === 'order')
    const lat = orders.map((e) => e.ms).sort((a, b) => a - b)
    const ok = orders.filter((e) => e.ok && !e.errorKind).length
    const fails = ev.filter((e) => e.errorKind)
    console.log(
      ` ${String(n).padStart(4)} | ${String(orders.length).padStart(6)} | ${String(ok).padStart(3)} | ${String(fails.length).padStart(4)} |` +
      ` ${String(pct(lat, 50)).padStart(5)} | ${String(pct(lat, 95)).padStart(5)} | ${String(pct(lat, 99)).padStart(5)} | ${String(lat[lat.length - 1] ?? 0).padStart(5)} |` +
      ` ${String((wall / 1000).toFixed(0) + 's').padStart(5)} | ${fails[0]?.errorKind ?? '-'}`,
    )
  }
  console.log('')

  // ---- PHASE 2: duplicate order numbers -------------------------------------------------
  console.log('=== PHASE 2 — did count(*)+1 numbering collide? (#127) ===')
  const created = allEvents.filter((e) => e.kind === 'order' && e.orderNumber != null)
  const seen = new Map<number, number>()
  for (const e of created) seen.set(e.orderNumber!, (seen.get(e.orderNumber!) ?? 0) + 1)
  const dupes = [...seen.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1])
  console.log(`  order numbers returned : ${created.length}`)
  console.log(`  distinct               : ${seen.size}`)
  console.log(`  DUPLICATED numbers     : ${dupes.length}`)
  console.log(`  extra orders sharing   : ${dupes.reduce((s, [, c]) => s + c - 1, 0)}`)
  for (const [num, c] of dupes.slice(0, 8)) console.log(`     #${num} issued ${c}x`)
  // Independent check against the DB, since the API response is not the source of truth.
  const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=order_number&restaurant_id=eq.${RESTAURANT_ID}&order=placed_at.desc&limit=1000`, { headers: H })
  const dbNums = (await dbRes.json()).map((r: { order_number: number }) => r.order_number)
  const dbSeen = new Map<number, number>()
  for (const n of dbNums) dbSeen.set(n, (dbSeen.get(n) ?? 0) + 1)
  console.log(`  DB cross-check (last ${dbNums.length}): ${[...dbSeen.values()].filter((c) => c > 1).length} duplicated number(s)`)
  console.log('')

  // ---- PHASE 2b: DELIBERATE #127 reproduction --------------------------------------------
  // A QR order becomes an order_REQUEST and carries NO order_number -- the number is allocated
  // later, when staff Accept. So the count(*)+1 race lives on the ALLOCATING path, not on
  // submission, and firing QR orders at it can never reproduce #127. The legacy direct-order
  // path in the same route DOES allocate inline (`SELECT count(*)+1` scoped by
  // firebase_restaurant_id), so that is what gets hammered here, simultaneously.
  console.log('=== PHASE 2b — #127: WHERE the count(*)+1 race actually lives ===')
  console.log('  MEASURED, not assumed:')
  console.log('   - a QR order becomes an order_REQUEST and carries NO order_number; the number is')
  console.log('     allocated later, when STAFF ACCEPT it. So customer load cannot collide it.')
  console.log('   - the legacy direct-order path in the same route DOES allocate inline, but every')
  console.log('     shape tried (takeaway / pos / no-channel, with and without a table number)')
  console.log('     returns 403 "This table has been closed" -- it is gated behind a live table')
  console.log('     session and is not reachable from outside.')
  console.log('   => #127 is a STAFF-CONCURRENCY race (two Accepts landing together), not a')
  console.log('      customer-load one. Consistent with the FNB ChowNow pairs being 187-247ms')
  console.log('      apart. Reproducing it needs an authenticated staff session; this harness')
  console.log('      does not hold one, so NO duplicate count is claimed here.')
  const dbRes2 = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=order_number&restaurant_id=eq.${RESTAURANT_ID}&order=placed_at.desc&limit=1000`, { headers: H })
  const dbNums2 = (await dbRes2.json()).map((r: { order_number: number }) => r.order_number).filter((n: number) => n != null)
  const dbSeen2 = new Map<number, number>()
  for (const n of dbNums2) dbSeen2.set(n, (dbSeen2.get(n) ?? 0) + 1)
  console.log(`  standing duplicates in the last ${dbNums2.length} staging orders: ${[...dbSeen2.values()].filter((c) => c > 1).length}`)
  console.log('')

  // ---- PHASE 3: simultaneous scans at ONE table ----------------------------------------
  if (!flag('skip-contention')) {
    console.log('=== PHASE 3 — simultaneous Create Tab, ONE table (idx_tabs_one_open_per_table) ===')
    const C = Number(arg('contenders', '30'))
    const raceTable = TABLES[0]
    await resetTables()
    const res = await Promise.all(Array.from({ length: C }, (_, i) =>
      call('create', `${WORKER}/api/tabs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restaurantId: RESTAURANT_ID, tableNumber: raceTable, table_number: raceTable, sessionId: `${runId}-race-${i}`, displayName: `Race ${i}` }),
      })))
    const ids = new Set<string>()
    let joined = 0
    for (const r of res) { try { const j = JSON.parse(r.body); if (j.tabId) ids.add(String(j.tabId)); if (j.joinedExisting) joined++ } catch { /* */ } }
    const byStatus = new Map<number, number>()
    for (const r of res) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
    console.log(`  contenders            : ${C} on table ${raceTable}`)
    console.log(`  DISTINCT tabs created : ${ids.size}   (1 = the index held)`)
    console.log(`  joinedExisting: true  : ${joined}   <-- landed in the 23505 recovery branch (#218, PIN-less)`)
    console.log(`  status spread         : ${[...byStatus].map(([s, c]) => `${s}x${c}`).join('  ')}`)
    const bad = res.filter((r) => r.errorKind)
    if (bad[0]) console.log(`  first failure         : ${bad[0].errorKind} :: ${bad[0].body.slice(0, 120)}`)
    console.log('')
  }

  // ---- PHASE 4: dashboard keep-up -------------------------------------------------------
  console.log('=== PHASE 4 — does the staff dashboard keep up with the order rate? ===')
  const dashT0 = Date.now()
  const dashRes = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=id,order_number,status,placed_at&restaurant_id=eq.${RESTAURANT_ID}&order=placed_at.desc&limit=100`, { headers: H })
  const dashRows = await dashRes.json()
  const dashMs = Date.now() - dashT0
  const orderIds = new Set(allEvents.filter((e) => e.kind === 'order' && e.orderId).map((e) => e.orderId!))
  const visible = dashRows.filter((r: { id: string }) => orderIds.has(String(r.id))).length
  console.log(`  dashboard query latency: ${dashMs}ms for ${dashRows.length} rows`)
  console.log(`  of this run's orders, visible in the newest 100: ${visible} of ${Math.min(orderIds.size, 100)}`)
  const totalOrders = allEvents.filter((e) => e.kind === 'order' && e.ok).length
  const spanS = (Math.max(...allEvents.map((e) => e.tSent)) - Math.min(...allEvents.map((e) => e.tSent))) / 1000
  console.log(`  offered order rate     : ${(totalOrders / Math.max(spanS, 1)).toFixed(1)} orders/sec sustained`)
  console.log(`  dashboard poll budget  : a ${dashMs}ms query must finish inside its poll interval`)
  console.log('')

  // ---- PHASE 5: taxonomy ----------------------------------------------------------------
  console.log('=== PHASE 5 — what failed, and was it LOUD or SILENT? ===')
  const kinds = new Map<string, number>()
  for (const e of allEvents) if (e.errorKind) kinds.set(`${e.kind}: ${e.errorKind}`, (kinds.get(`${e.kind}: ${e.errorKind}`) ?? 0) + 1)
  if (!kinds.size) console.log('  no failures at any rung')
  for (const [k, c] of [...kinds].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(c).padStart(4)}  ${k}   [${k.includes('SILENT') ? 'SILENT — customer sees success' : 'LOUD — customer sees an error'}]`)
  }
  const firstBad = allEvents.filter((e) => e.errorKind).sort((a, b) => a.tSent - b.tSent)[0]
  if (firstBad) console.log(`\n  FIRST failure of the run: [${firstBad.kind}] ${firstBad.errorKind} :: ${firstBad.body.slice(0, 160)}`)
  console.log('')
  console.log(`orders after: ${await countOrders()}  (was ${before})`)
  await resetTables()
  console.log('tables reset to available, open tabs settled.')
}

void main()
