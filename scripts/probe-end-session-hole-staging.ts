/**
 * THE END SESSION HOLE — questions 2 and 5, measured end to end.
 *
 * Q2  Can a customer reach the table landing and CREATE a tab with no fresh scan — just the URL
 *     from browser history?
 *
 * Q5  Does the same route let a stranger create or JOIN a tab on a table that is OCCUPIED by
 *     someone else, from off-site? Answered for BOTH PIN states, because the tab PIN is a
 *     per-restaurant setting and four production restaurants have it OFF.
 *
 * HOW "OFF-SITE" IS SIMULATED HONESTLY: every call below is a plain HTTPS request carrying no
 * scan artefact, no referrer, no prior cookie and a session id invented on the spot. That is
 * strictly LESS than a browser returning from history, which would at least carry its old
 * localStorage. If these succeed, a phone in a car park succeeds.
 *
 * TWO-SIDED throughout: the PIN-on and PIN-off cases are run against the SAME occupied table so
 * the only variable is the setting.
 *
 * Staging only, self-cleaning. The restaurant's tab_pin_required is flipped and RESTORED.
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

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text.slice(0, 200) } }
  return { status: res.status, body }
}

const createTab = (tn: number, sid: string, name: string) =>
  api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber: tn, sessionId: sid, displayName: name }),
  })

async function main() {
  const v = await api('/api/version')
  console.log(`\nWORKER ${BASE}\nSHA    ${v.body?.commit ?? '?'}\n`)

  const tn = 9300 + Math.floor(Math.random() * 90)
  let tableId = ''
  const madeTabs: string[] = []
  let originalPin: boolean | null = null

  try {
    const { data: settings } = await admin
      .from('restaurant_settings').select('tab_pin_required').eq('restaurant_id', RID).maybeSingle()
    originalPin = settings ? settings.tab_pin_required : null
    console.log(`  [control] fixture restaurant tab_pin_required starts as: ${JSON.stringify(originalPin)}`)

    await admin.from('restaurant_tables').delete().eq('restaurant_id', RID).eq('table_number', tn)
    const { data: tbl } = await admin.from('restaurant_tables')
      .insert({ restaurant_id: RID, table_number: tn, active: true, is_view_only: false, is_kiosk: false, status: 'available' })
      .select('id').single()
    tableId = tbl.id

    const setPin = async (on: boolean) => {
      const { error } = await admin
        .from('restaurant_settings').update({ tab_pin_required: on }).eq('restaurant_id', RID)
      if (error) throw new Error(`set pin ${on}: ${error.message}`)
    }

    // ============================================================ Q2: create with no scan
    console.log('\n  Q2 — CREATE A TAB ON AN EMPTY TABLE, NO SCAN, NO PRIOR STATE')
    const strangerA = `probe-offsite-${randomUUID()}`
    const q2 = await createTab(tn, strangerA, 'off-site A')
    console.log(`      POST /api/tabs (empty table)            : ${q2.status}`)
    if (q2.body?.tabId) madeTabs.push(q2.body.tabId)
    console.log(`      tab created                             : ${q2.body?.tabId ? 'YES  *** no scan required ***' : 'no'}`)
    console.log(`      session token issued to the stranger    : ${q2.body?.sessionToken ? 'YES' : 'no'}`)
    console.log(`      tab PIN returned to the creator         : ${q2.body?.tabPin ? 'YES' : 'no'}`)

    // The table is now OCCUPIED by strangerA's tab. Everything below is a SECOND party.
    const { data: tblNow } = await admin
      .from('restaurant_tables').select('status').eq('id', tableId).single()
    console.log(`      restaurant_tables.status after create   : ${tblNow?.status}`)

    // ============================================================ Q5: occupied table
    for (const pinOn of [true, false]) {
      await setPin(pinOn)
      console.log(`\n  Q5 — OCCUPIED TABLE, tab_pin_required = ${pinOn ? 'ON' : 'OFF'}`)

      // The existing tab was created under the ORIGINAL setting; align it so the case is real.
      await admin.from('tabs')
        .update({ pin_required: pinOn, tab_pin: pinOn ? '1234' : null })
        .eq('id', madeTabs[0])

      const strangerB = `probe-stranger-${randomUUID()}`
      const create = await createTab(tn, strangerB, 'stranger B')
      const code = create.body?.code ?? create.body?.reason ?? ''
      console.log(`      POST /api/tabs on the occupied table    : ${create.status}  ${code}`)
      // A 4xx body still carries tabId so the client can prompt for the PIN. Reading it as
      // "got in" was wrong on the first run and inverted the headline finding.
      const gotIn = create.status < 400 && Boolean(create.body?.tabId)
      if (gotIn && !madeTabs.includes(create.body.tabId)) madeTabs.push(create.body.tabId)
      console.log(`      stranger landed IN a tab                : ${gotIn ? `YES -> ${create.body.tabId}` : 'no'}`)
      if (gotIn) {
        const sameTab = create.body.tabId === madeTabs[0]
        console.log(`      ${sameTab ? '*** IT IS THE OCCUPANTS OWN TAB ***' : 'a separate tab'}`)
      }

      // Can they read the occupant's tab directly?
      const view = await api(`/api/tabs/${madeTabs[0]}/view?restaurantId=${RID}&sessionId=${encodeURIComponent(strangerB)}`)
      // A 200 alone proves nothing -- what matters is whether the OCCUPANT'S data came back.
      const t = view.body?.tab ?? view.body
      const leaked = {
        total: t?.total,
        members: Array.isArray(t?.members) ? t.members.length : t?.members,
        orders: Array.isArray(view.body?.orders) ? view.body.orders.length : undefined,
        displayName: t?.display_name ?? t?.displayName,
        tabPin: t?.tab_pin ?? t?.tabPin,
      }
      console.log(`      GET  /api/tabs/{occupant tab}/view      : ${view.status}`)
      console.log(`        payload: ${JSON.stringify(leaked)}`)

      // And the explicit join route, which requires no session token at all.
      const join = await api(`/api/tabs/${madeTabs[0]}/join`, {
        method: 'POST',
        body: JSON.stringify({ restaurantId: RID, tableNumber: tn, sessionId: strangerB, displayName: 'stranger B', pin: pinOn ? '1234' : undefined }),
      })
      console.log(`      POST /api/tabs/{occupant tab}/join      : ${join.status}  ${join.body?.error ? String(join.body.error).slice(0, 60) : ''}`)

      const joinNoPin = await api(`/api/tabs/${madeTabs[0]}/join`, {
        method: 'POST',
        body: JSON.stringify({ restaurantId: RID, tableNumber: tn, sessionId: strangerB, displayName: 'stranger B' }),
      })
      console.log(`      POST .../join with NO pin supplied      : ${joinNoPin.status}  ${joinNoPin.body?.error ? String(joinNoPin.body.error).slice(0, 60) : ''}`)
    }
  } finally {
    if (originalPin !== null) {
      await admin.from('restaurant_settings').update({ tab_pin_required: originalPin }).eq('restaurant_id', RID)
      console.log(`\n  restored tab_pin_required to ${JSON.stringify(originalPin)}`)
    }
    for (const id of madeTabs) {
      await admin.from('order_requests').delete().eq('tab_id', id)
      await admin.from('orders').delete().eq('tab_id', id)
      await admin.from('customer_sessions').delete().eq('tab_id', id)
      await admin.from('payments').delete().eq('tab_id', id)
      await admin.from('tabs').delete().eq('id', id)
    }
    if (tableId) await admin.from('restaurant_tables').delete().eq('id', tableId)
    console.log('  cleaned')
  }
}

main().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1) })
