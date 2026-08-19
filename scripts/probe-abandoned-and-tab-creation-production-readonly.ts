/**
 * TWO MEASUREMENTS ON PRODUCTION, STRICTLY READ-ONLY.
 *
 *  A. How many `waiting_review` order_requests sit on a table that has since been CLEARED?
 *     Needed before the abandoned-status change touches anything, so the backfill can be ruled
 *     on a number rather than a guess.
 *
 *  B. Tab-creation context for the End Session hole: how many tabs exist, how many were never
 *     used, and which restaurants have the tab PIN switched OFF.
 *
 * "CLEARED SINCE" is derived, because nothing records it directly: a request's tab carries the
 * `session_version` it was opened at, and `restaurant_tables.current_session_version` is bumped by
 * every close. tab.session_version < table.current_session_version means at least one close has
 * happened since that tab began.
 *
 * TAB-LESS REQUESTS ARE A SECOND CASE and are counted separately rather than folded in. A request
 * with no tab_id cannot be tested this way at all, and quietly reporting it as "not cleared" would
 * understate the answer.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: ${url || '(unset)'} is not the production project`)
}
const admin = createClient(url, key, { auth: { persistSession: false } })

const hours = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3_600_000

async function main() {
  console.log('\nPRODUCTION — abandoned requests + tab-creation context. Read-only.\n')

  const { data: ctl, error: ctlErr } = await admin.from('order_requests').select('id').limit(1)
  if (ctlErr) throw new Error(`control failed: ${ctlErr.message}`)
  console.log(`  [control] order_requests readable and non-empty : ${ctl?.length ? 'YES' : 'NO — nothing below means anything'}`)

  // ============================================================== A. ABANDONED CANDIDATES
  const { data: reqs, error: rErr } = await admin
    .from('order_requests')
    .select('id, status, tab_id, table_number, restaurant_id, placed_at')
    .in('status', ['waiting_review', 'accepting'])
  if (rErr) throw new Error(`requests read: ${rErr.message}`)

  console.log(`\n  A. UNANSWERED REQUESTS (waiting_review or accepting) : ${reqs?.length ?? 0}`)

  const tabIds = [...new Set((reqs ?? []).map((r) => r.tab_id).filter(Boolean))]
  const { data: tabs } = tabIds.length
    ? await admin.from('tabs').select('id, table_id, session_version, status, settled_type').in('id', tabIds)
    : { data: [] }
  const tabById = new Map((tabs ?? []).map((t) => [String(t.id), t]))

  const tableIds = [...new Set((tabs ?? []).map((t) => t.table_id).filter(Boolean))]
  const { data: tables } = tableIds.length
    ? await admin.from('restaurant_tables').select('id, table_number, current_session_version, status').in('id', tableIds)
    : { data: [] }
  const tableById = new Map((tables ?? []).map((t) => [String(t.id), t]))

  let cleared = 0
  let live = 0
  let noTab = 0
  let unresolvable = 0
  const clearedRows: Array<{ id: string; age: number; table: unknown; tabV: unknown; tblV: unknown }> = []

  for (const r of reqs ?? []) {
    if (!r.tab_id) {
      noTab++
      continue
    }
    const tab = tabById.get(String(r.tab_id))
    const table = tab?.table_id ? tableById.get(String(tab.table_id)) : null
    if (!tab || !table) {
      unresolvable++
      continue
    }
    const tabV = Number(tab.session_version)
    const tblV = Number(table.current_session_version)
    if (Number.isFinite(tabV) && Number.isFinite(tblV) && tabV < tblV) {
      cleared++
      clearedRows.push({ id: r.id, age: hours(r.placed_at), table: table.table_number, tabV, tblV })
    } else {
      live++
    }
  }

  console.log(`      on a table CLEARED since (tab.session_version < table.current) : ${cleared}`)
  console.log(`      still on a live session                                        : ${live}`)
  console.log(`      no tab_id — cannot be tested this way (second case)            : ${noTab}`)
  console.log(`      tab or table row missing                                       : ${unresolvable}`)

  if (clearedRows.length) {
    console.log('\n      THE CLEARED ONES:')
    for (const c of clearedRows.sort((a, b) => b.age - a.age)) {
      console.log(`        table ${String(c.table).padEnd(4)} waiting ${c.age.toFixed(1).padStart(7)} h   tab v${c.tabV} vs table v${c.tblV}`)
    }
  }

  // settled_type tells us it was a MANUAL close rather than a settle
  const manual = (tabs ?? []).filter((t) => t.settled_type === 'manual_close').length
  console.log(`\n      of the tabs behind these requests, settled_type='manual_close' : ${manual}`)

  // ============================================================== B. TAB CREATION CONTEXT
  const { count: tabTotal } = await admin.from('tabs').select('id', { count: 'exact', head: true })
  const { data: allTabs } = await admin.from('tabs').select('id, status, table_number, created_at, restaurant_id')
  const allIds = (allTabs ?? []).map((t) => t.id)

  // Which tabs ever carried an order or a request?
  const usedIds = new Set<string>()
  for (const table of ['orders', 'order_requests']) {
    const { data } = await admin.from(table).select('tab_id').not('tab_id', 'is', null)
    for (const row of data ?? []) usedIds.add(String(row.tab_id))
  }
  const unused = allIds.filter((id) => !usedIds.has(String(id)))

  console.log(`\n  B. TAB CREATION CONTEXT`)
  console.log(`      tabs total                                   : ${tabTotal}`)
  console.log(`      tabs that NEVER carried an order or request  : ${unused.length}`)
  console.log('        ^ the footprint a tab opened without dining would leave. NOT proof of the')
  console.log('          End Session hole on its own -- an abandoned scan at the table looks the same.')

  console.log('\n      NOT MEASURABLE: restaurant_tables.status is CURRENT, not historical, and no')
  console.log('      column records the table status at the moment a tab was created. "How many tabs')
  console.log('      were created on an already-available table" cannot be answered from this schema.')
  console.log('      Every legitimate first scan also happens on an available table, so even if it')
  console.log('      were recorded the number would not separate the two.')

  // ============================================================== PIN CENSUS
  const { data: settings, error: sErr } = await admin
    .from('restaurant_settings')
    .select('restaurant_id, tab_pin_required')
  if (sErr) console.log(`      settings read failed: ${sErr.message}`)
  const { data: restaurants } = await admin.from('restaurants').select('id, name')
  const nameById = new Map((restaurants ?? []).map((r) => [String(r.id), String(r.name)]))

  console.log('\n  THE TAB PIN, per restaurant (default is TRUE when no row / null):')
  const withRow = new Set<string>()
  for (const s of settings ?? []) {
    withRow.add(String(s.restaurant_id))
    const on = s.tab_pin_required !== false
    console.log(`      ${String(nameById.get(String(s.restaurant_id)) ?? s.restaurant_id).padEnd(30)} ${on ? 'ON' : 'OFF  <<<'}`)
  }
  for (const r of restaurants ?? []) {
    if (!withRow.has(String(r.id))) {
      console.log(`      ${String(r.name).padEnd(30)} ON  (no settings row — defaults true)`)
    }
  }

  const off = (settings ?? []).filter((s) => s.tab_pin_required === false).length
  console.log(`\n      restaurants with the tab PIN OFF : ${off}`)

  // How many OPEN tabs right now, and how many carry no PIN?
  const { count: openTabs } = await admin
    .from('tabs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open')
  const { count: openNoPin } = await admin
    .from('tabs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open')
    .or('pin_required.eq.false,tab_pin.is.null')
  console.log(`      OPEN tabs right now              : ${openTabs}`)
  console.log(`      of those with no PIN protection  : ${openNoPin}   <- joinable without a PIN if reachable`)
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
