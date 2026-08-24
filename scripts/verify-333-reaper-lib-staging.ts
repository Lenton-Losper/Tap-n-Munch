/**
 * #333 — RUN THE REAPER THE WAY THE CRON RUNS IT, against staging's real backlog. Staging only.
 *
 * The SQL function is proved separately (verify-333-reap-abandoned-tabs-staging.ts, 20 checks).
 * What this proves is the layer above it: that reapAbandonedTabs selects the right candidates and
 * classifies each outcome correctly — including on rows nobody seeded, which is the only place the
 * candidate query's assumptions get tested against real data.
 *
 * IT MAKES REAL CHANGES TO STAGING. Every open tab on staging is more than 24h idle (measured by
 * probe-333-abandoned-sessions.ts), so all of them are candidates. That is the intended behaviour
 * and it is what a first production run would do too, which is exactly why it is worth watching
 * happen once before it is on a schedule. Tabs owing money must come out the other side untouched.
 *
 * Marker: VERIFY_333_LIB_OK
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { reapAbandonedTabs, ABANDONED_TAB_INACTIVE_HOURS } from '../lib/tabs/reap-abandoned-tabs'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error('REFUSING: not staging - ' + url)

const db = createClient(url, key, { auth: { persistSession: false } })
let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log('  ' + (ok ? 'PASS' : '*** FAIL ***') + '  ' + label + (detail ? '  ' + detail : ''))
}

async function openTabs() {
  const { data, error } = await db.from('tabs').select('id, table_number, total, status').eq('status', 'open')
  if (error) throw new Error(error.message)
  return data ?? []
}

async function main() {
  console.log('staging ' + url + '\nthreshold ' + ABANDONED_TAB_INACTIVE_HOURS + 'h\n')

  const before = await openTabs()
  console.log('open tabs before: ' + before.length)

  // Which of them owe money, decided the same way the function decides it. Computed BEFORE the
  // run so the expectation is independent of what the run reports about itself.
  const owing = new Set()
  for (const t of before) {
    const { data: os } = await db.from('orders').select('payment_status, status').eq('tab_id', t.id)
    const unpaid = (os ?? []).filter(
      (o) =>
        String(o.payment_status || '').toLowerCase() !== 'paid' &&
        String(o.status || '').toLowerCase() !== 'cancelled',
    )
    const { data: rs } = await db.from('order_requests').select('status').eq('tab_id', t.id)
    const awaiting = (rs ?? []).filter((r) => ['waiting_review', 'accepting'].includes(String(r.status)))
    if (unpaid.length > 0 || awaiting.length > 0) owing.add(t.id)
  }
  console.log('of those, owing money or awaiting review: ' + owing.size + '\n')

  const result = await reapAbandonedTabs(db, ABANDONED_TAB_INACTIVE_HOURS)
  console.log('result ' + JSON.stringify(result, null, 2) + '\n')

  check('every candidate was accounted for',
    result.candidates === result.reaped + result.leftForStaff + result.stillActive + result.errors,
    result.candidates + ' = ' + result.reaped + '+' + result.leftForStaff + '+' + result.stillActive + '+' + result.errors)
  check('nothing errored', result.errors === 0, String(result.errors))

  const after = await openTabs()
  console.log('\nopen tabs after: ' + after.length)
  const stillOpen = new Set(after.map((t) => t.id))

  // THE ONE THAT MATTERS. Not "the function said it refused" — that a tab owing money is still
  // open, still unsettled, in the database, after a real run.
  let survived = 0
  for (const id of owing) if (stillOpen.has(id)) survived++
  check('EVERY tab owing money is still open after the run', survived === owing.size,
    survived + ' of ' + owing.size)

  const settledWrong = []
  for (const id of owing) {
    const { data } = await db.from('tabs').select('status, settled_type, settled_at').eq('id', id).single()
    if (data && (data.status !== 'open' || data.settled_at !== null)) settledWrong.push({ id, ...data })
  }
  check('and none of them was given a settlement record', settledWrong.length === 0, JSON.stringify(settledWrong))

  check('the ones it reaped are the ones that owed nothing',
    result.reapedTabIds.every((id) => !owing.has(id)),
    result.reapedTabIds.filter((id) => owing.has(id)).join(',') || 'none overlapped')

  check('the money-owing tabs are the ones it flagged for staff',
    result.leftForStaffTabIds.every((id) => owing.has(id)) && result.leftForStaff === owing.size,
    result.leftForStaff + ' flagged vs ' + owing.size + ' owing')

  // Audit rows: one per reap, one per flag, none missing.
  const ids = [...result.reapedTabIds, ...result.leftForStaffTabIds]
  if (ids.length > 0) {
    const { data: aud } = await db.from('audit_logs').select('action, entity_id').in('entity_id', ids)
    const reapRows = (aud ?? []).filter((r) => r.action === 'tab.reaped_abandoned')
    const flagRows = (aud ?? []).filter((r) => r.action === 'tab.abandoned_needs_attention')
    check('one audit row per reaped tab', reapRows.length >= result.reaped,
      reapRows.length + ' rows for ' + result.reaped + ' reaps')
    check('one audit row per flagged tab', flagRows.length >= result.leftForStaff,
      flagRows.length + ' rows for ' + result.leftForStaff + ' flags')
  }

  // Tables the reap freed must now be available, or the whole point is missed.
  if (result.reapedTabIds.length > 0) {
    const { data: reapedTabs } = await db.from('tabs').select('id, table_id').in('id', result.reapedTabIds)
    const tableIds = (reapedTabs ?? []).map((t) => t.table_id).filter(Boolean)
    if (tableIds.length > 0) {
      const { data: tables } = await db.from('restaurant_tables').select('id, status').in('id', tableIds)
      const occupied = (tables ?? []).filter((t) => t.status !== 'available')
      check('every table behind a reaped tab is now available', occupied.length === 0,
        occupied.length + ' still occupied')
    }
  }

  // Idempotence at the batch level: a second immediate run must find nothing left to reap.
  const second = await reapAbandonedTabs(db, ABANDONED_TAB_INACTIVE_HOURS)
  check('a second run reaps nothing more', second.reaped === 0, JSON.stringify({ reaped: second.reaped, candidates: second.candidates }))
  check('and still refuses the same money-owing tabs', second.leftForStaff === owing.size,
    second.leftForStaff + ' vs ' + owing.size)

  console.log(failures === 0 ? '\nVERIFY_333_LIB_OK' : '\n*** ' + failures + ' CHECK(S) FAILED ***')
  if (failures > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
