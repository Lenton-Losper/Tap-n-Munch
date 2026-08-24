/**
 * #329 — PROVE THE CANCEL LEAVES A TRAIL, AND THAT THE TAB CLOSE ACTUALLY CLOSES. Staging only.
 *
 * Two defects, both invisible from the function's return value before this:
 *   1. it cancelled orders with no audit_logs row, so #329's "an order can reach cancelled with no
 *      evidence" was still true through this path
 *   2. its tab close patched closed_at/updated_at, columns tabs does not have, so PostgREST rejected
 *      the whole UPDATE and closedTabCount was ALWAYS 0 while the cron reported success
 *
 * The second one is why the negative control matters most here: a test that only checks
 * "closedTabCount > 0" would have passed on the broken version if it never seeded a closeable tab.
 * So this seeds one, and asserts the TAB ROW ITSELF changed.
 *
 * Marker: VERIFY_329_OK
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { expireHostedPendingOrders } from '../lib/orders/expire-hosted-pending-orders'
import { ORDER_CANCELLED_ACTION } from '../lib/orders/cancel-order-with-trail'

config({ path: resolve(__dirname, '../.env.test'), override: true })
config({ path: resolve(__dirname, '../.env.local'), override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error('REFUSING: not staging - ' + url)

const db = createClient(url, key, { auth: { persistSession: false } })
let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log('  ' + (ok ? 'PASS' : '*** FAIL ***') + '  ' + label + (detail ? '  ' + detail : ''))
}

const agoISO = (ms) => new Date(Date.now() - ms).toISOString()

async function main() {
  const tag = 'v329-' + Date.now()
  console.log('staging ' + url + '\nseed ' + tag + '\n')

  let orgId = '', restId = '', tableId = '', tabId = '', orderId = '', freshOrderId = ''

  const ins = async (table, row, what) => {
    const { data, error } = await db.from(table).insert(row).select('id').single()
    if (error) throw new Error(what + ': ' + error.message)
    return String(data.id)
  }

  try {
    const { data: u0 } = await db.from('users').select('id').limit(1).single()
    orgId = await ins('organizations', { name: tag, owner_user_id: String(u0.id) }, 'organizations')
    restId = await ins('restaurants', { name: tag + '-venue', organization_id: orgId }, 'restaurants')
    tableId = await ins('restaurant_tables',
      { restaurant_id: restId, table_number: 950, status: 'occupied', current_session_version: 1, active: true },
      'restaurant_tables')
    tabId = await ins('tabs',
      { restaurant_id: restId, table_id: tableId, table_number: 950, status: 'open', session_version: 1 },
      'tabs')

    // Abandoned hosted order, older than the 10-minute cutoff, on that tab.
    orderId = await ins('orders',
      { restaurant_id: restId, tab_id: tabId, table_number: 950, status: 'new',
        payment_status: 'pending', payment_channel: 'hosted', total: 75, placed_at: agoISO(30 * 60 * 1000) },
      'orders')

    // NEGATIVE CONTROL: a hosted order inside the window must survive untouched.
    freshOrderId = await ins('orders',
      { restaurant_id: restId, table_number: 951, status: 'new',
        payment_status: 'pending', payment_channel: 'hosted', total: 20, placed_at: agoISO(60 * 1000) },
      'orders')

    const tabBefore = (await db.from('tabs').select('status').eq('id', tabId).single()).data
    check('the seeded tab starts open', tabBefore?.status === 'open', String(tabBefore?.status))

    const result = await expireHostedPendingOrders(db)
    console.log('\n  result ' + JSON.stringify(result))

    // ---------------------------------------------------------------- the cancel
    console.log('\nTHE CANCEL')
    const order = (await db.from('orders')
      .select('status, payment_status, cancelled_at, cancellation_reason').eq('id', orderId).single()).data
    check('the abandoned order is cancelled', order?.status === 'cancelled' && order?.payment_status === 'cancelled',
      JSON.stringify(order))
    check('cancelled_at is set', Boolean(order?.cancelled_at))
    check('the reason is recorded on the row', order?.cancellation_reason === 'hosted_timeout')

    // ---------------------------------------------------------------- THE TRAIL (#329)
    console.log('\nTHE TRAIL — the thing #329 is actually about')
    const { data: audits } = await db.from('audit_logs').select('action, metadata').eq('entity_id', orderId)
    const cancelRows = (audits ?? []).filter((a) => a.action === ORDER_CANCELLED_ACTION)
    check('an audit row exists for the cancelled order', cancelRows.length === 1,
      cancelRows.length + ' row(s), actions: ' + (audits ?? []).map((a) => a.action).join(',') || 'none')
    check('it uses the SAME action every other cancel path uses', cancelRows[0]?.action === 'order.cancelled',
      String(cancelRows[0]?.action))
    check('it names the source', cancelRows[0]?.metadata?.source === 'expire_hosted_pending_orders',
      String(cancelRows[0]?.metadata?.source))
    check('it records the amount at stake', Number(cancelRows[0]?.metadata?.orderTotal) === 75,
      String(cancelRows[0]?.metadata?.orderTotal))
    check('it states the basis, so the row explains itself', Boolean(cancelRows[0]?.metadata?.basisNote))
    check('no audit failures were swallowed', result.auditFailureCount === 0, String(result.auditFailureCount))

    // ---------------------------------------------------------------- THE TAB CLOSE
    console.log('\nTHE TAB CLOSE — never once worked before this')
    const tabAfter = (await db.from('tabs').select('status, settled_at, settled_type').eq('id', tabId).single()).data
    check('the tab is actually closed IN THE DATABASE', tabAfter?.status === 'closed', String(tabAfter?.status))
    check('the function reports it too', result.closedTabCount === 1, String(result.closedTabCount))
    check('no settlement was fabricated', tabAfter?.settled_at === null && tabAfter?.settled_type === null,
      JSON.stringify(tabAfter))

    // ---------------------------------------------------------------- NEGATIVE CONTROL
    console.log('\nNEGATIVE CONTROL — a recent hosted order must be untouched')
    const fresh = (await db.from('orders').select('status, payment_status, cancelled_at').eq('id', freshOrderId).single()).data
    check('the 1-minute-old order is NOT cancelled', fresh?.status !== 'cancelled' && fresh?.cancelled_at === null,
      JSON.stringify(fresh))
    const { data: freshAudits } = await db.from('audit_logs').select('id').eq('entity_id', freshOrderId)
    check('and has no audit row invented for it', (freshAudits ?? []).length === 0, String((freshAudits ?? []).length))

    console.log(failures === 0 ? '\nVERIFY_329_OK' : '\n*** ' + failures + ' CHECK(S) FAILED ***')
  } finally {
    if (restId) {
      const { data: os } = await db.from('orders').select('id').eq('restaurant_id', restId)
      for (const o of os ?? []) await db.from('audit_logs').delete().eq('entity_id', o.id)
      await db.from('orders').delete().eq('restaurant_id', restId)
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
