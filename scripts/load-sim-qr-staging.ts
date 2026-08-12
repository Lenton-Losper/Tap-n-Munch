/**
 * QR LOAD SIMULATION — STAGING ONLY. Re-runnable.
 *
 *   npx tsx scripts/load-sim-qr-staging.ts                  # default 400 customers
 *   npx tsx scripts/load-sim-qr-staging.ts --customers 100  # scaled
 *   npx tsx scripts/load-sim-qr-staging.ts --tables 8 --ramp 25,50,100,200,400
 *
 * WHY THIS EXISTS. Riviera trial-runs the full QR flow and nobody has measured how it behaves
 * under load. This measures rather than guesses:
 *
 *   1. order submission latency as concurrency climbs (p50/p95/p99/max, per rung)
 *   2. whether count(*)+1 order numbering produces DUPLICATES under real concurrency (#127)
 *   3. the one-open-tab-per-table unique index under simultaneous scans of the SAME table --
 *      how many hit 23505 and where those callers land
 *   4. error taxonomy: what fails FIRST, and whether it fails loudly (4xx/5xx) or SILENTLY
 *      (200 with a wrong or empty body)
 *
 * PRODUCTION GUARD. Refuses to run against anything but the staging ref. Checked twice: the
 * Supabase URL must carry the staging project ref, and the worker host must be the staging host.
 */
const STAGING_REF = "mdqjpxwczrhkxkbqatqa"
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

const TOTAL = Number(arg('customers', '400'))
const TABLES = Number(arg('tables', '8'))
const RAMP = arg('ramp', '25,50,100,200,400').split(',').map(Number).filter((n) => n > 0 && n <= TOTAL)

type Outcome = {
  ms: number
  status: number
  ok: boolean
  orderNumber: number | null
  orderId: string | null
  errorKind: string | null
  bodySnippet: string
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

/** Classify a response so "failed loudly" and "failed silently" are distinguishable. */
function classify(status: number, body: string): string | null {
  if (status === 0) return 'network/timeout'
  if (status >= 500) return `server ${status}`
  if (status === 429) return 'rate limited 429'
  if (status >= 400) {
    if (/23505/.test(body)) return '23505 unique violation'
    if (/too many|connection|pool/i.test(body)) return 'connection/pool'
    return `client ${status}`
  }
  // 200s that are not actually an order = SILENT failure
  if (!/"orderId"|"requestId"/.test(body)) return 'SILENT: 200 without an order id'
  return null
}

async function submitOrder(restaurantId: string, tableNumber: number, sessionId: string): Promise<Outcome> {
  const t0 = Date.now()
  let status = 0
  let body = ''
  try {
    const res = await fetch(`${WORKER}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId,
        tableNumber,
        table_number: tableNumber,
        sessionId,
        session_id: sessionId,
        channel: 'table',
        items: [{ id: LOAD_ITEM_ID, menu_item_id: LOAD_ITEM_ID, name: LOAD_ITEM_NAME, quantity: 1, price: LOAD_ITEM_PRICE, selected_variants: {} }],
        subtotal: LOAD_ITEM_PRICE,
        total: LOAD_ITEM_PRICE,
        paymentMethod: 'cash',
        payment_channel: 'qr',
      }),
    })
    status = res.status
    body = await res.text()
  } catch (e) {
    body = String(e)
  }
  const ms = Date.now() - t0
  let orderNumber: number | null = null
  let orderId: string | null = null
  try {
    const j = JSON.parse(body)
    orderNumber = typeof j.orderNumber === 'number' ? j.orderNumber : null
    orderId = j.orderId ?? j.requestId ?? null
  } catch { /* body is not json */ }
  return { ms, status, ok: status >= 200 && status < 300, orderNumber, orderId, errorKind: classify(status, body), bodySnippet: body.slice(0, 120) }
}

let LOAD_ITEM_ID = ''
let LOAD_ITEM_NAME = ''
let LOAD_ITEM_PRICE = 0

async function main() {
  console.log(`=== QR LOAD SIMULATION — STAGING (${STAGING_REF}) ===`)
  console.log(`worker    : ${WORKER}`)
  console.log(`customers : ${TOTAL}   tables: ${TABLES}   ramp: ${RAMP.join(', ')}`)
  console.log('')

  // Resolve the target from an item that ACTUALLY EXISTS, not from the first restaurant row --
  // the first restaurant on staging has no active menu items and the run dies on it.
  const override = arg('restaurant', '')
  const iRes = await fetch(
    `${SUPABASE_URL}/rest/v1/menu_items?select=id,name,base_price,restaurant_id&status=eq.active`
      + `&base_price=gt.0&limit=1000` + (override ? `&restaurant_id=eq.${override}` : ''),
    { headers: H })
  const allItems = await iRes.json()
  if (!Array.isArray(allItems) || !allItems.length) { console.error('no active menu item on staging'); process.exit(1) }
  const byRest = new Map<string, any[]>()
  for (const it of allItems) {
    const k = String(it.restaurant_id)
    byRest.set(k, [...(byRest.get(k) ?? []), it])
  }
  const [restaurantId, chosen] = [...byRest.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  LOAD_ITEM_ID = String(chosen[0].id)
  LOAD_ITEM_NAME = String(chosen[0].name)
  LOAD_ITEM_PRICE = Number(chosen[0].base_price) || 0
  const rRes = await fetch(`${SUPABASE_URL}/rest/v1/restaurants?select=id,name&id=eq.${restaurantId}`, { headers: H })
  const rName = (await rRes.json())?.[0]?.name ?? '(unnamed)'
  console.log(`restaurant: ${rName} (${restaurantId})  active items: ${chosen.length}`)
  console.log(`item      : ${LOAD_ITEM_NAME} @ N$${LOAD_ITEM_PRICE}`)
  console.log('')

  const before = await countOrders(restaurantId)
  console.log(`orders on this restaurant BEFORE: ${before}`)
  console.log('')

  // ---- PHASE 1: latency vs concurrency -------------------------------------------------
  console.log('=== PHASE 1 — submission latency as concurrency climbs ===')
  console.log('  conc |   n | ok  | fail |  p50 |  p95 |  p99 |  max | first failure')
  const allOutcomes: Outcome[] = []
  for (const conc of RAMP) {
    const jobs = Array.from({ length: conc }, (_, i) =>
      () => submitOrder(restaurantId, 1 + (i % TABLES), `load-${conc}-${i}-${process.pid}`))
    const t0 = Date.now()
    const res = await Promise.all(jobs.map((j) => j()))
    const wall = Date.now() - t0
    allOutcomes.push(...res)
    const lat = res.map((r) => r.ms).sort((a, b) => a - b)
    const ok = res.filter((r) => r.ok && !r.errorKind).length
    const fails = res.filter((r) => !r.ok || r.errorKind)
    const firstFail = fails[0]?.errorKind ?? '-'
    console.log(
      `  ${String(conc).padStart(4)} | ${String(res.length).padStart(3)} | ${String(ok).padStart(3)} | ${String(fails.length).padStart(4)} |` +
      ` ${String(pct(lat, 50)).padStart(4)} | ${String(pct(lat, 95)).padStart(4)} | ${String(pct(lat, 99)).padStart(4)} | ${String(lat[lat.length - 1] ?? 0).padStart(4)} | ${firstFail}` +
      `   (wall ${wall}ms)`,
    )
  }
  console.log('')

  // ---- PHASE 2: duplicate order numbers ------------------------------------------------
  console.log('=== PHASE 2 — did count(*)+1 numbering collide? (#127) ===')
  const nums = allOutcomes.map((o) => o.orderNumber).filter((n): n is number => n != null)
  const seen = new Map<number, number>()
  for (const n of nums) seen.set(n, (seen.get(n) ?? 0) + 1)
  const dupes = [...seen.entries()].filter(([, c]) => c > 1)
  console.log(`  order numbers returned : ${nums.length}`)
  console.log(`  distinct               : ${seen.size}`)
  console.log(`  DUPLICATED             : ${dupes.length}${dupes.length ? '  <-- #127 REPRODUCED' : ''}`)
  for (const [n, c] of dupes.slice(0, 10)) console.log(`     #${n} issued ${c} times`)
  console.log('')

  // ---- PHASE 3: one-open-tab-per-table under simultaneous scans ------------------------
  console.log('=== PHASE 3 — simultaneous Create Tab on the SAME table (idx_tabs_one_open_per_table) ===')
  const CONTENDERS = Number(arg('contenders', '25'))
  const tableForRace = 1 + TABLES // a table the order phase did not use
  const tabRes = await Promise.all(
    Array.from({ length: CONTENDERS }, (_, i) => createTab(restaurantId, tableForRace, `race-${i}-${process.pid}`)),
  )
  const created = tabRes.filter((r) => r.status >= 200 && r.status < 300)
  const tabIds = new Set(created.map((r) => r.tabId).filter(Boolean))
  const joined = created.filter((r) => r.joinedExisting).length
  console.log(`  contenders            : ${CONTENDERS} on table ${tableForRace}`)
  console.log(`  2xx responses         : ${created.length}`)
  console.log(`  DISTINCT tabs created : ${tabIds.size}   (must be 1 -- more means the index did not hold)`)
  console.log(`  joinedExisting: true  : ${joined}   <-- these landed in the 23505 recovery branch (#218)`)
  const tabFails = tabRes.filter((r) => r.status >= 400)
  const byStatus = new Map<number, number>()
  for (const f of tabFails) byStatus.set(f.status, (byStatus.get(f.status) ?? 0) + 1)
  console.log(`  non-2xx               : ${tabFails.length}  ${[...byStatus].map(([s, c]) => `${s}x${c}`).join(' ')}`)
  if (tabFails[0]) console.log(`     first: ${tabFails[0].body.slice(0, 140)}`)
  console.log('')

  // ---- PHASE 4: what failed first, loudly or silently ----------------------------------
  console.log('=== PHASE 4 — error taxonomy: what breaks first, and is it loud? ===')
  const kinds = new Map<string, number>()
  for (const o of allOutcomes) if (o.errorKind) kinds.set(o.errorKind, (kinds.get(o.errorKind) ?? 0) + 1)
  if (!kinds.size) console.log('  no failures at any rung')
  for (const [k, c] of [...kinds].sort((a, b) => b[1] - a[1])) {
    const loud = !k.startsWith('SILENT')
    console.log(`  ${String(c).padStart(4)}  ${k}   [${loud ? 'LOUD - customer sees an error' : 'SILENT - customer sees success'}]`)
  }
  const firstBad = allOutcomes.find((o) => o.errorKind)
  if (firstBad) console.log(`\n  FIRST failure body: ${firstBad.bodySnippet}`)
  console.log('')

  const after = await countOrders(restaurantId)
  console.log(`orders on this restaurant AFTER : ${after}   (+${after - before})`)
  console.log('')
  console.log('NOTE: this writes real staging orders. Clean up with the restaurant-scoped delete')
  console.log('      procedure (leaves first) if the row count matters for a later measurement.')
}

async function countOrders(restaurantId: string): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/orders?select=id&restaurant_id=eq.${restaurantId}&limit=1`, {
    headers: { ...H, Prefer: 'count=exact' },
  })
  return Number((r.headers.get('content-range') ?? '').split('/')[1] ?? 0)
}

async function createTab(restaurantId: string, tableNumber: number, sessionId: string) {
  try {
    const res = await fetch(`${WORKER}/api/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restaurantId, tableNumber, table_number: tableNumber, sessionId, displayName: sessionId }),
    })
    const body = await res.text()
    let tabId: string | null = null
    let joinedExisting = false
    try { const j = JSON.parse(body); tabId = j.tabId ?? j.id ?? null; joinedExisting = Boolean(j.joinedExisting) } catch { /* not json */ }
    return { status: res.status, body, tabId, joinedExisting }
  } catch (e) {
    return { status: 0, body: String(e), tabId: null, joinedExisting: false }
  }
}

void main()
