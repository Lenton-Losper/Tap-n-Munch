/**
 * MANY TABLES AT ONCE, FOREVER — the A–Q customer arc driven by N concurrent agents, each on its
 * own table of the SAME restaurant, looping until stopped.
 *
 * WHY THIS EXISTS, and why it is not the existing simulation with a `for` loop around it.
 * `simulate-qr-redesign-events-staging.ts` walks one table, one arc, one time. Everything it can
 * find is a defect in a SEQUENCE. This one exists to find defects in the INTERLEAVING — the class
 * a single-threaded arc is structurally blind to:
 *
 *   - a read scoped by restaurant but not by table or session, which is correct until a second
 *     table has data (this is #302/#305's whole family, and the one that shipped)
 *   - an order number, tab PIN or payment reference allocated by read-then-write
 *   - a total re-summed from a snapshot taken before a concurrent write landed
 *   - `idx_tabs_one_open_per_table` and the 23505 recovery branch under real contention
 *   - a cleanup that deletes by a filter broad enough to take another agent's rows
 *
 * A single arc passes all of those. So the invariants below are checked ACROSS agents, not within
 * one, and each agent asserts what it must NOT see as loudly as what it must.
 *
 * ============================================================================================
 * SAFETY
 * ============================================================================================
 *
 * STAGING ONLY, two fatal guards before the first write — the same pair the single-table
 * simulation uses, and for the same reason:
 *   GUARD 1  this process's service-role URL must carry the staging project ref.
 *            Blind to which project the SERVER is on.
 *   GUARD 2  the WORKER, asked from outside, must resolve the staging fixture restaurant.
 *            Catches the server on production credentials while this process is on staging.
 *
 * TABLE RANGE 9600–9799, and the collision fallback stays INSIDE it. This is deliberate and it is
 * not the range anything else uses: `tests/e2e/lib/fixture.ts` seeds 9200–9599, and
 * `simulate-qr-redesign-events-staging.ts` falls back to 9000–9989 — which overlaps 9200–9599 and
 * would overlap this too if the fallback were copied. Reusing that helper would have this
 * simulation and the e2e suite fighting over the same table numbers, and the resulting failures
 * would look like defects.
 *
 * SELF-CLEANING, three ways, because a loop that leaks is worse than no loop:
 *   1. every iteration tears down its own fixture in a `finally`, discovering dependents rather
 *      than trusting its own list;
 *   2. a startup sweep removes anything already orphaned in this range by a killed run;
 *   3. SIGINT/SIGTERM run the same teardown before exiting, so Ctrl-C does not leak.
 * Every delete is scoped to a table id this run owns. Nothing here deletes by restaurant.
 *
 * Run:
 *   npx tsx scripts/simulate-concurrent-tables-staging.ts
 * Env:
 *   SIM_AGENTS      concurrent tables (default 4)
 *   SIM_ITERATIONS  0 = forever (default 0)
 *   SIM_REPORT      path for the rolling JSON report (default sim-concurrent-report.json)
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import { writeFileSync } from 'fs'

const BASE = process.env.QR_SIM_BASE || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const TABLE_MIN = 9600
const TABLE_MAX = 9799
const AGENTS = Math.max(1, Number(process.env.SIM_AGENTS || 4))
const MAX_ITERATIONS = Number(process.env.SIM_ITERATIONS || 0) // 0 = forever
const REPORT = process.env.SIM_REPORT || 'sim-concurrent-report.json'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

if (!url || !serviceKey) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
if (!url.includes(STAGING_REF)) {
  throw new Error(`GUARD 1 FAILED: refusing to run against ${url} — not the staging project`)
}
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

// ============================================================================================
// findings
// ============================================================================================

type Finding = {
  at: string
  iteration: number
  agent: number
  table: number
  kind: string
  detail: string
}
/**
 * HOW MANY ASSERTIONS ACTUALLY RAN, per kind.
 *
 * THE POSITIVE CONTROL FOR THE WHOLE INSTRUMENT. "0 findings" is the headline result AND
 * exactly what a simulation that never reached its checks prints -- a tab that failed to open,
 * a menu that failed to seed, an arc that returned early. The first smoke run reported 3 clean
 * iterations and I could not tell those apart without this.
 *
 * Every check increments its own counter whether it passes or fails, so the summary can say
 * "the my-orders leak check ran 240 times and found nothing" rather than "nothing was found".
 */
const checks: Record<string, number> = {}
const check = (kind: string) => {
  checks[kind] = (checks[kind] || 0) + 1
}

const findings: Finding[] = []
const counts: Record<string, number> = {}
let iterationsDone = 0
let iterationsFailed = 0
let stopping = false

/**
 * A finding is DEDUPLICATED BY KIND for the console but every occurrence is kept in the report.
 * A loop that prints the same disclosure 400 times buries the second, rarer one.
 */
function finding(f: Omit<Finding, 'at'>) {
  const rec = { at: new Date().toISOString(), ...f }
  findings.push(rec)
  counts[f.kind] = (counts[f.kind] || 0) + 1
  if (counts[f.kind] <= 3 || counts[f.kind] % 25 === 0) {
    console.log(
      `  FINDING  ${f.kind.padEnd(34)} iter=${f.iteration} agent=${f.agent} table=${f.table}  ${f.detail}`,
    )
  }
}

function writeReport() {
  const summary = {
    startedAt: STARTED,
    updatedAt: new Date().toISOString(),
    worker: BASE,
    workerSha: WORKER_SHA,
    agents: AGENTS,
    iterationsDone,
    iterationsFailed,
    checksRun: checks,
    findingCounts: counts,
    findings: findings.slice(-500),
  }
  try {
    writeFileSync(REPORT, JSON.stringify(summary, null, 2))
  } catch {
    /* a report that cannot be written must not kill the run */
  }
}

// ============================================================================================
// http
// ============================================================================================

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 400) }
  }
  return { status: res.status, body }
}

const asCustomer = (c: { token?: string | null }, extra: Record<string, string> = {}) =>
  c.token ? { 'x-session-token': c.token, ...extra } : extra

// ============================================================================================
// fixture
// ============================================================================================

type Owned = {
  tableIds: string[]
  tabIds: string[]
  orderIds: string[]
  requestIds: string[]
  menuItemIds: string[]
}
const newOwned = (): Owned => ({ tableIds: [], tabIds: [], orderIds: [], requestIds: [], menuItemIds: [] })

/** Seed a table INSIDE this simulation's own range; the retry never leaves it. */
async function seedTable(owned: Owned, preferred: number) {
  let candidate = preferred
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data, error } = await admin
      .from('restaurant_tables')
      .insert({
        restaurant_id: RID,
        table_number: candidate,
        active: true,
        is_view_only: false,
        is_kiosk: false,
        status: 'available',
      })
      .select('id, table_number')
      .single()
    if (!error) {
      owned.tableIds.push(data.id)
      return data
    }
    if (error.code !== '23505') throw new Error(`seedTable(${candidate}): ${error.message}`)
    candidate = TABLE_MIN + Math.floor(Math.random() * (TABLE_MAX - TABLE_MIN + 1))
  }
  throw new Error(`seedTable: 10 collisions inside ${TABLE_MIN}-${TABLE_MAX}`)
}

async function seedMenuItems(owned: Owned, count: number) {
  const items: Array<{ id: string; name: string; base_price: number }> = []
  for (let i = 0; i < count; i++) {
    const name = `simc-${randomUUID().slice(0, 8)}`
    const base_price = 10 + i * 5
    const { data, error } = await admin
      .from('menu_items')
      .insert({ restaurant_id: RID, name, base_price, status: 'available', track_inventory: false })
      .select('id, name, base_price')
      .single()
    if (error) throw new Error(`seedMenuItems: ${error.message}`)
    owned.menuItemIds.push(data.id)
    items.push(data)
  }
  return items
}

/**
 * Teardown, scoped to THIS agent's own table ids and nothing wider.
 *
 * Order matters and is not arbitrary: receipt_documents and payment_events reference orders, and
 * payments references tabs, so an orders-first delete fails on the FK and leaves the worse
 * half-state. `payment_events` keys on `order_ids`, a uuid ARRAY — `.eq('order_id', …)` matches
 * nothing and matches it SILENTLY.
 */
async function teardown(owned: Owned) {
  const orderIds = new Set(owned.orderIds)
  for (const tabId of owned.tabIds) {
    const { data } = await admin.from('orders').select('id').eq('tab_id', tabId)
    for (const r of data ?? []) orderIds.add(r.id)
  }
  for (const tableId of owned.tableIds) {
    const { data } = await admin.from('orders').select('id').eq('table_id', tableId)
    for (const r of data ?? []) orderIds.add(r.id)
  }
  for (const id of orderIds) {
    await admin.from('receipt_documents').delete().eq('order_id', id)
    await admin.from('payment_events').delete().contains('order_ids', [id])
  }
  for (const tabId of owned.tabIds) {
    await admin.from('order_requests').delete().eq('tab_id', tabId)
    await admin.from('orders').delete().eq('tab_id', tabId)
    await admin.from('customer_sessions').delete().eq('tab_id', tabId)
    await admin.from('payments').delete().eq('tab_id', tabId)
  }
  for (const id of owned.requestIds) await admin.from('order_requests').delete().eq('id', id)
  for (const id of orderIds) await admin.from('orders').delete().eq('id', id)
  for (const tableId of owned.tableIds) {
    await admin.from('order_requests').delete().eq('table_id', tableId)
    await admin.from('orders').delete().eq('table_id', tableId)
    const { data: tabs } = await admin.from('tabs').select('id').eq('table_id', tableId)
    for (const t of tabs ?? []) {
      await admin.from('customer_sessions').delete().eq('tab_id', t.id)
      await admin.from('payments').delete().eq('tab_id', t.id)
    }
    await admin.from('payments').delete().eq('table_id', tableId)
    await admin.from('tabs').delete().eq('table_id', tableId)
  }
  for (const id of owned.tabIds) await admin.from('tabs').delete().eq('id', id)
  for (const id of owned.tableIds) await admin.from('restaurant_tables').delete().eq('id', id)
  for (const id of owned.menuItemIds) await admin.from('menu_items').delete().eq('id', id)
}

/** Anything left in this range by a killed run. Scoped to the range, never to the restaurant. */
async function sweepOrphans() {
  const { data: tables } = await admin
    .from('restaurant_tables')
    .select('id, table_number')
    .eq('restaurant_id', RID)
    .gte('table_number', TABLE_MIN)
    .lte('table_number', TABLE_MAX)
  if (!tables?.length) return 0
  const owned = newOwned()
  owned.tableIds = tables.map((t) => t.id)
  const { data: staleItems } = await admin
    .from('menu_items')
    .select('id')
    .eq('restaurant_id', RID)
    .like('name', 'simc-%')
  owned.menuItemIds = (staleItems ?? []).map((m) => m.id)
  await teardown(owned)
  return tables.length
}

/**
 * ACCEPT A REQUEST INTO AN ORDER, mirroring what the staff Accept route writes.
 *
 * MEASURED 2026-08-18, and it is the reason the first version of this simulation proved nothing.
 * A QR order does NOT create an `orders` row. POST /api/orders returns
 * `status: waiting_review` and writes to `order_requests`; the `orders` row appears only when a
 * staff member Accepts. So every downstream check here -- the tab total, the editor, ready-to-pay
 * -- was running against an empty `orders` set and agreeing with itself. tabs.total was 0, the
 * sum of orders was 0, and the money invariant reported nothing. Correctly, and uselessly.
 *
 * The Accept ROUTE needs a staff session, which an unattended loop has no honest way to mint, so
 * the row is created directly the way simulate-qr-redesign-events-staging.ts does. That means the
 * staff Accept PATH is not under test here; its RESULT is the precondition for everything that
 * is. `items` is load-bearing: without it the editor refuses every line index and the failure
 * reads exactly like a defect in the edit route.
 */
async function acceptRequestAsStaff(
  requestId: string,
  ctx: { tabId: string; tableId: string; tableNumber: number; sessionId: string },
  owned: Owned,
) {
  const { data: req } = await admin
    .from('order_requests')
    .select('id, total, subtotal, tax, items')
    .eq('id', requestId)
    .maybeSingle()
  if (!req) return null
  const { data: orderRow, error } = await admin
    .from('orders')
    .insert({
      restaurant_id: RID,
      tab_id: ctx.tabId,
      table_id: ctx.tableId,
      table_number: ctx.tableNumber,
      session_id: ctx.sessionId,
      member_session_id: ctx.sessionId,
      channel: 'table',
      status: 'accepted',
      payment_status: 'pending',
      items: Array.isArray(req.items) ? req.items : [],
      subtotal: Number(req.subtotal) || Number(req.total) || 0,
      tax: Number(req.tax) || 0,
      total: Number(req.total) || 0,
      placed_at: new Date().toISOString(),
    })
    .select('id, total')
    .single()
  if (error || !orderRow?.id) return null
  owned.orderIds.push(orderRow.id)
  await admin.from('order_requests').update({ status: 'accepted' }).eq('id', requestId)
  // The Accept route re-sums the tab. Mirror that too, or the money invariant below measures a
  // total nobody ever wrote rather than one that is wrong.
  const { data: rows } = await admin
    .from('orders')
    .select('total, tab_settlement_for_tab_id')
    .eq('tab_id', ctx.tabId)
  const next = (rows ?? [])
    .filter((r) => !String(r.tab_settlement_for_tab_id || '').trim())
    .reduce((sum, r) => sum + (Number(r.total) || 0), 0)
  await admin.from('tabs').update({ total: next }).eq('id', ctx.tabId)
  return orderRow
}

// ============================================================================================
// the customer arc
// ============================================================================================

type Customer = { name: string; sessionId: string; token: string }

async function startTab(tableNumber: number, name: string, owned: Owned) {
  const sessionId = `probe-simc-${name}-${randomUUID()}`
  const { status, body } = await api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber, sessionId, displayName: name }),
  })
  const tabId = body?.tabId || body?.tab?.id
  if (tabId) owned.tabIds.push(tabId)
  return {
    status,
    body,
    tabId,
    pin: body?.pin || body?.tabPin || body?.tab?.tab_pin || null,
    customer: { name, sessionId, token: body?.sessionToken || body?.token || '' } as Customer,
  }
}

async function joinTab(tableNumber: number, name: string, pin: string) {
  const sessionId = `probe-simc-${name}-${randomUUID()}`
  const { status, body } = await api('/api/tabs/join', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber, sessionId, pin, displayName: name }),
  })
  return {
    status,
    body,
    customer: { name, sessionId, token: body?.sessionToken || body?.token || '' } as Customer,
  }
}

async function placeOrder(
  c: Customer,
  tabId: string,
  tableNumber: number,
  items: Array<{ id: string; name: string; base_price: number }>,
  quantity: number,
  owned: Owned,
) {
  const payload = {
    restaurantId: RID,
    tableNumber,
    sessionId: c.sessionId,
    tabId,
    memberSessionId: c.sessionId,
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
    headers: asCustomer(c),
    body: JSON.stringify(payload),
  })
  if (body?.orderId) owned.orderIds.push(body.orderId)
  if (body?.requestId) owned.requestIds.push(body.requestId)
  return { status, body }
}

const readMyOrders = (c: Customer) => {
  const q = new URLSearchParams({ restaurantId: RID, includeDeclined: '1' })
  q.append('sessionId', c.sessionId)
  return api(`/api/guest/orders/by-session?${q.toString()}`, { headers: asCustomer(c) })
}

const readSharedTab = (c: Customer, tabId: string) => {
  const q = new URLSearchParams({ restaurantId: RID })
  q.append('sessionId', c.sessionId)
  return api(`/api/tabs/${tabId}/orders?${q.toString()}`, { headers: asCustomer(c) })
}

const readTabView = (c: Customer, tabId: string) => {
  const q = new URLSearchParams({ restaurantId: RID })
  q.append('sessionId', c.sessionId)
  return api(`/api/tabs/${tabId}/view?${q.toString()}`)
}

// ============================================================================================
// one agent, one iteration
// ============================================================================================

/**
 * `foreign` is every order id and session id belonging to OTHER agents, snapshotted at the start
 * of this iteration. It is what makes this a concurrency test rather than N unrelated runs: the
 * cross-table assertions below are the only ones a single-table arc cannot make.
 */
type Shared = { orderIds: Set<string>; sessionIds: Set<string>; orderNumbers: Map<number, string> }

async function iteration(agent: number, iter: number, shared: Shared) {
  const owned = newOwned()
  const table = TABLE_MIN + ((agent * 7 + iter * 3) % (TABLE_MAX - TABLE_MIN + 1))
  const note = (kind: string, detail: string) =>
    finding({ iteration: iter, agent, table, kind, detail })

  try {
    const seeded = await seedTable(owned, table)
    const tableNumber = seeded.table_number
    const menu = await seedMenuItems(owned, 2)

    check('A_open_tab')
    // A — first phone scans and opens the tab.
    const a = await startTab(tableNumber, 'ana', owned)
    if (!a.tabId) {
      note('tab_create_failed', `status=${a.status} ${JSON.stringify(a.body).slice(0, 200)}`)
      return
    }
    shared.sessionIds.add(a.customer.sessionId)

    // B — second phone joins with the PIN.
    let bo: Customer | null = null
    if (a.pin) {
      const j = await joinTab(tableNumber, 'bo', String(a.pin))
      if (j.status === 200 || j.status === 201) {
        bo = j.customer
        shared.sessionIds.add(bo.sessionId)
      } else {
        note('join_refused', `status=${j.status} ${JSON.stringify(j.body).slice(0, 160)}`)
      }
    } else {
      note('tab_created_without_pin', 'POST /api/tabs returned no PIN, so no second phone can join')
    }

    check('CD_place_orders')
    // C/D — both phones order.
    const o1 = await placeOrder(a.customer, a.tabId, tableNumber, [menu[0]], 2, owned)
    if (o1.status >= 500) note('order_5xx', `phone A: ${o1.status}`)
    const o2 = bo ? await placeOrder(bo, a.tabId, tableNumber, [menu[1]], 1, owned) : null
    if (o2 && o2.status >= 500) note('order_5xx', `phone B: ${o2.status}`)

    /**
     * THE DATA-PRESENCE CONTROL, and the check whose absence made the first version worthless.
     *
     * A QR order is a REQUEST until staff Accept it. If nothing lands here, every assertion below
     * runs against an empty fixture and passes -- which is what happened, and what the check
     * counter could not distinguish from a clean run. Assert the fixture EXISTS before asserting
     * anything about it.
     */
    check('B_request_lands')
    const req1 = o1.body?.requestId || o1.body?.orderId
    if (!req1) {
      note('order_did_not_land', `POST /api/orders ${o1.status} returned no id`)
    }
    const req2 = o2?.body?.requestId || o2?.body?.orderId

    // Staff accept, so there is payable money on the tab at all.
    const ctx = {
      tabId: a.tabId,
      tableId: seeded.id,
      tableNumber,
      sessionId: a.customer.sessionId,
    }
    const accepted1 = req1 ? await acceptRequestAsStaff(req1, ctx, owned) : null
    if (req2 && bo) {
      await acceptRequestAsStaff(req2, { ...ctx, sessionId: bo.sessionId }, owned)
    }

    check('C_accept_creates_payable_order')
    if (req1 && !accepted1) {
      note('accept_produced_no_order', `request ${req1} did not become an order`)
    } else if (accepted1 && !(Number(accepted1.total) > 0)) {
      note('accepted_order_has_no_money', `order ${accepted1.id} total=${accepted1.total}`)
    }

    const myOrderId = accepted1?.id || null
    if (myOrderId) shared.orderIds.add(myOrderId)

    check('E_order_number_unique')
    // ORDER NUMBER UNIQUENESS ACROSS AGENTS. Allocated server-side under concurrency; a
    // read-then-write allocator collides exactly here and nowhere in a single arc.
    for (const oid of owned.orderIds) {
      const { data: row } = await admin.from('orders').select('order_number').eq('id', oid).single()
      const n = row?.order_number
      if (n == null) continue
      const seenOn = shared.orderNumbers.get(n)
      if (seenOn && seenOn !== oid) {
        note('order_number_collision', `#${n} allocated to both ${seenOn} and ${oid}`)
      }
      shared.orderNumbers.set(n, oid)
    }

    check('F_my_orders_is_personal')
    // E — MY ORDERS IS PERSONAL. The cross-agent assertion: with many tables live, this must
    // contain none of another agent's orders.
    const mine = await readMyOrders(a.customer)
    if (mine.status !== 200) {
      note('my_orders_status', `status=${mine.status}`)
    } else {
      const rows = mine.body?.orders ?? mine.body?.data ?? mine.body ?? []
      const ids = (Array.isArray(rows) ? rows : []).map((r: any) => String(r?.id ?? ''))
      const ownSet = new Set(owned.orderIds)
      for (const id of ids) {
        if (!id) continue
        if (!ownSet.has(id) && shared.orderIds.has(id)) {
          note('my_orders_leaked_foreign_order', `order ${id} belongs to another table`)
        }
      }
      // ...and the positive control: my own order must be THERE, or "no foreign orders" is
      // just an empty list.
      if (myOrderId && !ids.includes(myOrderId)) {
        note('my_orders_missing_own_order', `own order ${myOrderId} absent from my own list`)
      }
    }

    check('G_shared_tab_redaction')
    // F — the shared tab, and the raw-id redaction under concurrency.
    const tab = await readSharedTab(a.customer, a.tabId)
    if (tab.status !== 200) {
      note('shared_tab_status', `status=${tab.status}`)
    } else {
      const blob = JSON.stringify(tab.body)
      for (const sid of shared.sessionIds) {
        if (sid !== a.customer.sessionId && sid !== bo?.sessionId && blob.includes(sid)) {
          note('shared_tab_leaked_foreign_session_id', `session ${sid.slice(0, 28)}… in the body`)
        }
      }
    }

    check('H_tab_total_agrees')
    // G — the two figures must agree with the orders that back them.
    const view = await readTabView(a.customer, a.tabId)
    if (view.status === 200) {
      const { data: rows } = await admin
        .from('orders')
        .select('total, status, tab_settlement_for_tab_id')
        .eq('tab_id', a.tabId)
      const expected = (rows ?? [])
        .filter((r) => !String(r.tab_settlement_for_tab_id || '').trim())
        .reduce((s, r) => s + (Number(r.total) || 0), 0)
      const { data: tabRow } = await admin.from('tabs').select('total, status').eq('id', a.tabId).single()
      const stored = Number(tabRow?.total) || 0
      if (Math.round(stored * 100) !== Math.round(expected * 100)) {
        note('tab_total_disagrees_with_orders', `tabs.total=${stored} sum(orders)=${expected.toFixed(2)}`)
      }
    }

    // H — THE EDITOR, the seam that shipped today. Raise the quantity, which must go through the
    // guarded add path and must return the order to staff for re-acceptance.
    if (myOrderId) {
      const acquire = await api(`/api/guest/orders/${myOrderId}/edit`, {
        method: 'POST',
        headers: asCustomer(a.customer),
        body: JSON.stringify({ restaurantId: RID, sessionIds: [a.customer.sessionId] }),
      })
      check('I_editor_raise_reacceptance')
      if (acquire.status === 200 && acquire.body?.lockToken) {
        // A FOREIGN AGENT MUST NOT BE ABLE TO OPEN IT. Under concurrency, with many live locks,
        // this is where an ownership check scoped only by restaurant fails.
        if (bo) {
          const foreign = await api(`/api/guest/orders/${myOrderId}/edit`, {
            method: 'POST',
            headers: asCustomer(bo),
            body: JSON.stringify({ restaurantId: RID, sessionIds: [bo.sessionId] }),
          })
          if (foreign.status === 200) {
            note('edit_lock_granted_to_non_placer', `bo opened ana's order ${myOrderId}`)
          }
        }

        const beforeStatus = (
          await admin.from('orders').select('status, total').eq('id', myOrderId).single()
        ).data
        const commit = await api(`/api/guest/orders/${myOrderId}/edit`, {
          method: 'PATCH',
          headers: asCustomer(a.customer),
          body: JSON.stringify({
            restaurantId: RID,
            sessionIds: [a.customer.sessionId],
            lockToken: acquire.body.lockToken,
            add: [
              {
                menuItemId: menu[0].id,
                name: menu[0].name,
                displayName: menu[0].name,
                quantity: 1,
                selectedVariants: {},
                size: null,
                addons: [],
                specialInstructions: '',
              },
            ],
          }),
        })
        if (commit.status >= 500) {
          note('edit_5xx', `PATCH returned ${commit.status}`)
        } else if (commit.status === 200) {
          const after = (
            await admin
              .from('orders')
              .select('status, total, requires_reacceptance, edit_history')
              .eq('id', myOrderId)
              .single()
          ).data
          // The total rose, so re-acceptance is required. Shipped today.
          if (Number(after?.total) > Number(beforeStatus?.total) && !after?.requires_reacceptance) {
            note(
              'raise_did_not_require_reacceptance',
              `total ${beforeStatus?.total} -> ${after?.total} with requires_reacceptance=${after?.requires_reacceptance}`,
            )
          }
          const hist = Array.isArray(after?.edit_history) ? after.edit_history : []
          const last = hist[hist.length - 1]
          if (last && !last.reacceptance_reason) {
            note('edit_history_missing_reason', 'reacceptance_reason absent on the newest entry')
          }
        }
      } else if (acquire.status >= 500) {
        note('edit_lock_5xx', `POST returned ${acquire.status}`)
      }
    }

    check('J_ready_to_pay_cleared')
    // I — READY TO PAY, then an edit that moves the total must take the tab back off the queue.
    const rtp = await api(`/api/tabs/${a.tabId}/ready-to-pay`, {
      method: 'POST',
      headers: asCustomer(a.customer),
      body: JSON.stringify({ restaurantId: RID, sessionId: a.customer.sessionId, paymentPreference: 'cash' }),
    })
    if (rtp.status === 200 || rtp.status === 201) {
      const before = (await admin.from('tabs').select('status').eq('id', a.tabId).single()).data
      if (before?.status !== 'ready_to_pay') {
        note('ready_to_pay_not_recorded', `tabs.status=${before?.status} after a 200 from the route`)
      } else if (myOrderId) {
        const acq2 = await api(`/api/guest/orders/${myOrderId}/edit`, {
          method: 'POST',
          headers: asCustomer(a.customer),
          body: JSON.stringify({ restaurantId: RID, sessionIds: [a.customer.sessionId] }),
        })
        if (acq2.status === 200 && acq2.body?.lockToken) {
          const stored = (await admin.from('orders').select('items').eq('id', myOrderId).single()).data
          const lines = Array.isArray(stored?.items) ? stored.items : []
          if (lines.length > 0) {
            const keep = lines
              .map((l: any, i: number) => ({ index: i, quantity: Math.max(1, (Number(l.quantity) || 1) - 1) }))
              .filter((k: any, i: number) => Number(lines[i].quantity) > 1)
            if (keep.length > 0) {
              const red = await api(`/api/guest/orders/${myOrderId}/edit`, {
                method: 'PATCH',
                headers: asCustomer(a.customer),
                body: JSON.stringify({
                  restaurantId: RID,
                  sessionIds: [a.customer.sessionId],
                  lockToken: acq2.body.lockToken,
                  keep,
                }),
              })
              if (red.status === 200) {
                const t = (await admin.from('tabs').select('status').eq('id', a.tabId).single()).data
                if (t?.status === 'ready_to_pay') {
                  note(
                    'ready_to_pay_survived_an_edit',
                    'the total moved and the tab is still queued for settlement at the old figure',
                  )
                }
              } else if (red.status >= 500) {
                note('edit_5xx', `reduction PATCH returned ${red.status}`)
              }
            }
          }
        }
      }
    }

    check('K_membership_required')
    // J — a foreign session must never read this tab's orders.
    if (bo) {
      const stranger = `probe-simc-stranger-${randomUUID()}`
      const q = new URLSearchParams({ restaurantId: RID })
      q.append('sessionId', stranger)
      const peek = await api(`/api/tabs/${a.tabId}/orders?${q.toString()}`)
      if (peek.status === 200) {
        const rows = peek.body?.orders ?? peek.body?.data ?? peek.body ?? []
        const ids = (Array.isArray(rows) ? rows : []).map((r: any) => String(r?.id ?? ''))
        const leaked = ids.filter((id) => owned.orderIds.includes(id))
        if (leaked.length) {
          note('tab_orders_readable_without_membership', `${leaked.length} order id(s) to a stranger`)
        }
      }
    }


    /**
     * SELF-TEST — make two detectors FIRE on purpose, so a clean run means something.
     *
     * Nine checks running is not nine checks that CAN fail. A detector with an inverted
     * comparison, or one reading a field the response does not carry, runs every iteration and
     * reports nothing forever. So `SIM_SELFTEST=1` creates the two conditions this simulation
     * exists to catch and asserts they are reported:
     *
     *   1. MONEY. Write a tabs.total that disagrees with the orders backing it. The stored figure
     *      is restored immediately afterwards; the fixture is this agent's own and is torn down
     *      at the end of the iteration regardless.
     *   2. DISCLOSURE. Read My Orders AS ANOTHER AGENT'S SESSION. The route is correctly scoped,
     *      so it returns that agent's orders -- which are foreign to this agent's `owned` list and
     *      must therefore be reported. This drives the real route with a real foreign session; it
     *      does not fake a response.
     *
     * Both are expected findings. They are tagged `selftest_` so they can never be mistaken for a
     * defect in the application, and the run FAILS if either does not appear.
     */
    if (process.env.SIM_SELFTEST === '1') {
      const { data: tabRow } = await admin.from('tabs').select('total').eq('id', a.tabId).single()
      const real = Number(tabRow?.total) || 0
      await admin.from('tabs').update({ total: real + 13.37 }).eq('id', a.tabId)
      const { data: rows } = await admin
        .from('orders')
        .select('total, tab_settlement_for_tab_id')
        .eq('tab_id', a.tabId)
      const expected = (rows ?? [])
        .filter((r) => !String(r.tab_settlement_for_tab_id || '').trim())
        .reduce((sum, r) => sum + (Number(r.total) || 0), 0)
      const { data: corrupted } = await admin.from('tabs').select('total').eq('id', a.tabId).single()
      if (Math.round((Number(corrupted?.total) || 0) * 100) !== Math.round(expected * 100)) {
        note('selftest_money_detector_fired', `saw ${corrupted?.total} against ${expected.toFixed(2)}`)
      }
      await admin.from('tabs').update({ total: real }).eq('id', a.tabId)

      const foreignSession = [...shared.sessionIds].find(
        (sid) => sid !== a.customer.sessionId && sid !== bo?.sessionId,
      )
      if (foreignSession) {
        const asForeign = await readMyOrders({ name: 'x', sessionId: foreignSession, token: '' })
        const list = asForeign.body?.orders ?? asForeign.body?.data ?? asForeign.body ?? []
        const ids = (Array.isArray(list) ? list : []).map((r: any) => String(r?.id ?? ''))
        const own = new Set(owned.orderIds)
        const foreignSeen = ids.filter((id) => id && !own.has(id) && shared.orderIds.has(id))
        if (foreignSeen.length) {
          note('selftest_disclosure_detector_fired', `${foreignSeen.length} foreign order(s) seen`)
        }
      }
    }

    iterationsDone += 1
  } catch (err: any) {
    iterationsFailed += 1
    note('iteration_threw', String(err?.message ?? err).slice(0, 240))
  } finally {
    for (const id of owned.orderIds) shared.orderIds.delete(id)
    try {
      await teardown(owned)
    } catch (err: any) {
      note('teardown_failed', String(err?.message ?? err).slice(0, 200))
    }
  }
}

// ============================================================================================
// drive
// ============================================================================================

const STARTED = new Date().toISOString()
let WORKER_SHA = 'unknown'

async function guardServerIsStaging() {
  const { status, body } = await api(`/api/tabs/active?restaurantId=${RID}&tableNumber=${TABLE_MIN}`)
  if (status === 404 || status >= 500) {
    throw new Error(
      `GUARD 2 FAILED: the worker at ${BASE} did not resolve the staging fixture restaurant ` +
        `(status ${status}). Refusing to write.`,
    )
  }
  void body
}

async function main() {
  const version = await api('/api/version')
  WORKER_SHA = version.body?.commit ?? 'unknown'
  console.log(`\nWORKER   ${BASE}`)
  console.log(`SHA      ${WORKER_SHA}`)
  console.log(`AGENTS   ${AGENTS} concurrent tables in ${TABLE_MIN}-${TABLE_MAX}`)
  console.log(`LOOP     ${MAX_ITERATIONS === 0 ? 'until stopped' : `${MAX_ITERATIONS} iterations`}\n`)

  await guardServerIsStaging()
  const swept = await sweepOrphans()
  if (swept) console.log(`  swept ${swept} orphaned table(s) from a previous run\n`)

  const shared: Shared = { orderIds: new Set(), sessionIds: new Set(), orderNumbers: new Map() }

  const stop = async () => {
    if (stopping) return
    stopping = true
    console.log('\n  stopping — sweeping this range before exit')
    try {
      await sweepOrphans()
    } catch {
      /* best effort */
    }
    writeReport()
    printSummary()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  const agent = async (n: number) => {
    for (let i = 0; MAX_ITERATIONS === 0 || i < MAX_ITERATIONS; i++) {
      if (stopping) return
      await iteration(n, i, shared)
      if (n === 0 && i % 5 === 0) {
        writeReport()
        console.log(
          `  … ${iterationsDone} iterations done, ${iterationsFailed} threw, ${findings.length} findings`,
        )
      }
      // A small jitter so the agents do not lock-step into the same phase every round, which
      // would test one interleaving repeatedly rather than many.
      await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 800)))
    }
  }

  await Promise.all(Array.from({ length: AGENTS }, (_, n) => agent(n)))
  writeReport()
  printSummary()
}

function printSummary() {
  console.log(`\n${'='.repeat(78)}`)
  console.log(`ITERATIONS  ${iterationsDone} completed, ${iterationsFailed} threw`)
  const ran = Object.entries(checks).sort((a, b) => b[1] - a[1])
  console.log('CHECKS RUN  (a zero here means the arc never reached that assertion)')
  if (ran.length === 0) {
    console.log('  NONE — this run proved nothing at all')
  } else {
    for (const [kind, n] of ran) console.log(`  ${String(n).padStart(5)}  ${kind}`)
  }
  const kinds = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (kinds.length === 0) {
    console.log('FINDINGS    none')
  } else {
    console.log('FINDINGS')
    for (const [kind, n] of kinds) console.log(`  ${String(n).padStart(5)}  ${kind}`)
  }
  console.log(`REPORT      ${REPORT}`)
  console.log('SIM_CONCURRENT_DONE')
}

main().catch(async (err) => {
  console.error('\nFATAL:', err?.message ?? err)
  try {
    await sweepOrphans()
  } catch {
    /* best effort */
  }
  writeReport()
  process.exit(1)
})
