/**
 * #313: A CUSTOMER WHOSE TABLE WAS CLOSED IS TOLD SO, INSTEAD OF SEEING A BLANK SCREEN.
 *
 * Against the DEPLOYED worker, over real HTTP, on one session id across a real
 * `close_table_session` — the same phone before and after, which is the whole point: the phone
 * keeps its session id across a close, because nothing clears it.
 *
 * TWO-SIDED, and the BEFORE half is what makes the after half mean anything. A route that always
 * answered `sessionEnded: true` would pass a one-sided version of this and would put a
 * "your session has ended" screen in front of every customer who has not ordered yet.
 *
 *   BEFORE the close   the order is returned  AND  sessionEnded is false
 *   AFTER  the close   nothing is returned    AND  sessionEnded is true
 *
 * THE COUNT PATH IS CHECKED SEPARATELY, because it was the residual. e13340c bounded the ROW
 * paths and left `countOnly` alone, so a customer at a closed table saw a badge counting orders
 * the list refuses to show. An unexplained empty screen is the defect; a "1" above it is the same
 * defect with a number on it.
 *
 * WHAT THIS DOES NOT TEST, stated rather than implied: that the notice RENDERS. This proves the
 * signal the screen reads. tests/e2e/session-boundary.spec.ts is the browser half.
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
if (!url.includes(STAGING_REF)) {
  throw new Error(`GUARD: ${url || '(unset)'} is not the staging project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

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
    body = { raw: text.slice(0, 300) }
  }
  return { status: res.status, body }
}

const results: Array<{ name: string; want: string; got: string; ok: boolean }> = []
function check(name: string, want: unknown, got: unknown) {
  results.push({ name, want: String(want), got: String(got), ok: String(want) === String(got) })
}

async function main() {
  const version = await api('/api/version')
  console.log(`\nWORKER ${BASE}`)
  console.log(`SHA    ${version.body?.commit ?? '?'}\n`)

  const tn = 9700 + Math.floor(Math.random() * 60)
  const sid = `probe-313-${randomUUID()}`
  let tableId = ''
  let tabId = ''
  let menuItemId = ''

  const bySession = (extra = '') =>
    api(`/api/guest/orders/by-session?restaurantId=${RID}&session_id=${encodeURIComponent(sid)}${extra}`)

  try {
    await admin.from('restaurant_tables').delete().eq('restaurant_id', RID).eq('table_number', tn)
    const { data: tbl, error: tErr } = await admin
      .from('restaurant_tables')
      .insert({
        restaurant_id: RID,
        table_number: tn,
        active: true,
        is_view_only: false,
        is_kiosk: false,
        status: 'available',
      })
      .select('id, current_session_version')
      .single()
    if (tErr) throw new Error(`seed table: ${tErr.message}`)
    tableId = tbl.id

    const { data: mi, error: mErr } = await admin
      .from('menu_items')
      .insert({
        restaurant_id: RID,
        name: `p313-${randomUUID().slice(0, 6)}`,
        base_price: 30,
        status: 'available',
        track_inventory: false,
      })
      .select('id, name')
      .single()
    if (mErr) throw new Error(`seed menu item: ${mErr.message}`)
    menuItemId = mi.id

    const tab = await api('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ restaurantId: RID, tableNumber: tn, sessionId: sid, displayName: 'p313' }),
    })
    tabId = tab.body?.tabId
    if (!tabId) throw new Error(`tab creation failed: ${tab.status} ${JSON.stringify(tab.body).slice(0, 200)}`)

    const { error: oErr } = await admin.from('orders').insert({
      restaurant_id: RID,
      tab_id: tabId,
      table_id: tableId,
      table_number: tn,
      session_id: sid,
      member_session_id: sid,
      channel: 'table',
      status: 'accepted',
      payment_status: 'pending',
      items: [{ menuItemId, name: mi.name, displayName: mi.name, quantity: 1, unitPrice: 30, subtotal: 26.09, tax: 3.91, total: 30 }],
      subtotal: 26.09,
      tax: 3.91,
      total: 30,
      placed_at: new Date().toISOString(),
    })
    if (oErr) throw new Error(`seed order: ${oErr.message}`)

    // ======================= BEFORE THE CLOSE =======================
    const before = await bySession()
    const beforeCount = await bySession('&countOnly=1')
    console.log('  BEFORE the table close')
    console.log(`    orders returned   : ${before.body?.orders?.length ?? 0}`)
    console.log(`    sessionEnded      : ${JSON.stringify(before.body?.sessionEnded)}`)
    console.log(`    countOnly count   : ${beforeCount.body?.count}`)
    console.log(`    countOnly ended   : ${JSON.stringify(beforeCount.body?.sessionEnded)}`)

    check('BEFORE: the order is returned', 1, before.body?.orders?.length ?? 0)
    check('BEFORE: sessionEnded is false', false, before.body?.sessionEnded === true)
    check('BEFORE: the count sees it', 1, beforeCount.body?.count)
    check('BEFORE: count sessionEnded is false', false, beforeCount.body?.sessionEnded === true)

    /**
     * THE CONTROL. If the order was not visible BEFORE either, then "invisible after" proves
     * nothing about the boundary and everything about a broken fixture — the exact shape that
     * lets a security check read green during a total lockout.
     */
    if ((before.body?.orders?.length ?? 0) !== 1) {
      throw new Error('control failed: the order was not visible before the close, so nothing below means anything')
    }

    // ============================ THE CLOSE ============================
    const { data: closed, error: cErr } = await admin.rpc('close_table_session', {
      p_table_id: tableId,
      p_restaurant_id: RID,
    })
    if (cErr) throw new Error(`close_table_session: ${cErr.message}`)
    const { data: afterTable } = await admin
      .from('restaurant_tables')
      .select('current_session_version')
      .eq('id', tableId)
      .single()
    console.log(`\n  close_table_session      : ${JSON.stringify(closed).slice(0, 120)}`)
    console.log(`  session_version now      : ${afterTable?.current_session_version}`)

    // ======================== AFTER THE CLOSE ========================
    // Same session id. The phone kept it, because nothing clears it.
    const after = await bySession()
    const afterCount = await bySession('&countOnly=1')
    console.log('\n  AFTER the table close, SAME session id')
    console.log(`    orders returned   : ${after.body?.orders?.length ?? 0}`)
    console.log(`    sessionEnded      : ${JSON.stringify(after.body?.sessionEnded)}`)
    console.log(`    countOnly count   : ${afterCount.body?.count}`)
    console.log(`    countOnly ended   : ${JSON.stringify(afterCount.body?.sessionEnded)}`)

    check('AFTER: no order is returned', 0, after.body?.orders?.length ?? 0)
    check('AFTER: sessionEnded is true', true, after.body?.sessionEnded === true)
    check('AFTER: the count is bounded too', 0, afterCount.body?.count)
    check('AFTER: count sessionEnded is true', true, afterCount.body?.sessionEnded === true)

    // The row must still EXIST — it is a financial record, and the notice says so.
    const { count: stillThere } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sid)
    check('the order still exists for staff', 1, stillThere)

    console.log(`\n${'='.repeat(88)}`)
    for (const r of results) {
      console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(42)} want=${r.want.padEnd(6)} got=${r.got}`)
    }
    const failed = results.filter((r) => !r.ok)
    console.log(`\n  ${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} — ${results.length} checks against ${version.body?.commit ?? '?'}`)
    process.exitCode = failed.length === 0 ? 0 : 1
  } finally {
    if (tabId) {
      await admin.from('order_requests').delete().eq('tab_id', tabId)
      await admin.from('orders').delete().eq('tab_id', tabId)
      await admin.from('customer_sessions').delete().eq('tab_id', tabId)
      await admin.from('payments').delete().eq('tab_id', tabId)
      await admin.from('tabs').delete().eq('id', tabId)
    }
    await admin.from('orders').delete().eq('session_id', sid)
    if (tableId) await admin.from('restaurant_tables').delete().eq('id', tableId)
    if (menuItemId) await admin.from('menu_items').delete().eq('id', menuItemId)
    console.log('  cleaned')
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
