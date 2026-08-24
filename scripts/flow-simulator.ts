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
  // ONE TABLE PER SCENARIO, INCLUDING EACH CONTROL. A tab is unique per open table, so a second
  // scenario reusing a table is correctly refused with TAB_PIN_REQUIRED -- which would look like
  // a finding and is the product working. Eight scenarios, eight tables.
  const tables = [7, 8, 9, 10, 11, 12, 13, 14]
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
  // The route reads `ref` (or `tn`), NOT `paymentRef`. Sending the wrong name returns 400
  // 'ref is required', which looks exactly like a failed lookup and is not one.
  const qs = new URLSearchParams({ ref, restaurantId, table_number: String(tableNumber) })
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


// ---------------------------------------------------------------- staff closes the table mid-checkout

/**
 * The customer is on the payment screen when staff hit Close Table.
 *
 * The question is not whether the order is refused -- it must be -- but WHAT the customer is told,
 * and whether anything is left half-done. A close settles the tab, expires the session and bumps
 * restaurant_tables.current_session_version, so an order landing after it belongs to a session that
 * no longer exists.
 *
 * Worst outcomes, in order: an order accepted onto a settled tab (the kitchen makes food nobody is
 * seated for), and a refusal so generic the customer retries into the same wall.
 */
async function scenarioCloseTableMidCheckout(db: ReturnType<typeof admin>, ctx: any) {
  const name = 'staff-closes-table-mid-checkout'
  ctx = { ...ctx, tableNumber: ctx.tables[2] }
  console.log(`\n=== ${name} ===`)
  const session = `sim-${randomUUID()}`
  const tabId = await scanAndOpenTab(ctx, session)

  const { data: tableRow } = await db
    .from('restaurant_tables')
    .select('id, current_session_version')
    .eq('restaurant_id', ctx.restaurantId)
    .eq('table_number', ctx.tableNumber)
    .single()
  const versionBefore = Number(tableRow?.current_session_version ?? 0)

  const { error: closeErr } = await db.rpc('close_table_session', {
    p_table_id: String(tableRow.id),
    p_restaurant_id: ctx.restaurantId,
  })
  if (closeErr) throw new Error(`close_table_session: ${closeErr.message}`)

  const before = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total
  const res = await placeOrder(ctx, { sessionId: session, idempotencyKey: `sim-${randomUUID()}` })
  const after = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total

  const { data: tabAfter } = await db.from('tabs').select('status, settled_type').eq('id', tabId).single()
  const { data: tableAfter } = await db
    .from('restaurant_tables')
    .select('current_session_version')
    .eq('id', String(tableRow.id))
    .single()

  console.log(`  tab after close          : ${tabAfter?.status} / ${tabAfter?.settled_type}`)
  console.log(`  session version          : ${versionBefore} -> ${tableAfter?.current_session_version}`)
  console.log(`  order after close        : HTTP ${res.status}`)
  console.log(`  message the customer sees: ${JSON.stringify(res.body?.error ?? res.body?.message ?? '(none)')}`)
  console.log(`  submissions created      : ${after - before}`)

  if (after > before) {
    record({
      severity: 'ORDER_LOST',
      scenario: name,
      what: `An order was accepted onto a table staff had already closed (HTTP ${res.status}). The tab is ${tabAfter?.status}, so the kitchen may prepare food for a session that no longer exists.`,
      repro: [
        'Customer scans the QR and opens a tab',
        'Staff press Close Table while the customer is on the payment screen',
        'Customer taps Place Order',
        `A row is created anyway (submissions ${before} -> ${after})`,
      ],
    })
  } else if (res.status >= 500) {
    record({
      severity: 'COSMETIC',
      scenario: name,
      what: `The refusal is a ${res.status}, which reads as "the app is broken" rather than "your table was closed". A specific 4xx is the difference between rescanning and giving up.`,
      repro: ['Close the table mid-checkout', 'Place the order', `Server answers ${res.status}`],
    })
  }
}

/**
 * NEGATIVE CONTROL. Identical, minus the close. If this does not create an order, the scenario above
 * proves nothing -- a refusal would be indistinguishable from a seed that could never order at all.
 */
async function scenarioCloseTableMidCheckoutControl(db: ReturnType<typeof admin>, ctx: any) {
  const name = 'staff-closes-table-mid-checkout-control'
  ctx = { ...ctx, tableNumber: ctx.tables[3] }
  console.log(`\n=== ${name} (negative control) ===`)
  const session = `sim-${randomUUID()}`
  await scanAndOpenTab(ctx, session)
  const before = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total
  const res = await placeOrder(ctx, { sessionId: session, idempotencyKey: `sim-${randomUUID()}` })
  const after = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total
  console.log(`  no close -> HTTP ${res.status}, submissions created: ${after - before} (expect 1)`)
  if (after - before !== 1) {
    console.log('  *** CONTROL FAILED -- the close-table result above means nothing ***')
  }
}

// ---------------------------------------------------------------- two sessions, one table

/**
 * Two phones at the same table. The second scan must NOT silently receive the first party's tab.
 *
 * The #211 / QRA-02 shape: idx_tabs_one_open_per_table guarantees the second insert hits 23505, and
 * the recovery branch decides what happens next. Handing over the existing tab with a fresh session
 * token and no PIN is the failure -- the second phone could then add orders to a stranger's bill and
 * flip it to ready_to_pay.
 */
async function scenarioTwoSessionsOneTable(db: ReturnType<typeof admin>, ctx: any) {
  const name = 'two-sessions-one-table'
  ctx = { ...ctx, tableNumber: ctx.tables[4] }
  console.log(`\n=== ${name} ===`)

  const sessionA = `sim-${randomUUID()}`
  const tabA = await scanAndOpenTab(ctx, sessionA)
  console.log(`  phone A opened tab ${tabA.slice(0, 8)}`)

  const sessionB = `sim-${randomUUID()}`
  let tabB = ''
  let refusal: string | null = null
  try {
    tabB = await scanAndOpenTab(ctx, sessionB)
  } catch (e) {
    refusal = e instanceof Error ? e.message : String(e)
  }

  if (refusal) {
    console.log(`  phone B refused: ${refusal.slice(0, 140)}`)
  } else {
    console.log(
      `  phone B received tab ${tabB.slice(0, 8)}  ${tabB === tabA ? '<-- THE SAME TAB' : '(a different tab)'}`,
    )
  }

  const { data: tabRow } = await db.from('tabs').select('pin_required, tab_pin').eq('id', tabA).single()
  console.log(`  tab A pin_required=${tabRow?.pin_required} has_pin=${Boolean(tabRow?.tab_pin)}`)

  if (!refusal && tabB === tabA) {
    // Reading a tab is already anon-visible; ACTING on it is the exposure.
    const before = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total
    const res = await placeOrder(ctx, { sessionId: sessionB, idempotencyKey: `sim-${randomUUID()}` })
    const after = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total
    console.log(`  phone B ordering on A's tab -> HTTP ${res.status}, created ${after - before}`)
    if (after > before) {
      record({
        severity: 'MONEY_TWICE',
        scenario: name,
        what: `A second phone scanning the same table was handed the FIRST party's open tab with no PIN check, and could add an order to their bill (HTTP ${res.status}). pin_required=${tabRow?.pin_required}.`,
        repro: [
          'Phone A scans the table QR and opens a tab',
          'Phone B scans the same QR',
          'B receives the same tab id and a working session',
          'B places an order; it lands on A’s bill',
        ],
      })
    }
  } else if (!refusal && tabB !== tabA) {
    record({
      severity: 'STRANDED',
      scenario: name,
      what: 'Two open tabs now exist for one table, which the unique index exists to prevent. Settlement and the terminal table list both assume one.',
      repro: ['Phone A opens a tab', 'Phone B scans the same table', 'Two distinct tab ids exist'],
    })
  }
}

/**
 * NEGATIVE CONTROL. A first scan at a FRESH table must succeed. If it does not, "phone B was refused"
 * above is explained by the seed rather than by the PIN gate.
 */
async function scenarioTwoSessionsOneTableControl(db: ReturnType<typeof admin>, ctx: any) {
  const name = 'two-sessions-one-table-control'
  ctx = { ...ctx, tableNumber: ctx.tables[5] }
  console.log(`\n=== ${name} (negative control) ===`)
  const session = `sim-${randomUUID()}`
  let ok = true
  let tabId = ''
  try {
    tabId = await scanAndOpenTab(ctx, session)
  } catch (e) {
    ok = false
    console.log(`  first scan at a FRESH table FAILED: ${e instanceof Error ? e.message : e}`)
  }
  console.log(`  first scan at a fresh table -> ${ok ? `tab ${tabId.slice(0, 8)}` : 'REFUSED'} (expect a tab)`)
  if (!ok) console.log('  *** CONTROL FAILED -- the two-sessions result above means nothing ***')
}

// ---------------------------------------------------------------- back button mid-payment

/**
 * The customer taps Place Order, hits BACK before the confirmation screen loads, and taps again.
 *
 * This is the double tap with a gap in the middle, and it is the shape the customer app is most
 * likely to get wrong: the cart is still populated after a back navigation, so the second tap is a
 * genuine second submission from the user's point of view. Whether it duplicates depends entirely on
 * whether the idempotency key SURVIVES the navigation -- a key minted per render does not.
 *
 * Sequential, not concurrent. The concurrent case is already covered by double-tap; this one tests
 * the key's lifetime, which is a different property.
 */
async function scenarioBackButtonMidPayment(db: ReturnType<typeof admin>, ctx: any) {
  const name = 'back-button-mid-payment'
  ctx = { ...ctx, tableNumber: ctx.tables[6] }
  console.log(`\n=== ${name} ===`)
  const session = `sim-${randomUUID()}`
  await scanAndOpenTab(ctx, session)

  const before = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total

  const key = `sim-sale-${randomUUID()}`
  const first = await placeOrder(ctx, { sessionId: session, idempotencyKey: key })
  await new Promise((r) => setTimeout(r, 1200))
  const second = await placeOrder(ctx, { sessionId: session, idempotencyKey: key })

  const after = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total
  console.log(`  tap 1 -> HTTP ${first.status}`)
  console.log(`  back, then tap 2 (SAME key) -> HTTP ${second.status}`)
  console.log(`  submissions created: ${after - before} (1 = the key held across the navigation)`)

  if (after - before > 1) {
    record({
      severity: 'MONEY_TWICE',
      scenario: name,
      what: `Going back and re-submitting one sale created ${after - before} submissions despite an identical x-idempotency-key. The key is not honoured across a navigation.`,
      repro: [
        'Place an order',
        'Press back before the confirmation screen loads',
        'Place the order again with the same idempotency key',
        `${after - before} rows exist`,
      ],
    })
  }

  const orderId = String(first.body?.orderId ?? first.body?.order?.id ?? first.body?.requestId ?? '')
  if (orderId) {
    const look = await confirmationLookup(orderId, ctx.restaurantId, ctx.tableNumber, session)
    const rows = Array.isArray(look.body?.orders) ? look.body.orders.length : 0
    console.log(`  confirmation lookup by that id -> HTTP ${look.status}, ${rows} row(s)`)
    if (look.status !== 200 || rows === 0) {
      record({
        severity: 'COSMETIC',
        scenario: name,
        what: `After going back and re-submitting, the confirmation screen could not resolve the order (HTTP ${look.status}, ${rows} rows). The customer reads "order not found" for an order that exists.`,
        repro: ['Place an order', 'Go back and re-submit', 'Open the confirmation link', 'It cannot find the order'],
      })
    }
  }
}

/**
 * NEGATIVE CONTROL. The same two sequential taps with DIFFERENT keys must create two submissions. If
 * they do not, the harness cannot see a duplicate and a clean run above is meaningless. This is the
 * control shape that already caught the first version of the double-tap scenario.
 */
async function scenarioBackButtonMidPaymentControl(db: ReturnType<typeof admin>, ctx: any) {
  const name = 'back-button-mid-payment-control'
  ctx = { ...ctx, tableNumber: ctx.tables[7] }
  console.log(`\n=== ${name} (negative control) ===`)
  const session = `sim-${randomUUID()}`
  await scanAndOpenTab(ctx, session)
  const before = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total
  await placeOrder(ctx, { sessionId: session, idempotencyKey: `sim-${randomUUID()}` })
  await new Promise((r) => setTimeout(r, 1200))
  await placeOrder(ctx, { sessionId: session, idempotencyKey: `sim-${randomUUID()}` })
  const after = (await countSubmissions(db, ctx.restaurantId, ctx.tableNumber)).total
  console.log(`  two taps, DIFFERENT keys -> created: ${after - before} (expect 2)`)
  if (after - before !== 2) {
    console.log('  *** CONTROL FAILED -- the back-button result above means nothing ***')
  }
}

const SCENARIOS: Record<string, (db: any, ctx: any) => Promise<void>> = {
  'double-tap': scenarioDoubleTap,
  'double-tap-control': scenarioDoubleTapControl,
  'close-table-mid-checkout': scenarioCloseTableMidCheckout,
  'close-table-mid-checkout-control': scenarioCloseTableMidCheckoutControl,
  'two-sessions-one-table': scenarioTwoSessionsOneTable,
  'two-sessions-one-table-control': scenarioTwoSessionsOneTableControl,
  'back-button-mid-payment': scenarioBackButtonMidPayment,
  'back-button-mid-payment-control': scenarioBackButtonMidPaymentControl,
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
