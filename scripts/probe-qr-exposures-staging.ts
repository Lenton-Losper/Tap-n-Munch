/**
 * Staging probe for the four QR customer-flow exposures, run against a LOCAL dev server
 * built from the branch under test -- not against the deployed worker.
 *
 *   A  QRA-18  PATCH /api/tabs/[tabId]/member has no auth and no restaurant scope
 *   B  QRA-02  POST /api/tabs mints a session token on the 23505 branch with no PIN
 *   C  QRA-19  POST /api/guest/orders/[id]/receipt/email passes auth on restaurant scope alone
 *   D  QRA-01  the edit lock refuses its own holder
 *
 * TWO-SIDED BY CONSTRUCTION. Every scenario asserts BOTH the exposure being closed AND a
 * control that must keep working. A fix that simply refuses everything fails the controls, so
 * "all green" cannot be reached by breaking the feature -- which is the failure mode a
 * one-sided auth probe invites.
 *
 * Run it BEFORE the fix and it reports EXPOSED with exit 1; run it after and it reports
 * CLOSED with exit 0. Both runs are the proof; neither alone is.
 *
 * WHY LOCAL AND NOT THE DEPLOYED WORKER. The point is to prove THIS branch. A probe pointed at
 * flashtap-staging.llosperofficial.workers.dev tests whatever was last deployed there, which is
 * the trap recorded for Playwright's baseURL -- a spec that passes with the bug reintroduced.
 *
 * WHY IT CANNOT TOUCH PRODUCTION. Two independent guards, both fatal:
 *   1. the service-role URL in this process must be the staging project ref;
 *   2. the SERVER under test must resolve the staging fixture restaurant. A server running on
 *      production credentials answers 404 to that and the probe aborts before writing anything.
 * The second guard exists because `.env.local` in this repository holds PRODUCTION credentials
 * and `next dev` loads it ahead of `.env.test` -- so "I copied the env files in" is exactly how
 * a probe ends up pointed at real customers.
 *
 * Scenario C never sends an email. It seeds an order that is `completed` but NOT `paid`, so the
 * route's own paid-check refuses at the step AFTER the authorization gate -- which makes the
 * gate observable (400 = auth passed, 404 = auth refused) with no delivery and no receipt issued.
 *
 * Marker: PROBE_QR_EXPOSURES_OK
 * Run:    npx tsx scripts/probe-qr-exposures-staging.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE = process.env.QR_PROBE_BASE || 'http://127.0.0.1:3101'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''

if (!url || !serviceKey) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
if (!url.includes(STAGING_REF)) {
  throw new Error(`GUARD 1 FAILED: refusing to run against ${url} -- not the staging project`)
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652' // "staging test"
const MENU_ITEM = { id: '9c4a176e-2eda-44e3-a0bc-b5fda4144403', name: 'Chicken burger', price: 25 }

type Result = {
  id: string
  title: string
  observed: string
  verdict: 'CLOSED' | 'EXPOSED' | 'CONTROL OK' | 'CONTROL BROKEN' | 'INCONCLUSIVE'
  detail?: unknown
}
const results: Result[] = []
const record = (r: Result) => {
  results.push(r)
  const tag = r.verdict.padEnd(14)
  console.log(`  ${tag} ${r.id}  ${r.observed}`)
}

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------
const created = { tableIds: [] as string[], tabIds: [] as string[], orderIds: [] as string[], requestIds: [] as string[] }

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
  // Leaves first: order_requests -> orders -> customer_sessions -> tabs -> restaurant_tables.
  // Discovered rather than trusted to the run's own list, because a route may have created
  // rows this script never saw (the Accept path issues receipts, the token routes insert
  // customer_sessions).
  for (const tabId of created.tabIds) {
    await admin.from('order_requests').delete().eq('tab_id', tabId)
    await admin.from('orders').delete().eq('tab_id', tabId)
    await admin.from('customer_sessions').delete().eq('tab_id', tabId)
  }
  for (const id of created.requestIds) await admin.from('order_requests').delete().eq('id', id)
  for (const id of created.orderIds) await admin.from('orders').delete().eq('id', id)
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
}

// ---------------------------------------------------------------------------
async function guardServerIsStaging(tableNumber: number) {
  const { status, body } = await api(
    `/api/tabs/active?restaurantId=${RID}&tableNumber=${tableNumber}`,
  )
  if (status === 404 || (body as { error?: string })?.error === 'Restaurant not found') {
    throw new Error(
      `GUARD 2 FAILED: the server at ${BASE} cannot resolve the staging fixture restaurant. ` +
        `It is not running on staging credentials. Aborting before any write.`,
    )
  }
  if (status !== 200) throw new Error(`GUARD 2 INCONCLUSIVE: /api/tabs/active -> ${status}`)
  console.log(`  guard 2 ok      server at ${BASE} resolves the staging restaurant`)
}

// ---------------------------------------------------------------------------
// A -- QRA-18
// ---------------------------------------------------------------------------
async function scenarioA(tableNumber: number) {
  console.log('\nA  QRA-18  PATCH /api/tabs/[tabId]/member')
  const hostSid = `probe-host-${randomUUID()}`
  const create = await api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber, sessionId: hostSid, displayName: 'Host' }),
  })
  if (create.status !== 200 || !create.body?.tabId) {
    record({ id: 'A0', title: 'seed tab', observed: `create tab -> ${create.status}`, verdict: 'INCONCLUSIVE', detail: create.body })
    return null
  }
  const tabId = String(create.body.tabId)
  created.tabIds.push(tabId)
  const hostToken = String(create.body.sessionToken || '')
  const tabPin = create.body.tabPin ? String(create.body.tabPin) : ''

  const nameNow = async () => {
    const { data } = await admin.from('tabs').select('members').eq('id', tabId).single()
    const m = (data?.members ?? []).find((x: { session_id?: string }) => x?.session_id === hostSid)
    return String(m?.display_name ?? '')
  }

  // A1 -- the exposure: no token at all.
  const before = await nameNow()
  const noAuth = await api(`/api/tabs/${tabId}/member`, {
    method: 'PATCH',
    body: JSON.stringify({ sessionId: hostSid, displayName: 'PWNED-NOAUTH' }),
  })
  const afterNoAuth = await nameNow()
  record({
    id: 'A1',
    title: 'rename with no session token',
    observed: `status=${noAuth.status} display_name ${before} -> ${afterNoAuth}`,
    verdict: afterNoAuth === 'PWNED-NOAUTH' ? 'EXPOSED' : 'CLOSED',
  })

  // A2 -- the exposure: a token for a DIFFERENT tab (cross-tab / cross-tenant shape).
  const otherTable = await seedTable(tableNumber + 1)
  const otherSid = `probe-other-${randomUUID()}`
  const otherCreate = await api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber: otherTable.table_number, sessionId: otherSid, displayName: 'Other' }),
  })
  if (otherCreate.status === 200 && otherCreate.body?.tabId) created.tabIds.push(String(otherCreate.body.tabId))
  const otherToken = String(otherCreate.body?.sessionToken || '')

  const beforeX = await nameNow()
  const crossTab = await api(`/api/tabs/${tabId}/member`, {
    method: 'PATCH',
    headers: { 'x-session-token': otherToken },
    body: JSON.stringify({ sessionId: hostSid, displayName: 'PWNED-CROSSTAB' }),
  })
  const afterX = await nameNow()
  record({
    id: 'A2',
    title: 'rename with another tab’s token',
    observed: `status=${crossTab.status} display_name ${beforeX} -> ${afterX}`,
    verdict: afterX === 'PWNED-CROSSTAB' ? 'EXPOSED' : 'CLOSED',
  })

  // A3 -- CONTROL: the legitimate owner must still be able to rename.
  const legit = await api(`/api/tabs/${tabId}/member`, {
    method: 'PATCH',
    headers: { 'x-session-token': hostToken },
    body: JSON.stringify({ restaurantId: RID, sessionId: hostSid, displayName: 'Renamed OK' }),
  })
  const afterLegit = await nameNow()
  record({
    id: 'A3',
    title: 'CONTROL owner renames with a valid token',
    observed: `status=${legit.status} display_name -> ${afterLegit}`,
    verdict: legit.status === 200 && afterLegit === 'Renamed OK' ? 'CONTROL OK' : 'CONTROL BROKEN',
    detail: legit.body,
  })

  return { tabId, hostSid, hostToken, tabPin, tableNumber }
}

// ---------------------------------------------------------------------------
// B -- QRA-02 / QRA-03
// ---------------------------------------------------------------------------
async function scenarioB(ctx: { tabId: string; tabPin: string; tableNumber: number }) {
  console.log('\nB  QRA-02/03  POST /api/tabs 23505 recovery branch')
  const intruderSid = `probe-intruder-${randomUUID()}`

  // B1 -- the exposure: create against an occupied table, no PIN supplied.
  const noPin = await api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber: ctx.tableNumber, sessionId: intruderSid, displayName: 'Intruder' }),
  })
  const mintedToken = String(noPin.body?.sessionToken || '')
  record({
    id: 'B1',
    title: 'create tab on an occupied table with no PIN',
    observed: `status=${noPin.status} code=${noPin.body?.code ?? '-'} sessionToken=${mintedToken ? 'MINTED' : 'none'} "${noPin.body?.error ?? ''}"`,
    // The code matters as much as the refusal: the landing opens the PIN prompt on it.
    verdict: mintedToken || noPin.body?.code !== 'TAB_PIN_REQUIRED' ? 'EXPOSED' : 'CLOSED',
  })

  // B2 -- the chain QRA-03: what that token reads. Only meaningful while B1 is EXPOSED.
  //
  // GET /api/orders reads `orders`, and a QR submission lives in `order_requests` until staff
  // Accept -- so the tab has no `orders` row yet. Seeding one directly is a faithful stand-in
  // for Accept (which is what creates it) and avoids needing staff credentials in a probe.
  const victimSid = `probe-victim-session-${randomUUID()}`
  if (mintedToken) {
    const { data: seeded } = await admin
      .from('orders')
      .insert({
        restaurant_id: RID,
        tab_id: ctx.tabId,
        table_number: ctx.tableNumber,
        session_id: victimSid,
        member_session_id: victimSid,
        status: 'accepted',
        payment_status: 'pending',
        subtotal: 25,
        tax: 0,
        total: 25,
        items: [{ name: MENU_ITEM.name, quantity: 1, unitPrice: 25, subtotal: 25, tax: 0, total: 25 }],
        placed_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (seeded?.id) created.orderIds.push(seeded.id)

    const leak = await api(`/api/orders?tabId=${ctx.tabId}&restaurantId=${RID}`, {
      headers: { 'x-session-token': mintedToken },
    })
    const leaked = JSON.stringify(leak.body).includes(victimSid)
    record({
      id: 'B2',
      title: 'QRA-03 chain: read the tab’s orders with the minted token',
      observed: `status=${leak.status} another diner's raw session_id readable=${leaked}`,
      verdict: leak.status === 200 && leaked ? 'EXPOSED' : 'CLOSED',
    })
  } else {
    record({ id: 'B2', title: 'QRA-03 chain', observed: 'no token was minted, chain closed at the root', verdict: 'CLOSED' })
  }

  // B3 -- the exposure: a WRONG PIN must not mint.
  const wrongPin = await api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber: ctx.tableNumber, sessionId: `probe-wrong-${randomUUID()}`, pin: '0000', displayName: 'Wrong' }),
  })
  record({
    id: 'B3',
    title: 'create tab on an occupied table with a WRONG PIN',
    observed: `status=${wrongPin.status} code=${wrongPin.body?.code ?? '-'} sessionToken=${wrongPin.body?.sessionToken ? 'MINTED' : 'none'} "${wrongPin.body?.error ?? ''}"`,
    verdict:
      wrongPin.body?.sessionToken || wrongPin.body?.code !== 'TAB_PIN_INCORRECT' ? 'EXPOSED' : 'CLOSED',
  })

  // B4 -- CONTROL: the CORRECT PIN is the sanctioned recovery and must still work.
  const rightSid = `probe-joiner-${randomUUID()}`
  const rightPin = await api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber: ctx.tableNumber, sessionId: rightSid, pin: ctx.tabPin, displayName: 'Joiner' }),
  })
  const okToken = String(rightPin.body?.sessionToken || '')
  let joinedAsMember = false
  if (okToken) {
    const { data } = await admin.from('tabs').select('members').eq('id', ctx.tabId).single()
    joinedAsMember = (data?.members ?? []).some((m: { session_id?: string }) => m?.session_id === rightSid)
  }
  record({
    id: 'B4',
    title: 'CONTROL create tab with the CORRECT PIN still joins',
    observed: `status=${rightPin.status} sessionToken=${okToken ? 'minted' : 'none'} addedToMembers=${joinedAsMember}`,
    verdict: okToken ? 'CONTROL OK' : 'CONTROL BROKEN',
    detail: rightPin.body?.error ?? rightPin.body?.code,
  })

  // B5 -- CONTROL: creating on a FREE table is untouched.
  const freeTable = await seedTable(ctx.tableNumber + 2)
  const freeCreate = await api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber: freeTable.table_number, sessionId: `probe-free-${randomUUID()}`, displayName: 'Fresh' }),
  })
  if (freeCreate.status === 200 && freeCreate.body?.tabId) created.tabIds.push(String(freeCreate.body.tabId))
  record({
    id: 'B5',
    title: 'CONTROL create tab on a FREE table',
    observed: `status=${freeCreate.status} tabPin=${freeCreate.body?.tabPin ? 'returned' : 'none'} sessionToken=${freeCreate.body?.sessionToken ? 'minted' : 'none'}`,
    verdict: freeCreate.status === 200 && freeCreate.body?.sessionToken ? 'CONTROL OK' : 'CONTROL BROKEN',
    detail: freeCreate.body?.error,
  })
}

// ---------------------------------------------------------------------------
// C -- QRA-19
// ---------------------------------------------------------------------------
async function scenarioC(tableNumber: number) {
  console.log('\nC  QRA-19  POST /api/guest/orders/[id]/receipt/email')
  const ownerSid = `probe-receipt-owner-${randomUUID()}`

  // status='completed' short-circuits guestCanAccessOrder, payment_status stays unpaid so the
  // route refuses AFTER the auth gate. Nothing is issued and nothing is emailed either way.
  const { data: order, error } = await admin
    .from('orders')
    .insert({
      restaurant_id: RID,
      table_number: tableNumber,
      session_id: ownerSid,
      member_session_id: ownerSid,
      status: 'completed',
      payment_status: 'pending',
      subtotal: 25,
      tax: 0,
      total: 25,
      items: [{ name: MENU_ITEM.name, quantity: 1, unitPrice: 25, subtotal: 25, tax: 0, total: 25 }],
      placed_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) {
    record({ id: 'C0', title: 'seed order', observed: `insert failed: ${error.message}`, verdict: 'INCONCLUSIVE' })
    return
  }
  created.orderIds.push(order.id)

  const email = 'qr-probe-noreply@example.invalid'

  // C1 -- the exposure: no session id, no table number. Restaurant scope alone.
  const anon = await api(`/api/guest/orders/${order.id}/receipt/email?restaurantId=${RID}`, {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  record({
    id: 'C1',
    title: 'email receipt with restaurant scope alone',
    observed: `status=${anon.status} "${anon.body?.error ?? ''}"`,
    // 400 = it got PAST the auth gate and stopped on the paid-check. 404 = auth refused.
    verdict: anon.status === 400 ? 'EXPOSED' : anon.status === 404 ? 'CLOSED' : 'INCONCLUSIVE',
  })

  // C2 -- CONTROL: the owning session must still reach the gate.
  const owner = await api(
    `/api/guest/orders/${order.id}/receipt/email?restaurantId=${RID}&session_id=${encodeURIComponent(ownerSid)}`,
    { method: 'POST', body: JSON.stringify({ email }) },
  )
  record({
    id: 'C2',
    title: 'CONTROL owning session reaches the paid-check',
    observed: `status=${owner.status} "${owner.body?.error ?? ''}"`,
    verdict: owner.status === 400 ? 'CONTROL OK' : 'CONTROL BROKEN',
  })

  // C3 -- CONTROL: the table the order sits at must still reach the gate.
  const table = await api(
    `/api/guest/orders/${order.id}/receipt/email?restaurantId=${RID}&table_number=${tableNumber}`,
    { method: 'POST', body: JSON.stringify({ email }) },
  )
  record({
    id: 'C3',
    title: 'CONTROL same-table caller reaches the paid-check',
    observed: `status=${table.status} "${table.body?.error ?? ''}"`,
    verdict: table.status === 400 ? 'CONTROL OK' : 'CONTROL BROKEN',
  })
}

// ---------------------------------------------------------------------------
// D -- QRA-01
// ---------------------------------------------------------------------------
async function scenarioD(ctx: { tabId: string; hostSid: string; hostToken: string; tableNumber: number }) {
  console.log('\nD  QRA-01  customer edit lock')
  const place = await api('/api/orders', {
    method: 'POST',
    headers: { 'x-session-token': ctx.hostToken, 'x-idempotency-key': randomUUID() },
    body: JSON.stringify({
      restaurantId: RID,
      tableNumber: ctx.tableNumber,
      sessionId: ctx.hostSid,
      memberSessionId: ctx.hostSid,
      tabId: ctx.tabId,
      items: [
        {
          menuItemId: MENU_ITEM.id,
          name: MENU_ITEM.name,
          displayName: MENU_ITEM.name,
          quantity: 2,
          basePrice: MENU_ITEM.price,
          selectedVariants: {},
          size: null,
          addons: [],
          specialInstructions: '',
          subtotal: MENU_ITEM.price * 2,
        },
      ],
      subtotal: MENU_ITEM.price * 2,
      total: MENU_ITEM.price * 2,
      orderInstructions: '',
    }),
  })
  if (place.status !== 200 || !place.body?.orderId) {
    record({ id: 'D0', title: 'place order', observed: `status=${place.status} ${JSON.stringify(place.body).slice(0, 160)}`, verdict: 'INCONCLUSIVE' })
    return
  }
  const requestId = String(place.body.orderId)
  created.requestIds.push(requestId)

  const acquire = await api(`/api/guest/orders/${requestId}/edit`, {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, sessionIds: [ctx.hostSid, `probe-second-id-${randomUUID()}`] }),
  })
  if (acquire.status !== 200 || !acquire.body?.lockToken) {
    record({ id: 'D1', title: 'acquire the edit lock', observed: `status=${acquire.status} ${acquire.body?.reason ?? acquire.body?.error ?? ''}`, verdict: 'INCONCLUSIVE' })
    return
  }
  const { data: locked } = await admin
    .from('order_requests')
    .select('edit_lock_session_id')
    .eq('id', requestId)
    .single()
  record({
    id: 'D1',
    title: 'acquire stores a scalar holder',
    observed: `edit_lock_session_id=${JSON.stringify(locked?.edit_lock_session_id)}`,
    verdict: String(locked?.edit_lock_session_id ?? '').startsWith('[') ? 'EXPOSED' : 'CLOSED',
  })

  const commit = await api(`/api/guest/orders/${requestId}/edit`, {
    method: 'PATCH',
    body: JSON.stringify({
      restaurantId: RID,
      sessionIds: [ctx.hostSid, `probe-second-id-${randomUUID()}`],
      lockToken: acquire.body.lockToken,
      keep: [{ index: 0, quantity: 1 }],
    }),
  })
  const { data: after } = await admin
    .from('order_requests')
    .select('total_customer, customer_edit_count')
    .eq('id', requestId)
    .single()
  record({
    id: 'D2',
    title: 'the holder commits its own edit',
    observed: `status=${commit.status} reason=${commit.body?.reason ?? '-'} total_customer=${after?.total_customer ?? '-'} edits=${after?.customer_edit_count ?? 0}`,
    verdict: commit.status === 200 && Number(after?.customer_edit_count) === 1 ? 'CLOSED' : 'EXPOSED',
  })
}

// ---------------------------------------------------------------------------
async function main() {
  const base = 9200 + Math.floor(Math.random() * 300)
  console.log(`=== QR exposure probe -- server ${BASE}, staging ${STAGING_REF}, tables ${base}..${base + 2} ===\n`)
  try {
    const table = await seedTable(base)
    await guardServerIsStaging(table.table_number)

    const ctxA = await scenarioA(table.table_number)
    if (ctxA) {
      // D before B on purpose: B2 proves the QRA-03 chain by reading the tab's orders with the
      // token B1 minted, and an empty tab makes that read indistinguishable from a refusal.
      await scenarioD(ctxA)
      await scenarioB(ctxA)
    }
    await scenarioC(table.table_number)
  } finally {
    await cleanup()
    console.log('\n  fixture cleaned up')
  }

  const exposed = results.filter((r) => r.verdict === 'EXPOSED')
  const broken = results.filter((r) => r.verdict === 'CONTROL BROKEN')
  const unknown = results.filter((r) => r.verdict === 'INCONCLUSIVE')

  console.log('\n=== SUMMARY ===')
  console.log(`  exposed:      ${exposed.length}  ${exposed.map((r) => r.id).join(' ') || '-'}`)
  console.log(`  controls bad: ${broken.length}  ${broken.map((r) => r.id).join(' ') || '-'}`)
  console.log(`  inconclusive: ${unknown.length}  ${unknown.map((r) => r.id).join(' ') || '-'}`)
  for (const r of [...exposed, ...broken, ...unknown]) {
    if (r.detail !== undefined) console.log(`    ${r.id} detail: ${JSON.stringify(r.detail).slice(0, 200)}`)
  }

  if (exposed.length === 0 && broken.length === 0 && unknown.length === 0) {
    console.log('\nPROBE_QR_EXPOSURES_OK')
    process.exit(0)
  }
  process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
