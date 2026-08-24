/**
 * #333 — PROVE THE REAPER CLOSES WHAT IT SHOULD AND REFUSES WHAT IT MUST. Staging only.
 *
 * The dangerous failure here is not "fails to reap". It is "reaps a tab that owed money", because
 * that writes a settlement nobody made. So the refusals below are the load-bearing assertions, and
 * each one checks the tab is still OPEN afterwards rather than just checking the return value.
 *
 * Every case is seeded with an explicit backdated created_at, so "four hours idle" is a real
 * measured condition and not a wait.
 *
 * Marker: VERIFY_333_REAP_OK
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

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

const H = 60 * 60 * 1000
const agoISO = (ms) => new Date(Date.now() - ms).toISOString()

async function main() {
  const tag = 'v333-' + Date.now()
  console.log('staging ' + url + '\nseed ' + tag + '\n')

  let orgId = '', restId = '', userId = ''
  const tableIds = []

  const ins = async (table, row, what) => {
    const { data, error } = await db.from(table).insert(row).select('id').single()
    if (error) throw new Error(what + ': ' + error.message)
    return String(data.id)
  }

  try {
    const { data: u0, error: uErr } = await db.from('users').select('id').limit(1).single()
    if (uErr) throw new Error('no user: ' + uErr.message)
    userId = String(u0.id)
    orgId = await ins('organizations', { name: tag, owner_user_id: userId }, 'organizations')
    restId = await ins('restaurants', { name: tag + '-venue', organization_id: orgId }, 'restaurants')

    let tableSeq = 900
    /** One table + one tab, backdated, plus whatever rows the case needs. */
    const seed = async (idleMs, opts = {}) => {
      const tableNumber = tableSeq++
      const tableId = await ins('restaurant_tables',
        { restaurant_id: restId, table_number: tableNumber, status: 'occupied', current_session_version: 1, active: true },
        'restaurant_tables')
      tableIds.push(tableId)
      const tabId = await ins('tabs',
        { restaurant_id: restId, table_id: tableId, table_number: tableNumber, status: 'open',
          created_at: agoISO(idleMs), session_version: 1, total: opts.total ?? 0 },
        'tabs')
      await ins('customer_sessions',
        { tab_id: tabId, table_id: tableId, restaurant_id: restId, session_version: 1, active: true,
          created_at: agoISO(idleMs), expires_at: agoISO(idleMs - 24 * H) },
        'customer_sessions')
      if (opts.order) {
        const { error } = await db.from('orders').insert({
          restaurant_id: restId, tab_id: tabId, table_number: tableNumber,
          status: opts.order.status ?? 'completed',
          payment_status: opts.order.payment_status ?? 'paid',
          total: opts.order.total ?? 100,
          placed_at: agoISO(opts.order.placedAgoMs ?? idleMs),
          completed_at: opts.order.completedAgoMs != null ? agoISO(opts.order.completedAgoMs) : null,
        })
        if (error) throw new Error('orders: ' + error.message)
      }
      if (opts.request) {
        const { error } = await db.from('order_requests').insert({
          restaurant_id: restId, tab_id: tabId, table_number: tableNumber, channel: 'table',
          status: opts.request.status, total: 50, placed_at: agoISO(idleMs),
        })
        if (error) throw new Error('order_requests: ' + error.message)
      }
      return { tabId, tableId, tableNumber }
    }

    const reap = async (tabId, hours = 4) => {
      const { data, error } = await db.rpc('reap_abandoned_tab', { p_tab_id: tabId, p_inactive_hours: hours })
      if (error) return { rpcError: error.message }
      return data
    }
    const tabRow = async (id) => (await db.from('tabs').select('status, settled_type, settled_at').eq('id', id).single()).data
    const tableRow = async (id) => (await db.from('restaurant_tables').select('status, current_session_version').eq('id', id).single()).data
    const audits = async (tabId) => (await db.from('audit_logs').select('action, metadata').eq('entity_id', tabId)).data ?? []

    // ------------------------------------------------------------ REAPS
    console.log('WHAT MUST BE REAPED')

    const a = await seed(6 * H) // scanned, never ordered
    const ra = await reap(a.tabId)
    check('an abandoned tab with no orders is reaped', ra?.reaped === true, JSON.stringify(ra))
    const aTab = await tabRow(a.tabId)
    check('  it settles as "abandoned", NEVER "manual_close"', aTab?.settled_type === 'abandoned', String(aTab?.settled_type))
    check('  its status is settled', aTab?.status === 'settled', String(aTab?.status))
    const aTable = await tableRow(a.tableId)
    check('  the table is freed', aTable?.status === 'available', String(aTable?.status))
    check('  the session version is bumped 1 -> 2', aTable?.current_session_version === 2, String(aTable?.current_session_version))
    const aSess = (await db.from('customer_sessions').select('active').eq('tab_id', a.tabId)).data ?? []
    check('  its sessions are expired', aSess.every((s) => s.active === false), JSON.stringify(aSess.map((s) => s.active)))
    const aAud = await audits(a.tabId)
    check('  an audit row records the reap', aAud.some((r) => r.action === 'tab.reaped_abandoned'), aAud.map((r) => r.action).join(','))

    const b = await seed(6 * H, { order: { payment_status: 'paid', status: 'completed', total: 120 } })
    const rb = await reap(b.tabId)
    check('a tab whose orders are all PAID is reaped', rb?.reaped === true, JSON.stringify(rb))

    // ------------------------------------------------------------ REFUSALS (the ones that matter)
    console.log('\nWHAT MUST NEVER BE REAPED')

    const c = await seed(6 * H, { order: { payment_status: 'pending', status: 'new', total: 80 } })
    const rc = await reap(c.tabId)
    check('a tab that OWES MONEY is refused', rc?.reaped === false && rc?.reason === 'money_or_review_outstanding', JSON.stringify(rc))
    const cTab = await tabRow(c.tabId)
    check('  and is still open, unsettled', cTab?.status === 'open' && cTab?.settled_at === null, JSON.stringify(cTab))
    const cTable = await tableRow(c.tableId)
    check('  and its table was NOT freed', cTable?.status === 'occupied' && cTable?.current_session_version === 1, JSON.stringify(cTable))
    const cAud = await audits(c.tabId)
    check('  and staff get an audit row about it', cAud.some((r) => r.action === 'tab.abandoned_needs_attention'), cAud.map((r) => r.action).join(','))

    const d = await seed(6 * H, { request: { status: 'waiting_review' } })
    const rd = await reap(d.tabId)
    check('a tab with a request AWAITING REVIEW is refused', rd?.reaped === false && rd?.reason === 'money_or_review_outstanding', JSON.stringify(rd))
    check('  and is still open', (await tabRow(d.tabId))?.status === 'open')

    const e = await seed(1 * H)
    const re = await reap(e.tabId)
    check('a tab idle only 1h is refused as still_active', re?.reaped === false && re?.reason === 'still_active', JSON.stringify(re))

    // The signal is a MAX, not just created_at. Old tab, recent customer order.
    const f = await seed(9 * H, { order: { payment_status: 'paid', status: 'completed', total: 60, placedAgoMs: 10 * 60 * 1000 } })
    const rf = await reap(f.tabId)
    check('an OLD tab with a RECENT order is still_active', rf?.reaped === false && rf?.reason === 'still_active', JSON.stringify(rf))

    // Staff activity counts too: everything customer-side is old, but staff touched it minutes ago.
    const g = await seed(9 * H, { order: { payment_status: 'paid', status: 'completed', total: 60, placedAgoMs: 9 * H, completedAgoMs: 5 * 60 * 1000 } })
    const rg = await reap(g.tabId)
    check('a STAFF timestamp minutes old keeps it alive', rg?.reaped === false && rg?.reason === 'still_active', JSON.stringify(rg))

    // ------------------------------------------------------------ IDEMPOTENCE
    console.log('\nDOING IT TWICE (the #335 lesson: an undo that runs twice is a new defect)')
    const rr = await reap(a.tabId)
    check('re-reaping an already-reaped tab is refused', rr?.reaped === false && rr?.reason === 'not_open', JSON.stringify(rr))
    const aTable2 = await tableRow(a.tableId)
    check('  and the session version bumped only ONCE', aTable2?.current_session_version === 2, String(aTable2?.current_session_version))
    const aAud2 = await audits(a.tabId)
    check('  and only ONE reap audit row exists', aAud2.filter((r) => r.action === 'tab.reaped_abandoned').length === 1,
      String(aAud2.filter((r) => r.action === 'tab.reaped_abandoned').length))

    const rz = await reap(a.tabId, 0)
    check('a nonsense threshold of 0 hours is refused outright', Boolean(rz?.rpcError), rz?.rpcError?.slice(0, 60) ?? 'NO ERROR')

    console.log(failures === 0 ? '\nVERIFY_333_REAP_OK' : '\n*** ' + failures + ' CHECK(S) FAILED ***')
  } finally {
    if (restId) {
      const tabs = (await db.from('tabs').select('id').eq('restaurant_id', restId)).data ?? []
      for (const t of tabs) await db.from('audit_logs').delete().eq('entity_id', t.id)
      await db.from('order_requests').delete().eq('restaurant_id', restId)
      await db.from('orders').delete().eq('restaurant_id', restId)
      await db.from('customer_sessions').delete().eq('restaurant_id', restId)
      await db.from('tabs').delete().eq('restaurant_id', restId)
      await db.from('restaurant_tables').delete().eq('restaurant_id', restId)
      await db.from('restaurants').delete().eq('id', restId)
    }
    if (orgId) await db.from('organizations').delete().eq('id', orgId)
    console.log('cleaned up')
  }
  if (failures > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
