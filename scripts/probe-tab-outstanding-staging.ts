/**
 * Staging probe: ONE authoritative tab total, on a two-diner tab — the case that was wrong.
 *
 * The defect (#119 / QRA-12): /tab summed the orders THIS DEVICE could see, and
 * fetchGuestOrdersBySession is session-scoped by construction, so on a shared tab the figure
 * under "Full tab running total" was roughly half the truth. QRA-15 compounded it: nothing
 * re-summed tabs.total when an order was cancelled, and the cache had two live definitions.
 *
 * This asserts the seam every customer surface now reads — GET /api/tabs/[tabId]/view — against
 * a tab built from TWO sessions, and against the four states that decide whether money is owed.
 *
 * TWO-SIDED. It asserts the authoritative figure is right AND that it is not simply echoing the
 * cache: the cache is deliberately poisoned to a wrong value first, so a regression that reads
 * `tabs.total` again fails rather than coincidentally passing.
 *
 * Guards, both fatal, per the operating contract's PROBES THAT WRITE:
 *   1. this process's service-role URL must be the staging ref;
 *   2. the SERVER under test must resolve the staging fixture restaurant.
 *
 * Marker: PROBE_TAB_OUTSTANDING_OK
 * Run:    npx tsx scripts/probe-tab-outstanding-staging.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE = process.env.QR_PROBE_BASE || 'http://127.0.0.1:3101'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url || !serviceKey) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
if (!url.includes(STAGING_REF)) throw new Error(`GUARD 1 FAILED: ${url} is not staging`)

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const created = { tableIds: [] as string[], tabIds: [] as string[], orderIds: [] as string[] }
let failures = 0

function check(id: string, expected: unknown, actual: unknown, note: string) {
  const ok = expected === actual
  if (!ok) failures++
  console.log(`  ${(ok ? 'OK' : 'FAIL').padEnd(6)} ${id}  expected=${expected} actual=${actual}  ${note}`)
}

async function cleanup() {
  for (const id of created.orderIds) await admin.from('orders').delete().eq('id', id)
  for (const id of created.tabIds) {
    await admin.from('orders').delete().eq('tab_id', id)
    await admin.from('customer_sessions').delete().eq('tab_id', id)
    await admin.from('tabs').delete().eq('id', id)
  }
  for (const id of created.tableIds) {
    await admin.from('orders').delete().eq('table_id', id)
    await admin.from('tabs').delete().eq('table_id', id)
    await admin.from('restaurant_tables').delete().eq('id', id)
  }
}

async function view(tabId: string) {
  const res = await fetch(`${BASE}/api/tabs/${tabId}/view?restaurantId=${RID}`, { cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  return body?.tab ?? {}
}

async function main() {
  const tableNumber = 9600 + Math.floor(Math.random() * 300)
  console.log(`=== one authoritative tab total — server ${BASE}, table ${tableNumber} ===\n`)

  const { data: table, error: tErr } = await admin
    .from('restaurant_tables')
    .insert({ restaurant_id: RID, table_number: tableNumber, active: true, is_view_only: false, is_kiosk: false, status: 'available' })
    .select('id, table_number')
    .single()
  if (tErr) throw new Error(`seed table failed: ${tErr.message}`)
  created.tableIds.push(table.id)

  // GUARD 2 — before any further write.
  const g = await fetch(`${BASE}/api/tabs/active?restaurantId=${RID}&tableNumber=${tableNumber}`)
  if (g.status === 404) throw new Error('GUARD 2 FAILED: server is not on staging credentials')
  console.log(`  guard 2 ok   server resolves the staging fixture\n`)

  const sidA = `probe-diner-a-${randomUUID()}`
  const sidB = `probe-diner-b-${randomUUID()}`

  const create = await fetch(`${BASE}/api/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RID, tableNumber, sessionId: sidA, displayName: 'A' }),
  })
  const tab = await create.json()
  if (!tab?.tabId) throw new Error(`create tab failed: ${JSON.stringify(tab).slice(0, 200)}`)
  created.tabIds.push(tab.tabId)

  // Two diners, four money states. Seeded directly so the states are exact.
  const seed = async (sid: string, total: number, payment_status: string, status = 'accepted') => {
    const { data, error } = await admin
      .from('orders')
      .insert({
        restaurant_id: RID, tab_id: tab.tabId, table_number: tableNumber,
        session_id: sid, member_session_id: sid, status, payment_status,
        subtotal: total, tax: 0, total,
        items: [{ name: 'probe', quantity: 1, unitPrice: total, subtotal: total, tax: 0, total }],
        placed_at: new Date().toISOString(),
      })
      .select('id').single()
    if (error) throw new Error(`seed order failed: ${error.message}`)
    created.orderIds.push(data.id)
  }

  await seed(sidA, 100, 'pending')    // A owes 100
  await seed(sidB, 150, 'pending')    // B owes 150   <- invisible to A's device before the fix
  await seed(sidA, 60, 'paid')        // already settled
  await seed(sidB, 40, 'cancelled')   // QRA-15: never owed

  // Poison the cache so a regression that reads tabs.total cannot pass by coincidence.
  await admin.from('tabs').update({ total: 99999 }).eq('id', tab.tabId)

  console.log('two diners, four money states; tabs.total poisoned to 99999\n')

  const t = await view(tab.tabId)
  check('T1', 250, t.outstanding_total, 'A(100 pending) + B(150 pending); paid and cancelled excluded')
  check('T2', 99999, Number(t.total), 'the cache is still returned for staff, and is NOT the figure')
  check('T3', true, t.outstanding_total !== Number(t.total), 'authoritative figure is not the cache')

  // The whole point: the answer does not depend on who is asking.
  const asA = await fetch(`${BASE}/api/tabs/${tab.tabId}/view?restaurantId=${RID}&sessionId=${encodeURIComponent(sidA)}`)
  const asB = await fetch(`${BASE}/api/tabs/${tab.tabId}/view?restaurantId=${RID}&sessionId=${encodeURIComponent(sidB)}`)
  const a = (await asA.json())?.tab ?? {}
  const b = (await asB.json())?.tab ?? {}
  check('T4', 250, a.outstanding_total, 'diner A sees the WHOLE table')
  check('T5', 250, b.outstanding_total, 'diner B sees the same number')
  check('T6', true, a.outstanding_total === b.outstanding_total, 'two devices, one answer (INV-8)')

  // QRA-15 directly: cancelling drops the money with no re-sum anywhere.
  const { data: toCancel } = await admin
    .from('orders').select('id').eq('tab_id', tab.tabId).eq('payment_status', 'pending').limit(1).single()
  await admin.from('orders').update({ payment_status: 'cancelled', status: 'cancelled' }).eq('id', toCancel.id)
  const afterCancel = await view(tab.tabId)
  check('T7', true, afterCancel.outstanding_total < 250, 'a cancelled order stops being owed immediately (QRA-15)')
  check('T8', 99999, Number(afterCancel.total), 'and the cache is still stale — which no longer matters')

  console.log(`\n=== ${failures === 0 ? 'PROBE_TAB_OUTSTANDING_OK' : failures + ' FAILURES'} ===`)
}

main()
  .catch((e) => { console.error(e); failures++ })
  .finally(async () => {
    await cleanup()
    console.log('  fixture cleaned up')
    process.exit(failures === 0 ? 0 : 1)
  })
