/**
 * #318 END TO END ON STAGING: does the device see "someone asked to pay and money remains"
 * AFTER a real partial settle?
 *
 * This is the sequence the human will drive by hand on a device. Everything below the UI is
 * exercised for real:
 *
 *   1. seed a table, a tab in `ready_to_pay`, and TWO unpaid orders
 *   2. pair a terminal the way pairing actually works — write an activation code, then POST the
 *      REAL /api/terminals/activate to mint a REAL bearer token
 *   3. settle exactly ONE order through the REAL settle route
 *   4. GET /api/terminal/tables as the device, and evaluate the device's own expression against
 *      the real response body
 *
 * WHY NOT WRITE THE ROWS WITH THE SERVICE-ROLE KEY AND CALL IT DONE: that would skip the settle
 * route's own logic — the claim check, the amount comparison, clearReadyToPayAndReopenTab — and
 * `ready_to_pay_at` surviving is a PROPERTY OF THAT HELPER. Asserting it without running the
 * helper would be testing the fixture.
 *
 * WHAT THIS STILL DOES NOT PROVE: that the chip renders. That is React Native on a physical
 * device and no server-side probe reaches it. It proves the DATA the chip reads, and evaluates
 * the exact boolean the screen computes. Stated so the result is not over-read.
 *
 * Staging only, self-cleaning.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE = process.env.QR_SIM_BASE || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error(`GUARD: ${url || '(unset)'} is not staging`)
const admin = createClient(url, key, { auth: { persistSession: false } })

async function api(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text.slice(0, 220) } }
  return { status: res.status, body }
}

/** The exact expression src/screens/TablesScreen.tsx computes. */
const deviceSaysReadyToPay = (tab: any) =>
  tab?.status === 'ready_to_pay' || (tab?.ready_to_pay_at != null && (tab?.unpaid_total ?? 0) > 0)

async function main() {
  const v = await api('/api/version')
  console.log(`\nWORKER ${BASE}\nSHA    ${v.body?.commit ?? '?'}\n`)

  const tn = 9100 + Math.floor(Math.random() * 90)
  let tableId = ''
  let tabId = ''
  let terminalId = ''
  const orderIds: string[] = []

  try {
    // ---------------------------------------------------------------- 1. the table + tab
    await admin.from('restaurant_tables').delete().eq('restaurant_id', RID).eq('table_number', tn)
    const { data: tbl, error: tErr } = await admin
      .from('restaurant_tables')
      .insert({ restaurant_id: RID, table_number: tn, active: true, is_view_only: false, is_kiosk: false, status: 'occupied' })
      .select('id, current_session_version').single()
    if (tErr) throw new Error(`seed table: ${tErr.message}`)
    tableId = tbl.id

    const { data: tab, error: tabErr } = await admin
      .from('tabs')
      .insert({
        restaurant_id: RID, table_id: tableId, table_number: tn,
        status: 'ready_to_pay',
        ready_to_pay_at: new Date().toISOString(),
        session_version: tbl.current_session_version ?? 1,
      })
      .select('id, status, ready_to_pay_at').single()
    if (tabErr) throw new Error(`seed tab: ${tabErr.message}`)
    tabId = tab.id

    for (let i = 0; i < 2; i++) {
      const { data: o, error } = await admin.from('orders').insert({
        restaurant_id: RID, tab_id: tabId, table_id: tableId, table_number: tn,
        channel: 'table', status: 'accepted', payment_status: 'pending',
        items: [{ name: `line${i}`, displayName: `line${i}`, quantity: 1, unitPrice: 30, subtotal: 26.09, tax: 3.91, total: 30 }],
        subtotal: 26.09, tax: 3.91, total: 30, placed_at: new Date().toISOString(),
      }).select('id').single()
      if (error) throw new Error(`seed order ${i}: ${error.message}`)
      orderIds.push(o.id)
    }
    console.log(`  [control] tab ${tab.status}, ready_to_pay_at set, 2 unpaid orders of 30 each`)

    // ------------------------------------------------- 2. pair a terminal, for real
    const code = String(Math.floor(100000 + Math.random() * 899999))
    const { data: term, error: termErr } = await admin
      .from('restaurant_terminals')
      .insert({
        restaurant_id: RID,
        name: `probe318-${randomUUID().slice(0, 6)}`,
        active: false,
        activation_code: code,
        activation_code_expires_at: new Date(Date.now() + 600_000).toISOString(),
      })
      .select('id').single()
    if (termErr) throw new Error(`seed terminal: ${termErr.message}`)
    terminalId = term.id

    const act = await api('/api/terminals/activate', {
      method: 'POST',
      body: JSON.stringify({ code, deviceId: `probe318-${randomUUID().slice(0, 8)}`, terminalSn: 'PROBE318' }),
    })
    const token = act.body?.token || act.body?.accessToken || act.body?.access_token || ''
    console.log(`  [control] REAL activation: ${act.status}  token ${token ? 'issued' : 'NOT issued'}`)
    if (!token) {
      console.error(`  ABORT: no terminal token (${JSON.stringify(act.body).slice(0, 200)}). Nothing below would be a device's view.`)
      process.exitCode = 1
      return
    }

    // ------------------------------------------------- BEFORE the settle
    const before = await api('/api/terminal/tables', {}, token)
    const beforeTab = (before.body?.tables ?? []).find((t: any) => Number(t.table_number) === tn)?.tab
    console.log(`\n  BEFORE the settle  status=${beforeTab?.status} unpaid_total=${beforeTab?.unpaid_total} ready_to_pay_at=${beforeTab?.ready_to_pay_at ? 'set' : 'ABSENT'}`)
    console.log(`      device expression -> ${deviceSaysReadyToPay(beforeTab)}   (must be true: nobody has paid yet)`)

    // ------------------------------------------------- 3. settle ONE order, for real
    const settle = await api(`/api/terminal/tabs/${tabId}/settle`, {
      method: 'POST',
      body: JSON.stringify({ order_ids: [orderIds[0]], method: 'cash', amount: 30 }),
    }, token)
    console.log(`\n  REAL partial settle (1 of 2 orders): ${settle.status} ${settle.status >= 400 ? JSON.stringify(settle.body).slice(0, 180) : ''}`)

    const { data: paidCheck } = await admin
      .from('orders').select('id, payment_status').in('id', orderIds)
    const paid = (paidCheck ?? []).filter((o) => String(o.payment_status).toLowerCase() === 'paid').length
    console.log(`  orders now paid: ${paid} of 2   ${paid === 1 ? '(a genuine PARTIAL settle)' : '*** not a partial settle — the case is void ***'}`)

    // ------------------------------------------------- 4. AFTER, as the device sees it
    const after = await api('/api/terminal/tables', {}, token)
    const afterTab = (after.body?.tables ?? []).find((t: any) => Number(t.table_number) === tn)?.tab

    if (!afterTab) {
      console.log('\n  THE TABLE IS NO LONGER IN THE PAYLOAD — inconclusive for the chip.')
      process.exitCode = 1
      return
    }

    console.log(`\n  AFTER the settle   status=${afterTab.status} unpaid_total=${afterTab.unpaid_total} ready_to_pay_at=${afterTab.ready_to_pay_at ? 'set' : 'ABSENT'}`)

    const statusArmAlone = afterTab.status === 'ready_to_pay'
    const deviceNow = deviceSaysReadyToPay(afterTab)

    console.log('')
    console.log(`  status arm alone (the OLD chip)  -> ${statusArmAlone}   ${statusArmAlone ? '' : '<- this is why the chip used to flip to "N unpaid orders"'}`)
    console.log(`  device expression (the NEW chip) -> ${deviceNow}`)
    console.log('')
    console.log(
      deviceNow && !statusArmAlone && paid === 1
        ? '  PASS — after a real partial settle the OLD chip would read "1 unpaid order" and the NEW one stays "Ready to Pay".'
        : deviceNow && statusArmAlone
          ? '  INCONCLUSIVE — status is still ready_to_pay, so this run does not exercise the fix.'
          : '  FAIL — the device expression is false after a partial settle; the chip would still flip.',
    )
    console.log('\n  NOT PROVEN HERE: that the chip RENDERS. That is React Native on a device.')
    console.log('  This proves the payload it reads and evaluates the exact boolean the screen computes.')
    process.exitCode = deviceNow && !statusArmAlone && paid === 1 ? 0 : 1
  } finally {
    if (tabId) {
      await admin.from('orders').delete().eq('tab_id', tabId)
      await admin.from('order_requests').delete().eq('tab_id', tabId)
      await admin.from('customer_sessions').delete().eq('tab_id', tabId)
      await admin.from('payments').delete().eq('tab_id', tabId)
      await admin.from('payment_events').delete().eq('tab_id', tabId)
      await admin.from('tabs').delete().eq('id', tabId)
    }
    if (terminalId) await admin.from('restaurant_terminals').delete().eq('id', terminalId)
    if (tableId) await admin.from('restaurant_tables').delete().eq('id', tableId)
    console.log('  cleaned')
  }
}

main().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1) })
