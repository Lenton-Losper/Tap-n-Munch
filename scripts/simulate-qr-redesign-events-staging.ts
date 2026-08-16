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
  terminalIds: [] as string[],
}

/**
 * Seed a scratch table, surviving debris from an earlier run.
 *
 * A previous run that aborted before `cleanup()` leaves its `restaurant_tables` row behind, and
 * the next run then dies on `restaurant_tables_restaurant_id_table_number_key` -- which is how
 * this run lost 18 of its 28 checks while still printing a reassuring summary. The collision is
 * an artefact of the harness, not a finding about the app, so it retries on a fresh number
 * rather than reusing the stale row: reusing it would inherit whatever state the aborted run
 * left on it, and a simulation that quietly starts from unknown state is worse than one that
 * stops.
 */
async function seedTable(tableNumber: number) {
  let candidate = tableNumber
  for (let attempt = 0; attempt < 8; attempt++) {
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
      created.tableIds.push(data.id)
      if (candidate !== tableNumber) {
        console.log(`  (table ${tableNumber} was occupied by earlier debris; using ${candidate})`)
      }
      return data
    }
    if (error.code !== '23505') {
      throw new Error(`seedTable(${candidate}) failed: ${error.message}`)
    }
    candidate = 9000 + Math.floor(Math.random() * 990)
  }
  throw new Error(`seedTable: 8 consecutive collisions starting at ${tableNumber}`)
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
    // `payment_events` has NO `order_id`. The column is `order_ids`, a uuid ARRAY -- one event
    // covers every order in a single settle. `.eq('order_id', id)` therefore matched nothing, and
    // matched nothing SILENTLY: PostgREST returns success for a filter on a column that does not
    // exist in the way you meant, so the cleanup reported a clean run while deleting zero rows.
    await admin.from('payment_events').delete().contains('order_ids', [id])
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
    for (const t of tabs ?? []) {
      await admin.from('customer_sessions').delete().eq('tab_id', t.id)
      // `payments.tab_id` has an FK to `tabs`. It was never cleaned, so every settle this
      // simulation performed left a row behind and the NEXT attempt to delete the tab died on
      // `payments_tab_id_fkey`. 35 rows had accumulated before anyone tried.
      await admin.from('payments').delete().eq('tab_id', t.id)
    }
    await admin.from('payments').delete().eq('table_id', id)
    await admin.from('tabs').delete().eq('table_id', id)
  }
  for (const id of created.tabIds) {
    await admin.from('customer_sessions').delete().eq('tab_id', id)
    await admin.from('payments').delete().eq('tab_id', id)
    await admin.from('tabs').delete().eq('id', id)
  }
  for (const id of created.tableIds) await admin.from('restaurant_tables').delete().eq('id', id)
  // Menu items last: an order line references one, so they cannot go before the orders.
  for (const id of created.menuItemIds) await admin.from('menu_items').delete().eq('id', id)
  for (const id of created.terminalIds) await admin.from('restaurant_terminals').delete().eq('id', id)
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

/**
 * My Orders, as the personal list reads it.
 *
 * The route is `/api/guest/orders/by-session` and it takes REPEATED `sessionId` params -- the
 * first version of this helper invented `/api/guest/orders?sessionIds=` and got a 404 that
 * looked like "this customer has no orders", which is the same class of false-empty the shared
 * tab had.
 */
async function readMyOrders(customer: Customer) {
  const q = new URLSearchParams({ restaurantId: RID, includeDeclined: '1' })
  q.append('sessionId', customer.sessionId)
  return api(`/api/guest/orders/by-session?${q.toString()}`)
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

    /**
     * B-money: the LINE FIGURES are what the customer pays (#293).
     *
     * The click test found "Beef Burger x1 - NAD82.61" printed above "NAD95.00", because the
     * grouping read each line's ex-VAT `subtotal`. Two independent assertions, because either
     * alone can pass while the screen is wrong:
     *
     *   1. every order's lines SUM to that order's own total -- catches the mixed basis;
     *   2. at least one line equals a MENU price exactly -- catches the case where lines and
     *      total are consistently wrong together, which assertion 1 would happily accept.
     *
     * It reports INCONCLUSIVE-AS-FAIL rather than passing on no data: "all 0 orders summed
     * correctly" proves nothing.
     */
    {
      const seen = (lentonSees.body?.members ?? []).flatMap((m: any) => m.orders ?? [])
      const menuPrices = menu.map((m: any) => Number(m.base_price))
      const mismatches: string[] = []
      let linesChecked = 0
      let matchedMenuPrice = false
      for (const o of seen) {
        const lines = Array.isArray(o?.lines) ? o.lines : []
        if (!lines.length) continue
        linesChecked += lines.length
        const sum = Math.round(lines.reduce((n: number, l: any) => n + Number(l?.total ?? 0), 0) * 100) / 100
        const target = Math.round(Number(o?.total ?? 0) * 100) / 100
        if (Math.abs(sum - target) > 0.01) {
          mismatches.push(`order ${o?.order_number ?? o?.id}: lines ${sum} vs total ${target}`)
        }
        for (const l of lines) {
          if (menuPrices.some((p) => Math.abs(Number(l?.total ?? 0) - p) < 0.01)) matchedMenuPrice = true
        }
      }
      const ok = linesChecked > 0 && mismatches.length === 0 && matchedMenuPrice
      record({
        event: 'B-money',
        verdict: ok ? 'PASSES' : 'FAILS',
        observed:
          linesChecked === 0
            ? 'INCONCLUSIVE-AS-FAIL: no order lines were returned, so "the lines add up" proves nothing'
            : ok
              ? `every line figure is tax-inclusive: ${linesChecked} lines across ${seen.length} orders sum to their own order totals, and at least one equals a menu price exactly`
              : `line figures are not what is charged. ${mismatches.join('; ') || 'sums agree'}` +
                `${matchedMenuPrice ? '' : ' | NO line equalled any menu price -- the ex-VAT basis (#293) looks like it is back'}`,
        detail: { linesChecked, mismatches, matchedMenuPrice },
      })
    }

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

  // ---- #249 / #248: the active-table count must match its own row path -----
  // Added after fixing both on 2026-08-16. The unit tests bind to the query; this is the only
  // thing that exercises the deployed route, which is what the landing screen actually calls.
  {
    const q = (extra: Record<string, string> = {}) => {
      const p = new URLSearchParams({ restaurantId: RID, table_number: String(tableNumber), ...extra })
      p.append('session_id', lenton.sessionId)
      return p.toString()
    }
    const rows = await api(`/api/guest/orders/active-table?${q()}`)
    const counted = await api(`/api/guest/orders/active-table?${q({ countOnly: '1' })}`)
    const rowLen = (rows.body?.orders ?? []).length
    const agree = counted.body?.count === rowLen
    /**
     * `count === rows` would pass VACUOUSLY at 0 = 0, proving nothing. The defect was that a
     * live order_request counted as zero, so the check only means something when there IS one --
     * and it must be a REQUEST, because an order alone was always counted correctly.
     */
    const requestPresent = (rows.body?.orders ?? []).some(
      (o: any) => o.surface === 'order_requests',
    )
    record({
      event: '#249',
      verdict: agree && requestPresent ? 'PASSES' : 'FAILS',
      observed:
        agree && requestPresent
          ? `active-table count matches its row path (${counted.body?.count} = ${rowLen}) AND a live order_request is among the rows -- the case that used to count as zero`
          : !requestPresent
            ? `INCONCLUSIVE-AS-FAIL: no order_request among the ${rowLen} rows, so count=${counted.body?.count} proves nothing`
            : `count ${counted.body?.count} disagrees with rows ${rowLen}`,
      detail: { count: counted.body?.count, rowLen, requestPresent, status: rows.status },
    })

    // #248: a payment-shaped question must not return a request, which has no payment channel.
    const filtered = await api(
      `/api/guest/orders/active-table?${q({ payment_status: 'pending', payment_channel: 'hosted' })}`,
    )
    const leakedRequest = (filtered.body?.orders ?? []).some(
      (o: any) => o.surface === 'order_requests',
    )
    record({
      event: '#248',
      verdict: leakedRequest ? 'FAILS' : 'PASSES',
      observed: leakedRequest
        ? 'a hosted-pending lookup returned an order_request, which has no payment channel'
        : 'a hosted-pending lookup returns no order_requests',
      detail: { returned: (filtered.body?.orders ?? []).length },
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

  // =========================================================================
  // SECOND TABLE — the events that need a live, unclosed tab.
  // The first table was deliberately closed to test N, and a closed tab refuses
  // everything below, so these run on their own fixture.
  // =========================================================================
  await runLiveTableEvents(menu)
}

/**
 * Events C, D, E, F, G, I, J, K, L, M, P — everything that needs a tab that is still open.
 */
async function runLiveTableEvents(menu: Array<{ id: string; name: string; base_price: number }>) {
  const tableNumber = 9200 + Math.floor(Math.random() * 300)
  const table = await seedTable(tableNumber)

  const started = await startTab(tableNumber, 'Ana')
  const ana = started.customer
  const tabId = started.tabId
  const pin = String(started.pin ?? '')

  // ---- C / M: three more phones join the same table ----------------------
  const joins = []
  for (const name of ['Bo', 'Cass', 'Dee']) {
    const j = await joinTab(tableNumber, name, pin)
    joins.push(j)
  }
  const allJoined = joins.every((j) => j.status === 200)
  record({
    event: 'C/M',
    verdict: allJoined ? 'PASSES' : 'FAILS',
    observed: allJoined
      ? 'four independent phones on one table via the PIN (C: group of four, M: late arrival)'
      : `a join was refused: ${joins.map((j) => j.status).join(',')}`,
  })
  const [bo, cass, dee] = joins.map((j) => j.customer)

  // Each orders something different, at different times.
  // Quantity 2 for Ana, so event D's reduction to 1 is a REAL movement rather than a no-op.
  await placeOrder(ana, tabId, tableNumber, [menu[0]], 2)
  await placeOrder(bo, tabId, tableNumber, [menu[1]])
  await placeOrder(cass, tabId, tableNumber, [menu[2]])

  const anaSees = await readSharedTab(ana, tabId)
  const deeSees = await readSharedTab(dee, tabId)
  const anaNames = (anaSees.body?.members ?? []).map((m: any) => m.display_name).sort()
  const deeSelf = (deeSees.body?.members ?? []).filter((m: any) => m.is_self)
  const collectiveOk = ['Ana', 'Bo', 'Cass'].every((n) => anaNames.includes(n))
  record({
    event: 'C',
    verdict: collectiveOk ? 'PASSES' : 'FAILS',
    observed: collectiveOk
      ? `Tab is collective: Ana sees [${anaNames}]; Dee, who has ordered nothing, sees the same table and has no group of her own (${deeSelf.length})`
      : `Tab is not collective: Ana sees [${anaNames}]`,
    detail: { anaNames, status: anaSees.status },
  })

  // My Orders must stay PERSONAL while the Tab is collective.
  const anaMine = await readMyOrders(ana)
  const deeMine = await readMyOrders(dee)
  const anaCount = (anaMine.body?.orders ?? []).length
  const deeCount = (deeMine.body?.orders ?? []).length
  record({
    event: 'B/C-personal',
    verdict: anaCount >= 1 && deeCount === 0 ? 'PASSES' : 'FAILS',
    observed:
      anaCount >= 1 && deeCount === 0
        ? `My Orders stays personal: Ana ${anaCount}, Dee (ordered nothing) ${deeCount}`
        : `My Orders is not personal: Ana ${anaCount}, Dee ${deeCount}`,
  })

  // ---- accept Ana's request so there is payable money on the tab ---------
  const { data: anaRequests } = await admin
    .from('order_requests')
    .select('id, status, total, subtotal, tax, items, session_id')
    .eq('tab_id', tabId)
    .eq('session_id', ana.sessionId)
  const anaRequestId = anaRequests?.[0]?.id

  /**
   * STAFF ACCEPT IS SET UP AS FIXTURE, NOT EXERCISED AS A ROUTE.
   *
   * `POST /api/order-requests/[id]/accept` answers 401 to this script: it requires a STAFF
   * session, which an unattended probe has no honest way to mint. Accepting is not what is
   * under test here -- it is the precondition for there being payable money on the tab at all,
   * which is what events H, J and K need.
   *
   * So the row is created directly, mirroring what the Accept route writes. This is labelled
   * everywhere it matters: A7 reports NEEDS-DEVICE because the staff Accept PATH is the human's
   * to click, while the events that depend on its RESULT still run.
   */
  let anaOrderId: string | null = null
  if (anaRequestId) {
    const req = anaRequests[0]
    const { data: orderRow, error: orderErr } = await admin
      .from('orders')
      .insert({
        restaurant_id: RID,
        tab_id: tabId,
        table_id: table.id,
        table_number: tableNumber,
        session_id: ana.sessionId,
        member_session_id: ana.sessionId,
        channel: 'table',
        status: 'accepted',
        payment_status: 'pending',
        // `items` is the load-bearing one: without it repriceKeptLines refuses every index and
        // event D fails with "Line 0 is not part of this order" -- a fixture defect that reads
        // exactly like a defect in the edit route.
        items: Array.isArray((req as any).items) ? (req as any).items : [],
        subtotal: Number((req as any).subtotal) || Number(req.total) || 0,
        tax: Number((req as any).tax) || 0,
        total: Number(req.total) || 0,
        placed_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (!orderErr && orderRow?.id) {
      anaOrderId = orderRow.id
      created.orderIds.push(anaOrderId)
      await admin.from('order_requests').update({ status: 'accepted' }).eq('id', anaRequestId)
    }
    // A second accepted order, belonging to a DIFFERENT diner, so J can settle one person's
    // share and K can settle what is left -- which is the whole point of events J and K.
    const { data: boRequests } = await admin
      .from('order_requests')
      .select('id, total, subtotal, tax, items')
      .eq('tab_id', tabId)
      .eq('session_id', bo.sessionId)
    const boReq = boRequests?.[0]
    if (boReq) {
      const { data: boOrder } = await admin
        .from('orders')
        .insert({
          restaurant_id: RID,
          tab_id: tabId,
          table_id: table.id,
          table_number: tableNumber,
          session_id: bo.sessionId,
          member_session_id: bo.sessionId,
          channel: 'table',
          status: 'accepted',
          payment_status: 'pending',
          items: Array.isArray((boReq as any).items) ? (boReq as any).items : [],
          subtotal: Number((boReq as any).subtotal) || Number(boReq.total) || 0,
          tax: Number((boReq as any).tax) || 0,
          total: Number(boReq.total) || 0,
          placed_at: new Date().toISOString(),
        })
        .select('id')
        .single()
      if (boOrder?.id) {
        created.orderIds.push(boOrder.id)
        await admin.from('order_requests').update({ status: 'accepted' }).eq('id', boReq.id)
      }
    }

    record({
      event: 'A7',
      verdict: 'NEEDS-DEVICE',
      observed: anaOrderId
        ? 'staff Accept requires a staff session, so the accepted order was seeded as fixture; the Accept ROUTE itself is the human click-test'
        : `could not seed an accepted order: ${orderErr?.message}`,
    })
  }

  // ---- H (on a live tab): pending and accepted side by side --------------
  const mixed = await readSharedTab(ana, tabId)
  const mixedTotals = mixed.body?.totals
  const hasBoth =
    mixedTotals && typeof mixedTotals.payable === 'number' && typeof mixedTotals.pending === 'number'
  const bothNonZero = hasBoth && mixedTotals.payable > 0 && mixedTotals.pending > 0
  record({
    event: 'H',
    verdict: bothNonZero ? 'PASSES' : hasBoth ? 'PASSES WITH CAVEAT' : 'FAILS',
    observed: hasBoth
      ? `payable ${mixedTotals.payable} and pending ${mixedTotals.pending} are separate figures` +
        (bothNonZero ? ' with an accepted order and unanswered ones visible together' : ' (one is zero — Accept may not have run)')
      : 'the shared tab did not return both figures',
    detail: mixedTotals,
  })

  // Per-order state must distinguish submitted from accepted.
  const anyPending = (mixed.body?.members ?? []).some((m: any) =>
    (m.orders ?? []).some((o: any) => o.is_pending === true),
  )
  const anyAccepted = (mixed.body?.members ?? []).some((m: any) =>
    (m.orders ?? []).some((o: any) => o.is_pending === false),
  )
  record({
    event: 'H-lines',
    verdict: anyPending && anyAccepted ? 'PASSES' : anyPending ? 'PASSES WITH CAVEAT' : 'FAILS',
    observed:
      anyPending && anyAccepted
        ? 'the same screen carries both a submitted order and an accepted one, each labelled'
        : `is_pending present: pending=${anyPending} accepted=${anyAccepted}`,
  })

  // ---- D / E / F: editing --------------------------------------------------
  const editTarget = anaOrderId ?? anaRequestId
  if (editTarget) {
    const acquire = await api(`/api/guest/orders/${editTarget}/edit`, {
      method: 'POST',
      body: JSON.stringify({ restaurantId: RID, sessionIds: [ana.sessionId] }),
    })
    if (acquire.status !== 200) {
      record({
        event: 'D',
        verdict: 'FAILS',
        observed: `could not open the editor: ${acquire.status} ${JSON.stringify(acquire.body).slice(0, 200)}`,
      })
    } else {
      const lockToken = acquire.body.lockToken

      // E: a SECOND customer must be refused. Bo did not place this order, so the edit route's
      // own ownership check should answer 404 -- not 403, which would confirm the order exists.
      const boTries = await api(`/api/guest/orders/${editTarget}/edit`, {
        method: 'POST',
        body: JSON.stringify({ restaurantId: RID, sessionIds: [bo.sessionId] }),
      })
      record({
        event: 'E',
        verdict: boTries.status === 404 ? 'PASSES' : boTries.status === 409 ? 'PASSES WITH CAVEAT' : 'FAILS',
        observed:
          boTries.status === 404
            ? "a non-owner gets 404 — the response does not confirm another diner's order exists"
            : `a non-owner got ${boTries.status} (${JSON.stringify(boTries.body?.reason ?? boTries.body?.error).slice(0, 120)})`,
      })

      // D: reduce, and the figure must move truthfully.
      const beforeView = await readTabView(ana, tabId)
      const commit = await api(`/api/guest/orders/${editTarget}/edit`, {
        method: 'PATCH',
        body: JSON.stringify({
          restaurantId: RID,
          sessionIds: [ana.sessionId],
          lockToken,
          keep: [{ index: 0, quantity: 1 }],
        }),
      })
      const afterView = await readTabView(ana, tabId)
      const before = Number(beforeView.body?.tab?.payable_total ?? 0) + Number(beforeView.body?.tab?.pending_total ?? 0)
      const after = Number(afterView.body?.tab?.payable_total ?? 0) + Number(afterView.body?.tab?.pending_total ?? 0)
      record({
        event: 'D',
        verdict: commit.status === 200 ? 'PASSES' : 'FAILS',
        observed:
          commit.status === 200
            ? `edit committed; tab total ${before} -> ${after}, requiresReacceptance=${commit.body?.requiresReacceptanceDecision} (a REDUCTION must not require it)`
            : `commit refused ${commit.status}: ${JSON.stringify(commit.body).slice(0, 200)}`,
        detail: { before, after, body: commit.body },
      })

      // The 2026-08-16 reversal, asserted on the live route: a reduction does NOT go back to review.
      if (commit.status === 200) {
        record({
          event: 'D-reversal',
          verdict: commit.body?.requiresReacceptanceDecision === false ? 'PASSES' : 'FAILS',
          observed:
            commit.body?.requiresReacceptanceDecision === false
              ? 'a reduction does not require re-acceptance (2026-08-16 ruling), and totalChanged still reports the movement: ' +
                String(commit.body?.totalChanged)
              : `a reduction still requires re-acceptance: ${JSON.stringify(commit.body).slice(0, 200)}`,
        })
      }

      // ---- D-add: the NEW capability. An edit may now ADD an item. ---------
      // Ruled 2026-08-16, overruling spec section 22. This is the half that did not exist, and
      // the half the audit warned about: the four sale controls all lived on POST /api/orders.
      if (anaOrderId) {
        const reAcquire = await api(`/api/guest/orders/${anaOrderId}/edit`, {
          method: 'POST',
          body: JSON.stringify({ restaurantId: RID, sessionIds: [ana.sessionId] }),
        })
        if (reAcquire.status !== 200) {
          record({
            event: 'D-add',
            verdict: 'FAILS',
            observed: `could not reopen the editor to add: ${reAcquire.status} ${JSON.stringify(reAcquire.body).slice(0, 160)}`,
          })
        } else {
          const beforeAdd = Number(
            (await readTabView(ana, tabId)).body?.tab?.payable_total ?? 0,
          )
          const addCommit = await api(`/api/guest/orders/${anaOrderId}/edit`, {
            method: 'PATCH',
            body: JSON.stringify({
              restaurantId: RID,
              sessionIds: [ana.sessionId],
              lockToken: reAcquire.body.lockToken,
              add: [
                {
                  menuItemId: menu[2].id,
                  name: menu[2].name,
                  displayName: menu[2].name,
                  quantity: 1,
                  // A deliberately absurd client price, to prove the server discards it.
                  basePrice: 0.01,
                  subtotal: 0.01,
                  selectedVariants: {},
                  size: null,
                  addons: [],
                  specialInstructions: '',
                },
              ],
            }),
          })
          const afterAdd = Number((await readTabView(ana, tabId)).body?.tab?.payable_total ?? 0)
          const rose = afterAdd > beforeAdd
          const pricedAtMenu = Math.abs(afterAdd - beforeAdd - Number(menu[2].base_price)) < 0.01
          record({
            event: 'D-add',
            verdict: addCommit.status === 200 && rose && pricedAtMenu ? 'PASSES' : addCommit.status === 200 ? 'PASSES WITH CAVEAT' : 'FAILS',
            observed:
              addCommit.status === 200
                ? `an item was ADDED to an existing order: payable ${beforeAdd} -> ${afterAdd} ` +
                  `(menu price ${menu[2].base_price}; client sent 0.01 and it was ${pricedAtMenu ? 'DISCARDED' : 'NOT discarded'}), ` +
                  `requiresReacceptance=${addCommit.body?.requiresReacceptanceDecision}`
                : `add refused ${addCommit.status}: ${JSON.stringify(addCommit.body).slice(0, 200)}`,
            detail: { beforeAdd, afterAdd, body: addCommit.body },
          })

          // The other half of the ruling: a RISE does require re-acceptance.
          if (addCommit.status === 200) {
            record({
              event: 'D-add-review',
              verdict: addCommit.body?.requiresReacceptanceDecision === true ? 'PASSES' : 'FAILS',
              observed:
                addCommit.body?.requiresReacceptanceDecision === true
                  ? 'an addition raises the total and DOES go back for staff re-acceptance (2026-08-16 ruling, second half)'
                  : `an addition did NOT require re-acceptance: ${JSON.stringify(addCommit.body).slice(0, 200)}`,
            })
            // Put it back so F and the settlement below are not blocked by `pending`.
            await admin.from('orders').update({ status: 'accepted' }).eq('id', anaOrderId)
          }
        }
      }

      // F: the kitchen wins. Move the order to preparing, then try to edit.
      if (anaOrderId) {
        await admin.from('orders').update({ status: 'preparing', edit_lock_token: null }).eq('id', anaOrderId)
        const afterKitchen = await api(`/api/guest/orders/${anaOrderId}/edit`, {
          method: 'POST',
          body: JSON.stringify({ restaurantId: RID, sessionIds: [ana.sessionId] }),
        })
        const humanReadable = String(afterKitchen.body?.error ?? '')
        const noJargon = !/token|lock|status|409/i.test(humanReadable) && /kitchen|prepar/i.test(humanReadable)
        record({
          event: 'F',
          verdict: afterKitchen.status === 409 && noJargon ? 'PASSES' : afterKitchen.status === 409 ? 'PASSES WITH CAVEAT' : 'FAILS',
          observed:
            afterKitchen.status === 409
              ? `editing closed once preparing, reason=${afterKitchen.body?.reason}, message="${humanReadable.slice(0, 90)}"` +
                (noJargon ? '' : ' — message may contain jargon')
              : `expected 409 once preparing, got ${afterKitchen.status}`,
        })
        // Put it back so J/K below have a settleable order.
        await admin.from('orders').update({ status: 'accepted' }).eq('id', anaOrderId)
      }
    }
  }

  // ---- G / P: order more is a NEW ticket, not a mutation -----------------
  const beforeCount = (await readMyOrders(ana)).body?.orders?.length ?? 0
  await placeOrder(ana, tabId, tableNumber, [menu[1]])
  const afterCount = (await readMyOrders(ana)).body?.orders?.length ?? 0
  record({
    event: 'G/P',
    verdict: afterCount > beforeCount ? 'PASSES' : 'FAILS',
    observed:
      afterCount > beforeCount
        ? `"order more" creates a new ticket rather than mutating the first: ${beforeCount} -> ${afterCount} orders for one customer`
        : `order count did not grow: ${beforeCount} -> ${afterCount}`,
  })

  // ---- I: ready to pay ----------------------------------------------------
  const ready = await api(`/api/tabs/${tabId}/ready-to-pay`, {
    method: 'POST',
    headers: ana.token ? { 'x-session-token': ana.token } : {},
    body: JSON.stringify({ restaurantId: RID, paymentPreference: 'card' }),
  })
  const { data: afterReady } = await admin.from('tabs').select('status, payment_preference, ready_to_pay_at').eq('id', tabId).maybeSingle()
  record({
    event: 'I',
    verdict: ready.status === 200 && afterReady?.status === 'ready_to_pay' ? 'PASSES' : 'FAILS',
    observed:
      ready.status === 200
        ? `Ready to pay writes tabs.status='${afterReady?.status}', preference='${afterReady?.payment_preference}' — it alerts staff, it does not charge`
        : `ready-to-pay returned ${ready.status}: ${JSON.stringify(ready.body).slice(0, 160)}`,
  })

  // ---- J / K: settlement, through the REAL terminal endpoints ------------
  await runTerminalSettlement(tabId, ana)
}

/**
 * EVENTS J and K, issued as the FlashTap terminal itself issues them.
 *
 * A throwaway terminal is seeded on staging and activated through
 * `POST /api/terminals/activate`, so the settle calls below carry a genuine terminal JWT and go
 * through `requireTerminalAuth` exactly as a device's would. That is as far as an agent can take
 * it: a real card on a real WiseCashier device is the human's, and the amount here is settled as
 * `cash` so no gateway is involved.
 *
 * What this DOES establish, which the QR-side audit could not: the settle route accepts an
 * `order_ids` ARRAY and binds it to the tab, so charging a SUBSET of a table's orders is
 * supported server-side. That is the financial reality the redesigned Tab has to reflect.
 */
async function runTerminalSettlement(tabId: string, customer: Customer) {
  const { data: unpaid } = await admin
    .from('orders')
    .select('id, total, payment_status')
    .eq('tab_id', tabId)
    .is('tab_settlement_for_tab_id', null)

  const settleable = (unpaid ?? []).filter((o) => ['pending', 'cash_pending', null].includes(o.payment_status as never))
  if (settleable.length === 0) {
    record({
      event: 'J/K',
      verdict: 'NOT RUN',
      observed:
        'no settleable orders on the tab — every submission was still an order_request, so nothing had been Accepted into `orders`. Needs a staff Accept to exercise.',
    })
    return
  }

  const activationCode = `SIM${Math.floor(100000 + Math.random() * 899999)}`
  const deviceSerial = `probe-sim-${randomUUID().slice(0, 8)}`
  const { data: terminal, error: termErr } = await admin
    .from('restaurant_terminals')
    .insert({
      restaurant_id: RID,
      terminal_name: `probe-sim-${deviceSerial}`,
      active: false,
      status: 'pending',
      activation_code: activationCode,
      activation_code_expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      device_id: `pending-${randomUUID()}`,
    })
    .select('id')
    .single()
  if (termErr || !terminal?.id) {
    record({ event: 'J/K', verdict: 'NOT RUN', observed: `could not seed a terminal: ${termErr?.message}` })
    return
  }
  created.terminalIds.push(terminal.id)

  const activate = await api('/api/terminals/activate', {
    method: 'POST',
    body: JSON.stringify({ code: activationCode, deviceId: deviceSerial, terminalSn: deviceSerial }),
  })
  const accessToken = activate.body?.accessToken
  if (activate.status !== 200 || !accessToken) {
    record({
      event: 'J/K',
      verdict: 'NOT RUN',
      observed: `terminal activation failed ${activate.status}: ${JSON.stringify(activate.body).slice(0, 200)}`,
    })
    return
  }

  const auth = { Authorization: `Bearer ${accessToken}` }

  // ---- J: charge ONE customer's orders, leaving a remaining balance ------
  const first = settleable[0]
  const jRes = await api(`/api/terminal/tabs/${tabId}/settle`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      order_ids: [first.id],
      amount: Number(first.total),
      method: 'cash',
      gateway_reference: `sim-${randomUUID().slice(0, 8)}`,
    }),
  })

  const afterJ = await readSharedTab(customer, tabId)
  const remaining = afterJ.body?.totals?.payable
  const stillListed = (afterJ.body?.members ?? []).some((m: any) =>
    (m.orders ?? []).some((o: any) => o.id === first.id),
  )
  record({
    event: 'J',
    verdict: jRes.status === 200 ? 'PASSES' : 'FAILS',
    observed:
      jRes.status === 200
        ? `terminal settled a SUBSET (1 of ${settleable.length} orders, N$${first.total}) with a real terminal JWT; ` +
          `QR tab now shows payable ${remaining}, and the paid order is ${stillListed ? 'still listed' : 'NO LONGER LISTED'}`
        : `subset settle returned ${jRes.status}: ${JSON.stringify(jRes.body).slice(0, 240)}`,
    detail: { status: jRes.status, remaining, stillListed },
  })

  // A partially settled tab must still SHOW the paid order (spec section 29) while not owing it.
  record({
    event: 'J-visible',
    verdict: jRes.status === 200 && stillListed ? 'PASSES' : jRes.status === 200 ? 'FAILS' : 'NOT RUN',
    observed:
      jRes.status !== 200
        ? 'not run — the settle above did not succeed'
        : stillListed
          ? 'the settled order remains visible on the shared tab and stops counting toward payable'
          : 'the settled order VANISHED from the shared tab — a partially settled tab should still read as one bill',
  })

  // ---- K: settle the remaining balance ----------------------------------
  const { data: stillUnpaid } = await admin
    .from('orders')
    .select('id, total, payment_status')
    .eq('tab_id', tabId)
    .is('tab_settlement_for_tab_id', null)
  const rest = (stillUnpaid ?? []).filter((o) => ['pending', 'cash_pending', null].includes(o.payment_status as never))

  if (rest.length === 0) {
    record({
      event: 'K',
      verdict: 'PASSES WITH CAVEAT',
      observed: 'nothing left to settle after J — the tab had a single settleable order, so whole-tab settlement is the same call',
    })
  } else {
    const kRes = await api(`/api/terminal/tabs/${tabId}/settle`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        order_ids: rest.map((o) => o.id),
        amount: rest.reduce((s, o) => s + Number(o.total), 0),
        method: 'cash',
        gateway_reference: `sim-${randomUUID().slice(0, 8)}`,
      }),
    })
    const afterK = await readSharedTab(customer, tabId)
    const { data: tabAfter } = await admin.from('tabs').select('status').eq('id', tabId).maybeSingle()
    record({
      event: 'K',
      verdict: kRes.status === 200 ? 'PASSES' : 'FAILS',
      observed:
        kRes.status === 200
          ? `whole remaining balance settled (${rest.length} orders); QR payable now ${afterK.body?.totals?.payable}, tabs.status='${tabAfter?.status}'`
          : `whole-tab settle returned ${kRes.status}: ${JSON.stringify(kRes.body).slice(0, 240)}`,
      detail: { status: kRes.status, tabStatus: tabAfter?.status },
    })

    // ---- L: paid is not closed -- the table may still order --------------
    record({
      event: 'L',
      verdict: tabAfter?.status && tabAfter.status !== 'closed' ? 'PASSES' : 'PASSES WITH CAVEAT',
      observed: `after full settlement the tab is '${tabAfter?.status}' — payment does not by itself end the visit`,
    })
  }
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
  // Never print a clean-looking tally after an abort. `process.exit(1)` and the withheld
  // QR_EVENTS_SIM_DONE sentinel were always correct, but a human -- or a background watcher
  // running `tail` -- reads this line, and "10 checked, 0 FAILS" after the run died at check
  // 11 is the summary telling a true number in a way that means the opposite of how it reads.
  console.log(
    failed
      ? `\nABORTED AFTER ${results.length} CHECKS -- ${fails.length} FAILS among those; the rest NEVER RAN. This is not a pass.`
      : `\n${results.length} checked, ${fails.length} FAILS`
  )
  if (!failed && fails.length === 0) console.log('QR_EVENTS_SIM_DONE')
  process.exit(failed || fails.length > 0 ? 1 : 0)
})()
