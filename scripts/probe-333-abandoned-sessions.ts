/**
 * #333 — WHAT IS ACTUALLY OUT THERE. READ ONLY. Runs against staging AND production.
 *
 * #333 says "There is no expiry, no TTL, and no reaper." Two of those three are false:
 * customer_sessions.expires_at is set to now()+24h at issuance and validateSessionToken enforces
 * it on all nine token-guarded routes. So a session DOES stop being able to order after 24h.
 *
 * What never ends is the TAB and the TABLE. This probe measures the gap that actually exists,
 * before anything is built:
 *
 *   - how many tabs are open, and how old
 *   - how many would be caught by a 4h inactivity rule
 *   - HOW MANY OF THOSE CARRY UNPAID MONEY  <- the number that decides the design, because
 *     close_table_session marks a tab settled/'manual_close', and doing that to an unpaid tab
 *     fabricates a settlement
 *   (#338 removed a fourth measurement from here — whether last_seen_at was a real activity signal.
 *    It never was, on staging or production, and the column has since been dropped.)
 *
 * Marker: PROBE_333_OK
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const H = 60 * 60 * 1000

/** Page every read. A count that stops at 1000 is a wrong count. */
async function all(q) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}

async function probe(label, url, key) {
  console.log('\n' + '='.repeat(78) + '\n' + label + '  ' + url + '\n' + '='.repeat(78))
  if (!url || !key) {
    console.log('  SKIPPED - no credentials')
    return
  }
  const db = createClient(url, key, { auth: { persistSession: false } })
  const now = Date.now()

  const tabs = await all((f, t) =>
    db
      .from('tabs')
      .select('id, restaurant_id, table_id, table_number, status, created_at, ready_to_pay_at, total, settled_at')
      .eq('status', 'open')
      .range(f, t),
  )
  console.log('\nopen tabs: ' + tabs.length)
  if (tabs.length === 0) console.log('  nothing open - no reaper candidates at all')

  // Orders are the only evidenced customer ACTION on a tab. Browsing is recorded nowhere.
  const tabIds = tabs.map((t) => t.id)
  const orders = []
  for (let i = 0; i < tabIds.length; i += 50) {
    const slice = tabIds.slice(i, i + 50)
    orders.push(
      ...(await all((f, t) =>
        db
          .from('orders')
          .select('id, tab_id, placed_at, payment_status, status, total')
          .in('tab_id', slice)
          .range(f, t),
      )),
    )
  }
  const byTab = new Map()
  for (const o of orders) {
    if (!byTab.has(o.tab_id)) byTab.set(o.tab_id, [])
    byTab.get(o.tab_id).push(o)
  }

  // Token issuance is a scan - also an action, and the only one a browsing-only customer leaves.
  const sessions = []
  for (let i = 0; i < tabIds.length; i += 50) {
    const slice = tabIds.slice(i, i + 50)
    sessions.push(
      ...(await all((f, t) =>
        db
          .from('customer_sessions')
          .select('id, tab_id, created_at, expires_at, active')
          .in('tab_id', slice)
          .range(f, t),
      )),
    )
  }
  const sessByTab = new Map()
  for (const s of sessions) {
    if (!sessByTab.has(s.tab_id)) sessByTab.set(s.tab_id, [])
    sessByTab.get(s.tab_id).push(s)
  }

  const lastActivity = (tab) => {
    let at = new Date(tab.created_at).getTime()
    let from = 'tab created'
    const bump = (ts, what) => {
      if (!ts) return
      const m = new Date(ts).getTime()
      if (m > at) {
        at = m
        from = what
      }
    }
    bump(tab.ready_to_pay_at, 'ready to pay')
    for (const o of byTab.get(tab.id) ?? []) bump(o.placed_at, 'order placed')
    for (const s of sessByTab.get(tab.id) ?? []) bump(s.created_at, 'session token issued')
    return { at, from }
  }

  const unpaidOn = (tab) =>
    (byTab.get(tab.id) ?? []).filter(
      (o) =>
        String(o.payment_status || '').toLowerCase() !== 'paid' &&
        String(o.status || '').toLowerCase() !== 'cancelled',
    )

  const buckets = { '<4h': 0, '4-12h': 0, '12-24h': 0, '>24h': 0 }
  let stale = 0
  let staleWithUnpaid = 0
  let staleUnpaidValue = 0
  let staleNoOrders = 0
  const signalUse = {}

  for (const tab of tabs) {
    const { at, from } = lastActivity(tab)
    const age = now - at
    signalUse[from] = (signalUse[from] ?? 0) + 1
    if (age < 4 * H) buckets['<4h']++
    else if (age < 12 * H) buckets['4-12h']++
    else if (age < 24 * H) buckets['12-24h']++
    else buckets['>24h']++
    if (age >= 4 * H) {
      stale++
      const u = unpaidOn(tab)
      if (u.length > 0) {
        staleWithUnpaid++
        staleUnpaidValue += u.reduce((s, o) => s + Number(o.total || 0), 0)
      }
      if ((byTab.get(tab.id) ?? []).length === 0) staleNoOrders++
    }
  }

  console.log('\ninactivity age of open tabs (by the best evidenced action):')
  for (const [k, v] of Object.entries(buckets)) console.log('  ' + k.padEnd(8) + ' ' + v)
  console.log('\nwhich signal was the most recent evidence:')
  for (const [k, v] of Object.entries(signalUse)) console.log('  ' + k.padEnd(22) + ' ' + v)

  console.log('\na 4h inactivity rule would catch: ' + stale + ' tab(s)')
  console.log(
    '  of those, carrying UNPAID orders: ' + staleWithUnpaid + '   (value ' + staleUnpaidValue.toFixed(2) + ')',
  )
  console.log('  of those, with NO orders at all:  ' + staleNoOrders + '   (scanned, never ordered - nothing owed)')

    // #338: the last_seen_at check that used to sit here is GONE with the column. It measured
    // whether last_seen_at ever differed from created_at; the settled answer was NEVER, on staging
    // and on production, and the column has been dropped. Nothing here re-derives it.

  // Sessions already past their 24h TTL but sitting on a still-open tab.
  const expired = sessions.filter((s) => s.expires_at && new Date(s.expires_at).getTime() < now)
  console.log("\nsession rows already past expires_at, on tabs still 'open': " + expired.length)
  console.log('  these customers can no longer order, yet the tab holds the table and the unique index.')
}

async function main() {
  const sUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!sUrl.includes(STAGING_REF)) throw new Error('expected staging in .env.test - got ' + sUrl)
  await probe('STAGING', sUrl, process.env.SUPABASE_SERVICE_ROLE_KEY || '')

  // Production, read only. Every statement above is a select.
  const pUrl = process.env.SUPABASE_URL || ''
  if (pUrl && !pUrl.includes(STAGING_REF)) {
    await probe('PRODUCTION (read only)', pUrl, process.env.SUPABASE_SERVICE_ROLE_KEY_PROD || process.env.SUPABASE_SERVICE_ROLE_KEY || '')
  }
  console.log('\nPROBE_333_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
