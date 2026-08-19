/**
 * #318 SERVER HALF: does `/api/terminal/tables` actually return `ready_to_pay_at`?
 *
 * A select change that typechecks can still return nothing — that is precisely how #306 shipped
 * inert, writing a column it never selected. So this asks the deployed route, over HTTP, with a
 * real terminal token, and reads the payload.
 *
 * TWO-SIDED, and the second half is the point: the field must be PRESENT and non-null on a tab
 * that has asked to pay, and the derived signal the device will compute
 * (`ready_to_pay_at != null && unpaid_total > 0`) must be TRUE while `status` has already been
 * reopened to 'open' — which is the exact state the chip gets wrong today.
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

async function main() {
  const vr = await fetch(`${BASE}/api/version`)
  console.log(`\nWORKER ${BASE}\nSHA    ${(await vr.json())?.commit ?? '?'}\n`)

  const tn = 9200 + Math.floor(Math.random() * 90)
  let tableId = ''
  let tabId = ''
  let terminalId = ''
  let token = ''

  try {
    await admin.from('restaurant_tables').delete().eq('restaurant_id', RID).eq('table_number', tn)
    const { data: tbl, error: tErr } = await admin
      .from('restaurant_tables')
      .insert({ restaurant_id: RID, table_number: tn, active: true, is_view_only: false, is_kiosk: false, status: 'occupied' })
      .select('id, current_session_version').single()
    if (tErr) throw new Error(`seed table: ${tErr.message}`)
    tableId = tbl.id

    /**
     * THE STATE THE CHIP GETS WRONG: a tab that asked to pay, then had ONE order settled, so the
     * settle path reopened status to 'open' while ready_to_pay_at survived and money remains.
     */
    const { data: tab, error: tabErr } = await admin
      .from('tabs')
      .insert({
        restaurant_id: RID, table_id: tableId, table_number: tn,
        status: 'open',
        ready_to_pay_at: new Date().toISOString(),
        session_version: tbl.current_session_version ?? 1,
      })
      .select('id, status, ready_to_pay_at').single()
    if (tabErr) throw new Error(`seed tab: ${tabErr.message}`)
    tabId = tab.id
    console.log(`  [control] seeded tab: status=${tab.status}  ready_to_pay_at=${tab.ready_to_pay_at ? 'set' : 'NULL'}`)

    // One unpaid order so unpaid_total > 0, and one paid so it reads as a PARTIAL settle.
    for (const ps of ['pending', 'paid']) {
      const { error } = await admin.from('orders').insert({
        restaurant_id: RID, tab_id: tabId, table_id: tableId, table_number: tn,
        channel: 'table', status: 'pending', payment_status: ps,
        items: [{ name: 'x', displayName: 'x', quantity: 1, unitPrice: 30, subtotal: 26.09, tax: 3.91, total: 30 }],
        subtotal: 26.09, tax: 3.91, total: 30, placed_at: new Date().toISOString(),
      })
      if (error) throw new Error(`seed order ${ps}: ${error.message}`)
    }

    // A terminal + token to call the route as the device does.
    const { data: term, error: termErr } = await admin
      .from('restaurant_terminals')
      .insert({
        restaurant_id: RID,
        device_id: `probe-318-${randomUUID().slice(0, 8)}`,
        name: 'probe 318',
        status: 'active',
      })
      .select('id').single()
    if (termErr) throw new Error(`seed terminal: ${termErr.message} — cannot call the route as a device`)
    terminalId = term.id

    const act = await fetch(`${BASE}/api/terminals/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ restaurantId: RID, deviceId: `probe-318-${terminalId.slice(0, 8)}`, name: 'probe 318' }),
    })
    const actBody = await act.json().catch(() => ({}))
    token = actBody?.token || actBody?.accessToken || ''
    console.log(`  [control] terminal activate: ${act.status}  token ${token ? 'issued' : 'NOT issued'}`)
    if (!token) {
      console.log('\n  CANNOT CALL THE ROUTE AS A DEVICE — reading the DB projection instead, and')
      console.log('  saying so rather than reporting a pass. The HTTP half is unverified.')
      const { data: raw } = await admin
        .from('tabs').select('id, status, ready_to_pay_at').eq('id', tabId).single()
      console.log(`  DB: status=${raw?.status} ready_to_pay_at=${raw?.ready_to_pay_at}`)
      process.exitCode = 1
      return
    }

    const res = await fetch(`${BASE}/api/terminal/tables`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    })
    const body = await res.json().catch(() => ({}))
    console.log(`  GET /api/terminal/tables : ${res.status}`)

    const mine = (body?.tables ?? []).find((t: any) => Number(t.table_number) === tn)
    if (!mine) {
      console.log(`  MY TABLE NOT IN THE PAYLOAD (${(body?.tables ?? []).length} tables returned) — inconclusive`)
      process.exitCode = 1
      return
    }

    const t = mine.tab ?? {}
    console.log(`\n  THE TAB AS THE DEVICE SEES IT:`)
    console.log(`      status          : ${t.status}`)
    console.log(`      unpaid_total    : ${t.unpaid_total}`)
    console.log(`      ready_to_pay_at : ${t.ready_to_pay_at ?? '(absent)'}`)

    const fieldPresent = t.ready_to_pay_at != null
    const derived = t.ready_to_pay_at != null && Number(t.unpaid_total ?? 0) > 0
    const statusArmWouldMiss = t.status !== 'ready_to_pay'

    console.log(`\n  PASS  field present                        : ${fieldPresent}`)
    console.log(`  PASS  derived signal (the device's rule)    : ${derived}`)
    console.log(`  PASS  status arm alone would MISS it        : ${statusArmWouldMiss}`)
    console.log(
      `\n  ${fieldPresent && derived && statusArmWouldMiss
        ? 'ALL PASS — the device can now tell "someone asked to pay and money remains" in the exact state the chip gets wrong.'
        : 'FAILED — see above.'}`,
    )
    process.exitCode = fieldPresent && derived && statusArmWouldMiss ? 0 : 1
  } finally {
    if (tabId) {
      await admin.from('orders').delete().eq('tab_id', tabId)
      await admin.from('order_requests').delete().eq('tab_id', tabId)
      await admin.from('customer_sessions').delete().eq('tab_id', tabId)
      await admin.from('payments').delete().eq('tab_id', tabId)
      await admin.from('tabs').delete().eq('id', tabId)
    }
    if (terminalId) await admin.from('restaurant_terminals').delete().eq('id', terminalId)
    if (tableId) await admin.from('restaurant_tables').delete().eq('id', tableId)
    console.log('  cleaned')
  }
}

main().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1) })
