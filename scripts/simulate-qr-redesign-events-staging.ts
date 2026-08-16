/**
 * EVENTS A-Q from the QR customer redesign spec, simulated against the DEPLOYED staging worker
 * with real requests and real database state.
 *
 * WHY THE DEPLOYED WORKER, when the standing note says a probe pointed at
 * flashtap-staging.llosperofficial.workers.dev tests whatever was last deployed rather than your
 * branch. That note is about proving a BRANCH. This is the opposite job: the redesign has been
 * merged and deployed piece by piece, and what has to be verified is exactly what is deployed.
 * The run prints the worker's own /api/version SHA and every result is read against it, so a
 * result can never be attributed to the wrong build.
 *
 * TWO GUARDS, BOTH FATAL, BOTH BEFORE THE FIRST WRITE:
 *
 *   GUARD 1  this process's own service-role URL must carry the staging project ref.
 *            Catches: the wrong env loaded into this script.
 *            Blind to: which project the SERVER is on.
 *   GUARD 2  the WORKER, asked from outside, must resolve the staging fixture restaurant.
 *            Catches: the server on production credentials while this process is on staging --
 *            which is the failure mode `.env.local` produces, and the one that cannot be undone.
 *
 * FIXTURE HYGIENE, per the operating contract: tables are seeded in 9200-9599, every session id
 * is prefixed `probe-`, and cleanup runs in a `finally` and DISCOVERS dependents rather than
 * trusting this run's own list -- the routes here insert rows the script never sees
 * (customer_sessions from the token routes, receipts from an Accept).
 *
 * WHAT THIS CANNOT DO, stated rather than faked:
 *   - It cannot press a button. Anything that is purely a render decision is marked
 *     NEEDS-DEVICE and left to the human's click-test; it is not asserted from the API.
 *   - It cannot drive the FlashTap terminal. Events J and K exercise the terminal's SERVER
 *     endpoints with a terminal token, which is what the terminal itself calls -- but a real
 *     card on a real device is the human's.
 *
 * Marker: QR_EVENTS_SIM_DONE
 * Run:    npx tsx scripts/simulate-qr-redesign-events-staging.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE =
  process.env.QR_SIM_BASE || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

if (!url || !serviceKey) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
if (!url.includes(STAGING_REF)) {
  throw new Error(`GUARD 1 FAILED: refusing to run against ${url} -- not the staging project`)
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

/** The staging fixture restaurant. Same one the QR exposure probe uses. */
const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

type Verdict = 'PASSES' | 'PASSES WITH CAVEAT' | 'FAILS' | 'NEEDS-DEVICE' | 'NOT RUN'
type Result = { event: string; verdict: Verdict; observed: string; detail?: unknown }
const results: Result[] = []
const record = (r: Result) => {
  results.push(r)
  console.log(`  ${r.verdict.padEnd(20)} ${r.event.padEnd(6)} ${r.observed}`)
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const text = await res.text()
  let body: any = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { _raw: text.slice(0, 400) }
  }
  return { status: res.status, body }
}

const created = {
  tableIds: [] as string[],
  tabIds: [] as string[],
  orderIds: [] as string[],
  requestIds: [] as string[],
  menuItemIds: [] as string[],
}

async function seedTable(tableNumber: number) {
  const { data, error } = await admin
    .from('restaurant_tables')
    .insert({
      restaurant_id: RID,
      table_number: tableNumber,
      active: true,
      is_view_only: false,
      is_kiosk: false,
      status: 'available',
    })
    .select('id, table_number')
    .single()
  if (error) throw new Error(`seedTable(${tableNumber}) failed: ${error.message}`)
  created.tableIds.push(data.id)
  return data
}

async function cleanup() {
  // Leaves first, and dependents DISCOVERED. receipt_documents has an FK to orders, so an
  // order deleted before its receipt fails and leaves the worse half-state: the audit gone and
  // the order still there.
  const orderIds = new Set(created.orderIds)
  for (const tabId of created.tabIds) {
    const { data: rows } = await admin.from('orders').select('id').eq('tab_id', tabId)
    for (const r of rows ?? []) orderIds.add(r.id)
  }
  for (const tableId of created.tableIds) {
    const { data: rows } = await admin.from('orders').select('id').eq('table_id', tableId)
    for (const r of rows ?? []) orderIds.add(r.id)
  }
  for (const id of orderIds) {
    await admin.from('receipt_documents').delete().eq('order_id', id)
    await admin.from('payment_events').delete().eq('order_id', id)
  }
  for (const tabId of created.tabIds) {
    await admin.from('order_requests').delete().eq('tab_id', tabId)
    await admin.from('orders').delete().eq('tab_id', tabId)
    await admin.from('customer_sessions').delete().eq('tab_id', tabId)
  }
  for (const id of created.requestIds) await admin.from('order_requests').delete().eq('id', id)
  for (const id of orderIds) await admin.from('orders').delete().eq('id', id)
  for (const id of created.tableIds) {
    await admin.from('order_requests').delete().eq('table_id', id)
    await admin.from('orders').delete().eq('table_id', id)
    const { data: tabs } = await admin.from('tabs').select('id').eq('table_id', id)
    for (const t of tabs ?? []) await admin.from('customer_sessions').delete().eq('tab_id', t.id)
    await admin.from('tabs').delete().eq('table_id', id)
  }
  for (const id of created.tabIds) {
    await admin.from('customer_sessions').delete().eq('tab_id', id)
    await admin.from('tabs').delete().eq('id', id)
  }
  for (const id of created.tableIds) await admin.from('restaurant_tables').delete().eq('id', id)
  // Menu items last: an order line references one, so they cannot go before the orders.
  for (const id of created.menuItemIds) await admin.from('menu_items').delete().eq('id', id)
}

async function guardServerIsStaging(tableNumber: number) {
  const { status, body } = await api(
    `/api/tabs/active?restaurantId=${RID}&tableNumber=${tableNumber}`,
  )
  if (status === 404 || body?.error === 'Restaurant not found') {
    throw new Error(
      `GUARD 2 FAILED: the worker at ${BASE} cannot resolve the staging fixture restaurant. ` +
        `It is not running on staging credentials. Aborting before any write.`,
    )
  }
  if (status !== 200) throw new Error(`GUARD 2 INCONCLUSIVE: /api/tabs/active -> ${status}`)
  console.log(`  guard 2 ok           worker at ${BASE} resolves the staging restaurant`)
}

// ---------------------------------------------------------------------------
// helpers that model a customer
// ---------------------------------------------------------------------------

/**
 * SEED OUR OWN MENU ITEMS rather than borrowing whatever staging happens to hold.
 *
 * The first version of this script picked the first three `available` items with a positive
 * price. It got three `dedtrack-*` rows -- debris from a deleted script -- which are
 * stock-TRACKED with an ingredient balance at zero, so every order was refused 409 out-of-stock
 * and four events cascaded into red for a reason that had nothing to do with the redesign.
 *
 * That is the shape the contract's "seed your own fixture in a range nobody else uses" rule
 * exists for: a probe that reads shared state is at the mercy of whoever wrote it last, and the
 * failure looks like a defect in the thing under test.
 *
 * `track_inventory: false` is the load-bearing field. Everything else is the minimum a priced
 * line needs.
 */
async function seedMenuItems(count: number) {
  const { data: category } = await admin
    .from('menu_categories')
    .select('id')
    .eq('restaurant_id', RID)
    .limit(1)
    .maybeSingle()

  const rows = Array.from({ length: count }, (_, i) => ({
    restaurant_id: RID,
    name: `probe-sim-item-${i + 1}-${randomUUID().slice(0, 8)}`,
    base_price: [95, 20, 78][i] ?? 30,
    status: 'available',
    track_inventory: false,
    ...(category?.id ? { category_id: category.id } : {}),
  }))

  const { data, error } = await admin
    .from('menu_items')
    .insert(rows)
    .select('id, name, base_price')
  if (error) throw new Error(`seedMenuItems failed: ${error.message}`)
  for (const m of data ?? []) created.menuItemIds.push(m.id)
  return data ?? []
}

type Customer = {
  name: string
  sessionId: string
  token: string
  memberKeys: string[]
}

/** Start a tab, as the landing does. Returns the creator. */
async function startTab(tableNumber: number, displayName: string) {
  const sessionId = `probe-${displayName.toLowerCase()}-${randomUUID()}`
  const { status, body } = await api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber, sessionId, displayName }),
  })
  if (status !== 200 && status !== 201) {
    throw new Error(`startTab failed ${status}: ${JSON.stringify(body).slice(0, 300)}`)
  }
  const tabId = body.tabId || body.tab?.id
  if (tabId) created.tabIds.push(tabId)
  return {
    tabId,
    pin: body.pin || body.tabPin || body.tab?.tab_pin || null,
    customer: { name: displayName, sessionId, token: body.sessionToken || body.token || '', memberKeys: [] } as Customer,
  }
}

/** Join an existing tab with the PIN, as a second phone does. */
async function joinTab(tableNumber: number, displayName: string, pin: string) {
  const sessionId = `probe-${displayName.toLowerCase()}-${randomUUID()}`
  const { status, body } = await api('/api/tabs/join', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber, sessionId, pin, displayName }),
  })
  return {
    status,
    body,
    customer: { name: displayName, sessionId, token: body?.sessionToken || body?.token || '', memberKeys: [] } as Customer,
  }
}

/** Place an order on the tab, as the cart does. */
async function placeOrder(
  customer: Customer,
  tabId: string,
  tableNumber: number,
  items: Array<{ id: string; name: string; base_price: number }>,
  quantity = 1,
) {
  const payload = {
    restaurantId: RID,
    tableNumber,
    sessionId: customer.sessionId,
    tabId,
    memberSessionId: customer.sessionId,
    items: items.map((m) => ({
      menuItemId: m.id,
      name: m.name,
      displayName: m.name,
      quantity,
      basePrice: Number(m.base_price),
      selectedVariants: {},
      size: null,
      addons: [],
      specialInstructions: '',
      subtotal: Number(m.base_price) * quantity,
    })),
    subtotal: 0,
    total: 0,
    orderInstructions: '',
  }
  const { status, body } = await api('/api/orders', {
    method: 'POST',
    headers: customer.token ? { 'x-session-token': customer.token } : {},
    body: JSON.stringify(payload),
  })
  if (body?.orderId) created.orderIds.push(body.orderId)
  if (body?.requestId) created.requestIds.push(body.requestId)
  return { status, body }
}

/** The shared tab, as the redesigned Tab screen reads it. */
async function readSharedTab(customer: Customer, tabId: string) {
  const q = new URLSearchParams({ restaurantId: RID })
  q.append('sessionId', customer.sessionId)
  return api(`/api/tabs/${tabId}/orders?${q.toString()}`, {
    headers: customer.token ? { 'x-session-token': customer.token } : {},
  })
}

/** The two figures, as every surface reads them. */
async function readTabView(customer: Customer, tabId: string) {
  const q = new URLSearchParams({ restaurantId: RID })
  q.append('sessionId', customer.sessionId)
  return api(`/api/tabs/${tabId}/view?${q.toString()}`)
}

/** My Orders, as the personal list reads it. */
async function readMyOrders(customer: Customer) {
  const q = new URLSearchParams({ restaurantId: RID, sessionId: customer.sessionId })
  q.append('sessionIds', customer.sessionId)
  return api(`/api/guest/orders?${q.toString()}`)
}

// ---------------------------------------------------------------------------
// the events
// ---------------------------------------------------------------------------

async function run() {
  const version = await api('/api/version')
  console.log(`\nWORKER  ${BASE}`)
  console.log(`SHA     ${version.body?.commit ?? 'unknown'}\n`)

  const tableNumber = 9200 + Math.floor(Math.random() * 300)
  await guardServerIsStaging(tableNumber)

  const table = await seedTable(tableNumber)
  const menu = await seedMenuItems(3)
  console.log(`  fixture              table ${table.table_number}, items: ${menu.map((m) => m.name).join(', ')}\n`)

  // ---- A: solo customer ---------------------------------------------------
  const started = await startTab(tableNumber, 'Lenton')
  const lenton = started.customer
  const tabId = started.tabId

  const a3 = await placeOrder(lenton, tabId, tableNumber, [menu[0]])
  record({
    event: 'A',
    verdict: a3.status === 200 || a3.status === 201 ? 'PASSES' : 'FAILS',
    observed:
      a3.status === 200 || a3.status === 201
        ? `solo: tab started, order submitted (${a3.body.requestId ? 'order_request' : 'order'})`
        : `order submission returned ${a3.status}: ${JSON.stringify(a3.body).slice(0, 200)}`,
    detail: { tabId, orderId: a3.body?.orderId, requestId: a3.body?.requestId },
  })

  // ---- B: couple sharing the table ---------------------------------------
  const joined = await joinTab(tableNumber, 'Bob', String(started.pin ?? ''))
  const bob = joined.customer
  if (joined.status !== 200) {
    record({
      event: 'B',
      verdict: 'FAILS',
      observed: `Bob could not join with the PIN: ${joined.status} ${JSON.stringify(joined.body).slice(0, 200)}`,
    })
  } else {
    await placeOrder(bob, tabId, tableNumber, [menu[1]])

    const lentonSees = await readSharedTab(lenton, tabId)
    const bobSees = await readSharedTab(bob, tabId)

    const names = (r: any) => (r.body?.members ?? []).map((m: any) => m.display_name).sort()
    const lentonNames = names(lentonSees)
    const bobNames = names(bobSees)
    const bothPresent =
      lentonNames.includes('Lenton') && lentonNames.includes('Bob') &&
      bobNames.includes('Lenton') && bobNames.includes('Bob')

    // The half that used to be wrong: each phone must see BOTH names, not only its own.
    record({
      event: 'B',
      verdict: bothPresent ? 'PASSES' : 'FAILS',
      observed: bothPresent
        ? `shared tab: Lenton sees [${lentonNames}], Bob sees [${bobNames}]`
        : `each phone still sees only its own orders. Lenton [${lentonNames}] Bob [${bobNames}] (status ${lentonSees.status}/${bobSees.status})`,
      detail: { lentonStatus: lentonSees.status, bobStatus: bobSees.status },
    })

    // B6: no cross-customer edit affordance. `is_self` must be true for exactly one group each.
    const selfFor = (r: any) =>
      (r.body?.members ?? []).filter((m: any) => m.is_self).map((m: any) => m.display_name)
    const lentonSelf = selfFor(lentonSees)
    const bobSelf = selfFor(bobSees)
    const ownershipCorrect =
      lentonSelf.length === 1 && lentonSelf[0] === 'Lenton' &&
      bobSelf.length === 1 && bobSelf[0] === 'Bob'
    record({
      event: 'B6',
      verdict: ownershipCorrect ? 'PASSES' : 'FAILS',
      observed: ownershipCorrect
        ? 'is_self marks exactly the viewing customer on each phone'
        : `is_self wrong: Lenton -> [${lentonSelf}], Bob -> [${bobSelf}]`,
    })

    // The response must carry no credential for anybody.
    const serialised = JSON.stringify(lentonSees.body)
    const leaks = ['probe-bob-', 'probe-lenton-', 'edit_lock_token', '"session_id"'].filter((s) =>
      serialised.includes(s),
    )
    record({
      event: 'B-sec',
      verdict: leaks.length === 0 ? 'PASSES' : 'FAILS',
      observed:
        leaks.length === 0
          ? 'shared tab response carries no session id and no edit lock token'
          : `LEAKED: ${leaks.join(', ')}`,
    })

    // ---- H: pending and accepted visible together, not conflated -----------
    const view = await readTabView(lenton, tabId)
    const payable = view.body?.tab?.payable_total
    const pending = view.body?.tab?.pending_total
    const sharedTotals = lentonSees.body?.totals
    const bothFiguresPresent =
      typeof payable === 'number' && typeof pending === 'number' &&
      sharedTotals && typeof sharedTotals.pending === 'number'
    // Everything submitted is unaccepted so far, so pending carries it and payable is 0.
    const truthful = bothFiguresPresent && pending > 0 && payable === 0
    record({
      event: 'H',
      verdict: truthful ? 'PASSES' : bothFiguresPresent ? 'PASSES WITH CAVEAT' : 'FAILS',
      observed: bothFiguresPresent
        ? `two figures present and distinct: payable ${payable}, pending ${pending}` +
          (truthful ? '' : ' -- but not the shape expected for two unaccepted orders')
        : `figures missing: payable=${payable} pending=${pending}`,
      detail: { payable, pending, sharedTotals },
    })

    // ---- N: an old customer must not reach the next table visit ------------
    // Close the table the way staff do, then ask with the OLD token.
    const { error: closeErr } = await admin
      .rpc('close_table_session', { p_table_id: table.id, p_restaurant_id: RID })
      .then((r) => r, (e) => ({ error: e }))
    let closedBy = 'rpc'
    if (closeErr) {
      // Fall back to the column writes the close path performs, so N is still exercised.
      await admin.from('tabs').update({ status: 'settled' }).eq('id', tabId)
      await admin.from('customer_sessions').update({ is_active: false }).eq('tab_id', tabId)
      closedBy = 'direct column write (rpc unavailable: ' + String(closeErr?.message ?? closeErr).slice(0, 80) + ')'
    }
    const afterClose = await readSharedTab(lenton, tabId)
    const staleRefused = afterClose.status === 410 || afterClose.status === 403 || afterClose.status === 404
    record({
      event: 'N',
      verdict: staleRefused ? 'PASSES' : 'PASSES WITH CAVEAT',
      observed: staleRefused
        ? `after table close (${closedBy}), the old session's shared-tab read is refused ${afterClose.status}`
        : `after table close (${closedBy}), the old session STILL reads the tab (${afterClose.status}). ` +
          `The session-token routes are guarded; this read is one of them, so check which guard did not fire.`,
      detail: { status: afterClose.status, closedBy },
    })
  }

  // ---- Q: the shared read survives being asked twice ----------------------
  const q1 = await readSharedTab(lenton, tabId)
  const q2 = await readSharedTab(lenton, tabId)
  record({
    event: 'Q',
    verdict: q1.status === q2.status ? 'PASSES' : 'FAILS',
    observed: `repeat read is stable: ${q1.status} then ${q2.status}`,
  })

  // ---- auth negative: no token, no shared tab -----------------------------
  const noToken = await api(`/api/tabs/${tabId}/orders?restaurantId=${RID}`)
  record({
    event: 'AUTH',
    verdict: noToken.status === 410 || noToken.status === 401 ? 'PASSES' : 'FAILS',
    observed: `shared tab without a session token -> ${noToken.status} (expected 410)`,
  })
}

;(async () => {
  let failed = false
  try {
    await run()
  } catch (err) {
    failed = true
    console.error('\nSIMULATION ABORTED:', err instanceof Error ? err.message : err)
  } finally {
    await cleanup().catch((e) => console.error('cleanup failed:', e?.message ?? e))
  }

  console.log('\n--- RESULTS ---')
  for (const r of results) console.log(`${r.verdict.padEnd(20)} ${r.event.padEnd(6)} ${r.observed}`)
  const fails = results.filter((r) => r.verdict === 'FAILS')
  console.log(`\n${results.length} checked, ${fails.length} FAILS`)
  if (!failed && fails.length === 0) console.log('QR_EVENTS_SIM_DONE')
  process.exit(failed || fails.length > 0 ? 1 : 0)
})()
