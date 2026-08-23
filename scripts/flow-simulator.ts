/**
 * CUSTOMER-FLOW SIMULATOR — staging only, never production, never a real card.
 *
 * Drives the REAL deployed HTTP flows as an impatient, confused or unlucky customer would. Not unit
 * tests: actual sequences against a deployed worker, because the defect class this exists to catch
 * is invisible to static review. The owner found the double-tap bug by tapping twice.
 *
 * Seeds its own restaurant, table and menu item; cleans them up in `finally`, including after a
 * failure mid-scenario.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/flow-simulator.ts            # all scenarios
 *   node node_modules/tsx/dist/cli.mjs scripts/flow-simulator.ts double-tap # one
 *
 * See docs/agent-flow-simulator.md.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const WORKER = process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.STAGING_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

/** Severity order, worst first. Findings are reported in this order. */
const SEVERITY = ['MONEY_TWICE', 'ORDER_LOST', 'STRANDED', 'COSMETIC'] as const
type Severity = (typeof SEVERITY)[number]
type Finding = { scenario: string; severity: Severity; what: string; repro: string[] }
const findings: Finding[] = []
const record = (f: Finding) => findings.push(f)

function assertStaging() {
  if (!url.includes(STAGING_REF)) throw new Error(`REFUSING: not staging — ${url}`)
  if (!serviceKey) throw new Error('Need the staging service role key')
}

const admin = () => createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

async function seed(db: ReturnType<typeof admin>, tag: string) {
  const { data: r, error: rErr } = await db
    .from('restaurants')
    .insert({ name: tag, finatic_merchant_no: 'STAGING_STUB_MERCHANT', finatic_store_no: 'STAGING_STUB_STORE' })
    .select('id')
    .single()
  if (rErr) throw new Error(`seed restaurant: ${rErr.message}`)
  const restaurantId = String(r.id)

  const { data: m, error: mErr } = await db
    .from('menu_items')
    .insert({ restaurant_id: restaurantId, name: `${tag}-coffee`, base_price: 25, status: 'available' })
    .select('id')
    .single()
  if (mErr) throw new Error(`seed menu item: ${mErr.message}`)

  /**
   * A guest order is refused with 403 "This table has been closed" unless an OPEN TAB exists at the
   * table (app/api/orders/route.ts). The tab is created by the customer scanning the QR, and the
   * tab route in turn requires a restaurant_tables row. So the seed provides the table; the
   * simulator creates the tab over HTTP, as a customer does.
   */
  // One table PER SCENARIO. A tab is unique per open table, so a second scenario reusing the same
  // table is correctly refused with TAB_PIN_REQUIRED — that is the product working, not a finding.
  const tables = [7, 8, 9, 10, 11, 12]
  const { error: tErr } = await db
    .from('restaurant_tables')
    .insert(tables.map((n) => ({ restaurant_id: restaurantId, table_number: n, status: 'available' })))
  if (tErr) throw new Error(`seed tables: ${tErr.message}`)

  return { restaurantId, menuItemId: String(m.id), tables }
}

/** The customer scans the QR and starts a tab. Returns the tab id, or throws with the refusal. */
async function scanAndOpenTab(ctx: { restaurantId: string; tableNumber: number }, sessionId: string) {
  const res = await fetch(`${WORKER}/api/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: ctx.restaurantId, tableNumber: ctx.tableNumber, sessionId }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`scanAndOpenTab: HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`)
  return String(body?.tabId ?? body?.tab?.id ?? '')
}

async function cleanup(db: ReturnType<typeof admin>, restaurantId: string) {
  if (!restaurantId) return
  await db.from('order_requests').delete().eq('restaurant_id', restaurantId)
  const { data: os } = await db.from('orders').select('id').eq('restaurant_id', restaurantId)
  const ids = (os ?? []).map((o: { id: string }) => String(o.id))
  if (ids.length) {
    await db.from('audit_logs').delete().in('entity_id', ids)
    await db.from('orders').delete().in('id', ids)
  }
  await db.from('tabs').delete().eq('restaurant_id', restaurantId)
  await db.from('restaurant_tables').delete().eq('restaurant_id', restaurantId)
  await db.from('menu_items').delete().eq('restaurant_id', restaurantId)
  await db.from('restaurants').delete().eq('id', restaurantId)
  return ids.length
}

/** One customer "tap" on Place Order. */
function placeOrder(ctx: { restaurantId: string; menuItemId: string; tableNumber: number }, opts: {
  sessionId: string
  idempotencyKey?: string | null
}) {
  return fetch(`${WORKER}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.idempotencyKey ? { 'x-idempotency-key': opts.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      restaurantId: ctx.restaurantId,
      tableNumber: ctx.tableNumber,
      sessionId: opts.sessionId,
      channel: 'table',
      items: [
        {
          menuItemId: ctx.menuItemId,
          name: 'sim-coffee',
          quantity: 1,
          basePrice: 25,
          subtotal: 25,
          addons: [],
          specialInstructions: '',
        },
      ],
      subtotal: 25,
      total: 25,
      orderInstructions: '',
    }),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
}

/**
 * What the customer's browser does after Place Order: it lands on the confirmation screen, which
 * resolves the order through the guest by-payment-ref lookup. Reproduced here over HTTP exactly as
 * the page does it, because the page's failure is the thing under test.
 */
function confirmationLookup(ref: string, restaurantId: string, tableNumber: number, sessionId: string) {
  const qs = new URLSearchParams({ paymentRef: ref, restaurantId, table_number: String(tableNumber) })
  qs.append('session_id', sessionId)
  return fetch(`${WORKER}/api/guest/orders/by-payment-ref?${qs.toString()}`).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => null),
  }))
}


/**
 * An order lands in `orders` OR in `order_requests`, depending on whether the venue reviews orders
 * before accepting them. The response says which (`status: 'waiting_review'` + `requestId`). Count
 * BOTH, or a review-enabled venue looks like nothing was created at all — which is what the first
 * run of this harness reported, wrongly.
 */
async function countSubmissions(db: any, restaurantId: string, tableNumber: number) {
  const o = (await db.from('orders').select('id').eq('restaurant_id', restaurantId).eq('table_number', tableNumber)).data ?? []
  const r = (await db.from('order_requests').select('id').eq('restaurant_id', restaurantId).eq('table_number', tableNumber)).data ?? []
  return { orders: o.length, requests: r.length, total: o.length + r.length }
}

// ---------------------------------------------------------------- scenarios

async function scenarioDoubleTap(db: ReturnType<typeof admin>, ctx: any) {
  const name = 'double-tap'
  ctx = { ...ctx, tableNumber: ctx.tables[0] }
  console.log(`\n=== ${name} ===`)
  const session = `sim-${randomUUID()}`
  const idem = randomUUID()
  await scanAndOpenTab(ctx, session)

  // TWO TAPS, fired together, as a real double-tap does.
  const [a, b] = await Promise.all([
    placeOrder(ctx, { sessionId: session, idempotencyKey: idem }),
    placeOrder(ctx, { sessionId: session, idempotencyKey: idem }),
  ])
  const c = await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)
  const n = c.total
  console.log(`  two taps, SAME idempotency key -> HTTP ${a.status}/${b.status}`)
  console.log(`    submissions created: ${n}  (orders=${c.orders} order_requests=${c.requests})`)
  if (n > 1) {
    record({
      scenario: name,
      severity: 'MONEY_TWICE',
      what: `A double tap created ${n} orders despite an identical x-idempotency-key.`,
      repro: [`POST /api/orders twice concurrently with the same x-idempotency-key`, `expect 1 order, got ${n}`],
    })
  }

  // THE CUSTOMER-VISIBLE HALF. The app now routes to the confirmation screen. Does it resolve?
  const orderId = String(a.body?.orderId ?? a.body?.order?.id ?? b.body?.orderId ?? '')
  if (orderId) {
    const look = await confirmationLookup(orderId, ctx.restaurantId, ctx.tableNumber, session)
    const found = Array.isArray(look.body?.orders) ? look.body.orders.length : 0
    console.log(`  confirmation lookup by ORDER ID -> HTTP ${look.status}, orders found: ${found}`)
    if (found === 0) {
      record({
        scenario: name,
        severity: 'STRANDED',
        what:
          'After placing an order, resolving the confirmation screen by the order id returns nothing, ' +
          'so the customer is shown "Order not found" for an order that exists.',
        repro: [
          'POST /api/orders and take `order.id` from the response',
          'GET /api/guest/orders/by-payment-ref?paymentRef=<that order id>&restaurantId=…&table_number=…',
          'expect the order, got 0 rows — the lookup only matches payment_reference / paycloud_merchant_order_no',
        ],
      })
    }
  } else {
    console.log('  could not read an order id from either response — cannot test the confirmation half')
  }
}

/** CONTROL: without a key, two taps SHOULD make two orders. Proves the harness can see duplicates. */
async function scenarioDoubleTapControl(db: ReturnType<typeof admin>, ctx: any) {
  const name = 'double-tap-control'
  ctx = { ...ctx, tableNumber: ctx.tables[1] }
  console.log(`\n=== ${name} (negative control) ===`)
  const session = `sim-${randomUUID()}`
  await scanAndOpenTab(ctx, session)
  const before = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total
  await Promise.all([
    placeOrder(ctx, { sessionId: session, idempotencyKey: null }),
    placeOrder(ctx, { sessionId: session, idempotencyKey: null }),
  ])
  const after = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total
  const delta = after - before
  console.log(`  two taps, NO key -> orders created: ${delta} (expect 2; if 1, the harness cannot see duplicates)`)
  if (delta !== 2) {
    console.log('  *** CONTROL FAILED — a clean run of any other scenario means nothing ***')
  }
}

const SCENARIOS: Record<string, (db: any, ctx: any) => Promise<void>> = {
  'double-tap': scenarioDoubleTap,
  'double-tap-control': scenarioDoubleTapControl,
}

async function main() {
  assertStaging()
  const only = process.argv[2]
  const db = admin()
  const tag = `flowsim-${Date.now()}`
  console.log(`worker   ${WORKER}\nsupabase ${url}\nseed tag ${tag}`)

  let restaurantId = ''
  try {
    const seeded = await seed(db, tag)
    restaurantId = seeded.restaurantId
    const ctx = { ...seeded }
    for (const [key, fn] of Object.entries(SCENARIOS)) {
      if (only && key !== only) continue
      await fn(db, ctx)
    }
  } finally {
    const n = await cleanup(db, restaurantId)
    console.log(`\ncleaned up: ${n ?? 0} order(s), menu item, restaurant`)
  }

  console.log(`\n=== FINDINGS (${findings.length}) — worst first ===`)
  for (const sev of SEVERITY) {
    for (const f of findings.filter((x) => x.severity === sev)) {
      console.log(`\n  [${f.severity}] ${f.scenario}`)
      console.log(`    ${f.what}`)
      f.repro.forEach((r, i) => console.log(`      ${i + 1}. ${r}`))
    }
  }
  if (!findings.length) console.log('  none')
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
