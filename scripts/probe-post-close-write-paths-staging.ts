/**
 * AFTER A TABLE IS CLOSED, WHAT CAN A CUSTOMER STILL DO?
 *
 * The phone keeps its session id, its session TOKEN and its tab id across a close — nothing on the
 * device clears them. So the only thing standing between a stale phone and a live write is the
 * server. This drives every guest write path with those stale credentials and records what each
 * one answers.
 *
 * TWO-SIDED. Each path is exercised BEFORE the close as well, because "refused after" proves
 * nothing unless the same call was accepted before — a route that is simply broken refuses both.
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

let token = ''
async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-session-token': token } : {}),
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text.slice(0, 160) } }
  return { status: res.status, body }
}

const rows: Array<{ path: string; before: string; after: string; verdict: string }> = []

async function main() {
  const v = await api('/api/version')
  console.log(`\nWORKER ${BASE}\nSHA    ${v.body?.commit ?? '?'}\n`)

  const tn = 9400 + Math.floor(Math.random() * 90)
  const sid = `probe-postclose-${randomUUID()}`
  let tableId = ''
  let tabId = ''
  let menuItemId = ''

  try {
    await admin.from('restaurant_tables').delete().eq('restaurant_id', RID).eq('table_number', tn)
    const { data: tbl } = await admin.from('restaurant_tables')
      .insert({ restaurant_id: RID, table_number: tn, active: true, is_view_only: false, is_kiosk: false, status: 'available' })
      .select('id').single()
    tableId = tbl.id

    const { data: mi } = await admin.from('menu_items')
      .insert({ restaurant_id: RID, name: `pc-${randomUUID().slice(0, 6)}`, base_price: 30, status: 'available', track_inventory: false })
      .select('id, name').single()
    menuItemId = mi.id

    const tab = await api('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ restaurantId: RID, tableNumber: tn, sessionId: sid, displayName: 'postclose' }),
    })
    tabId = tab.body?.tabId
    token = tab.body?.sessionToken || ''
    if (!tabId) throw new Error(`tab creation failed: ${tab.status} ${JSON.stringify(tab.body).slice(0, 160)}`)
    console.log(`  [control] tab created, session token ${token ? 'issued' : 'MISSING — every 410 below would be meaningless'}`)
    if (!token) throw new Error('control failed: no session token to go stale')

    const line = [{ menuItemId, name: mi.name, displayName: mi.name, quantity: 1, selectedVariants: {}, size: null, addons: [], specialInstructions: '' }]

    const paths: Array<{ name: string; run: () => Promise<{ status: number; body: any }> }> = [
      { name: 'GET  /api/tabs/{tab}/view', run: () => api(`/api/tabs/${tabId}/view?restaurantId=${RID}&sessionId=${encodeURIComponent(sid)}`) },
      { name: 'POST /api/orders  (WITH tabId)', run: () => api('/api/orders', { method: 'POST', body: JSON.stringify({ restaurantId: RID, tableNumber: tn, tabId, sessionId: sid, items: line }) }) },
      { name: 'POST /api/orders  (NO tabId)', run: () => api('/api/orders', { method: 'POST', body: JSON.stringify({ restaurantId: RID, tableNumber: tn, sessionId: sid, items: line, paymentMethod: 'cash' }) }) },
      { name: 'POST /api/tabs/{tab}/ready-to-pay', run: () => api(`/api/tabs/${tabId}/ready-to-pay`, { method: 'POST', body: JSON.stringify({ restaurantId: RID, sessionId: sid, paymentPreference: 'cash' }) }) },
      { name: 'GET  /api/guest/orders/by-session', run: () => api(`/api/guest/orders/by-session?restaurantId=${RID}&session_id=${encodeURIComponent(sid)}`) },
    ]

    const before: Record<string, string> = {}
    for (const p of paths) {
      const r = await p.run()
      before[p.name] = String(r.status)
    }

    // ---------------------------------------------------------------- THE CLOSE
    const { error: cErr } = await admin.rpc('close_table_session', { p_table_id: tableId, p_restaurant_id: RID })
    if (cErr) throw new Error(`close: ${cErr.message}`)
    console.log('  table closed\n')

    for (const p of paths) {
      const r = await p.run()
      const a = String(r.status)
      const b = before[p.name]
      const refusedAfter = Number(a) >= 400
      const workedBefore = Number(b) < 400
      const verdict = !workedBefore
        ? 'INCONCLUSIVE — did not work before either'
        : refusedAfter
          ? 'CLOSED'
          : '*** STILL WORKS AFTER CLOSE ***'
      rows.push({ path: p.name, before: b, after: a, verdict })
    }

    console.log('  PATH                                    BEFORE  AFTER  VERDICT')
    for (const r of rows) {
      console.log(`  ${r.path.padEnd(38)} ${r.before.padEnd(6)}  ${r.after.padEnd(5)}  ${r.verdict}`)
    }

    const leaks = rows.filter((r) => r.verdict.includes('STILL WORKS'))
    console.log(`\n  ${leaks.length === 0 ? 'NO WRITE PATH SURVIVES THE CLOSE.' : `${leaks.length} PATH(S) SURVIVE THE CLOSE.`}`)
  } finally {
    if (tabId) {
      await admin.from('order_requests').delete().eq('tab_id', tabId)
      await admin.from('orders').delete().eq('tab_id', tabId)
      await admin.from('customer_sessions').delete().eq('tab_id', tabId)
      await admin.from('payments').delete().eq('tab_id', tabId)
      await admin.from('tabs').delete().eq('id', tabId)
    }
    await admin.from('orders').delete().eq('session_id', sid)
    await admin.from('order_requests').delete().eq('session_id', sid)
    if (tableId) await admin.from('restaurant_tables').delete().eq('id', tableId)
    if (menuItemId) await admin.from('menu_items').delete().eq('id', menuItemId)
    console.log('  cleaned')
  }
}

main().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1) })
