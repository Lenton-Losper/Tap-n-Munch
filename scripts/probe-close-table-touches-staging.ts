/**
 * WHAT DOES close_table_session ACTUALLY TOUCH?
 *
 * Measured, not read. The baseline migration carries the function's SIGNATURE but its BODY is
 * stripped from the dump (`AS $$` is immediately followed by the next statement), and pg_proc is
 * not readable through PostgREST. So the only honest way to establish what it does is to seed one
 * of every related row, call it, and diff.
 *
 * Staging only, self-cleaning.
 *
 * THE QUESTION THAT PROMPTED IT: a click test on production closed Riviera Table 1 and an
 * order_request in `waiting_review` SURVIVED — still on the dashboard, still counting
 * "waiting 141 min". It was never accepted, so it never became an `orders` row.
 *
 * Every row below is seeded on the SAME table so that "untouched" means "the function chose not
 * to touch it", not "it was never in scope".
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error(`GUARD: ${url || '(unset)'} is not staging`)
const admin = createClient(url, key, { auth: { persistSession: false } })

const show = (label: string, before: unknown, after: unknown) => {
  const b = JSON.stringify(before)
  const a = JSON.stringify(after)
  const changed = b !== a
  console.log(`  ${changed ? 'CHANGED  ' : 'untouched'} ${label.padEnd(38)} ${b}  ->  ${a}`)
  return changed
}

async function main() {
  const tn = 9500 + Math.floor(Math.random() * 90)
  const sid = `probe-close-${randomUUID()}`
  let tableId = ''
  let tabId = ''
  let menuItemId = ''
  let orderId = ''
  let reqWaiting = ''
  let reqDeclined = ''

  try {
    await admin.from('restaurant_tables').delete().eq('restaurant_id', RID).eq('table_number', tn)
    const { data: tbl, error: tErr } = await admin
      .from('restaurant_tables')
      .insert({ restaurant_id: RID, table_number: tn, active: true, is_view_only: false, is_kiosk: false, status: 'occupied' })
      .select('id, current_session_version, status')
      .single()
    if (tErr) throw new Error(`seed table: ${tErr.message}`)
    tableId = tbl.id

    const { data: mi } = await admin
      .from('menu_items')
      .insert({ restaurant_id: RID, name: `close-${randomUUID().slice(0, 6)}`, base_price: 25, status: 'available', track_inventory: false })
      .select('id, name').single()
    menuItemId = mi.id

    const { data: tab, error: tabErr } = await admin
      .from('tabs')
      .insert({ restaurant_id: RID, table_id: tableId, table_number: tn, status: 'open', session_version: tbl.current_session_version ?? 1 })
      .select('id, status, settled_at, ready_to_pay_at').single()
    if (tabErr) throw new Error(`seed tab: ${tabErr.message}`)
    tabId = tab.id

    // NO table_number column on this table, and session_version is NOT NULL. The first run
    // passed table_number, the insert failed, and the error went unchecked -- so it is checked.
    const { data: cs, error: csErr } = await admin
      .from('customer_sessions')
      .insert({
        restaurant_id: RID,
        tab_id: tabId,
        table_id: tableId,
        session_version: tbl.current_session_version ?? 1,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      })
      .select('id, expires_at, active').single()
    if (csErr) throw new Error(`seed customer_session: ${csErr.message}`)

    const line = [{ menuItemId, name: mi.name, displayName: mi.name, quantity: 1, unitPrice: 25, subtotal: 21.74, tax: 3.26, total: 25 }]

    const { data: ord, error: oErr } = await admin.from('orders').insert({
      restaurant_id: RID, tab_id: tabId, table_id: tableId, table_number: tn,
      session_id: sid, member_session_id: sid, channel: 'table',
      status: 'pending', payment_status: 'pending',
      items: line, subtotal: 21.74, tax: 3.26, total: 25, placed_at: new Date().toISOString(),
    }).select('id, status, payment_status, is_closed').single()
    if (oErr) throw new Error(`seed order: ${oErr.message}`)
    orderId = ord.id

    const mkReq = async (status: string) => {
      const { data, error } = await admin.from('order_requests').insert({
        restaurant_id: RID, tab_id: tabId, table_number: tn,
        session_id: sid, member_session_id: sid, channel: 'table',
        status, items: line, subtotal: 21.74, tax: 3.26, total: 25,
        placed_at: new Date().toISOString(),
      }).select('id, status').single()
      if (error) throw new Error(`seed request ${status}: ${error.message}`)
      return data
    }
    const rw = await mkReq('waiting_review')
    const rd = await mkReq('declined')
    reqWaiting = rw.id
    reqDeclined = rd.id

    console.log(`\nSTAGING — what close_table_session touches. Table ${tn}.\n`)
    console.log('  [control] seeded: 1 table, 1 tab, 1 customer_session, 1 order (pending),')
    console.log('            1 order_request (waiting_review), 1 order_request (declined)\n')

    // ------------------------------------------------------------------ BEFORE
    const snap = async () => ({
      table: (await admin.from('restaurant_tables').select('status, current_session_version').eq('id', tableId).single()).data,
      tab: (await admin.from('tabs').select('status, settled_at, settled_type, ready_to_pay_at').eq('id', tabId).single()).data,
      session: (await admin.from('customer_sessions').select('expires_at, active').eq('id', cs.id).single()).data,
      order: (await admin.from('orders').select('status, payment_status, is_closed').eq('id', orderId).single()).data,
      reqWaiting: (await admin.from('order_requests').select('status').eq('id', reqWaiting).single()).data,
      reqDeclined: (await admin.from('order_requests').select('status').eq('id', reqDeclined).single()).data,
    })
    const before = await snap()

    // ------------------------------------------------------------------ THE CALL
    const { data: rpc, error: rpcErr } = await admin.rpc('close_table_session', {
      p_table_id: tableId,
      p_restaurant_id: RID,
    })
    if (rpcErr) throw new Error(`close_table_session: ${rpcErr.message}`)
    console.log(`  RPC RETURNED: ${JSON.stringify(rpc)}\n`)

    const after = await snap()

    // ------------------------------------------------------------------ THE DIFF
    console.log('  WHAT MOVED:')
    show('restaurant_tables.status', before.table?.status, after.table?.status)
    show('restaurant_tables.session_version', before.table?.current_session_version, after.table?.current_session_version)
    show('tabs.status', before.tab?.status, after.tab?.status)
    show('tabs.settled_at', before.tab?.settled_at, after.tab?.settled_at)
    show('tabs.settled_type', before.tab?.settled_type, after.tab?.settled_type)
    show('tabs.ready_to_pay_at', before.tab?.ready_to_pay_at, after.tab?.ready_to_pay_at)
    show('customer_sessions.expires_at', before.session?.expires_at, after.session?.expires_at)
    show('customer_sessions.active', before.session?.active, after.session?.active)
    show('orders.status', before.order?.status, after.order?.status)
    show('orders.payment_status', before.order?.payment_status, after.order?.payment_status)
    show('orders.is_closed', before.order?.is_closed, after.order?.is_closed)
    const waitingMoved = show('order_requests(waiting_review).status', before.reqWaiting?.status, after.reqWaiting?.status)
    show('order_requests(declined).status', before.reqDeclined?.status, after.reqDeclined?.status)

    // ------------------------------------------------------------------ THE VERDICT
    console.log('\n  VERDICT:')
    console.log(
      `      an unanswered request ${waitingMoved ? 'IS' : 'IS NOT'} touched by close_table_session.`,
    )
    if (!waitingMoved) {
      console.log(`      It is still '${after.reqWaiting?.status}' on a table whose session_version is now`)
      console.log(`      ${after.table?.current_session_version}. Nothing else expires it: order_requests has no reaper.`)
    }

    // Does the dashboard still see it? That query is status-scoped, not session-scoped.
    const { count: dashVisible } = await admin
      .from('order_requests')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', RID)
      .eq('id', reqWaiting)
      .in('status', ['waiting_review'])
    console.log(`\n      still matches the dashboard's waiting_review filter: ${dashVisible === 1 ? 'YES' : 'no'}`)
  } finally {
    if (tabId) {
      await admin.from('order_requests').delete().eq('tab_id', tabId)
      await admin.from('orders').delete().eq('tab_id', tabId)
      await admin.from('customer_sessions').delete().eq('tab_id', tabId)
      await admin.from('payments').delete().eq('tab_id', tabId)
      await admin.from('tabs').delete().eq('id', tabId)
    }
    if (tableId) await admin.from('restaurant_tables').delete().eq('id', tableId)
    if (menuItemId) await admin.from('menu_items').delete().eq('id', menuItemId)
    console.log('\n  cleaned')
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
