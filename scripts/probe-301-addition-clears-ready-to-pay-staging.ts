/**
 * #301 part 1: an ADDITION onto a ready_to_pay tab — what happens now?
 *
 * When #301 was filed the addition was allowed and the tab stayed `ready_to_pay`, so staff kept
 * seeing a settle-me signal against a figure that had since grown. Two things have changed since:
 *
 *   THE RULING (2026-08-18). Ready to Pay is a NOTIFICATION FLAG, not a payment lock. So the
 *   addition being allowed is not itself the defect — the customer has not committed to anything
 *   by pressing it, and refusing food to someone still sitting at the table would be worse.
 *
 *   THE FIX. app/api/guest/orders/[orderId]/edit now calls clearReadyToPayAndReopenTab whenever
 *   the total moves, so the tab leaves the settlement queue and the customer presses the button
 *   again once they have finished.
 *
 * This probe establishes the CURRENT behaviour end to end, on the deployed worker, rather than
 * inferring it from the diff:
 *
 *   1. seed a tab, an accepted order, and set the tab ready_to_pay
 *   2. add an item through the EDIT route — the path that bypasses POST /api/orders
 *   3. read tabs.status back
 *
 * PASS means: the addition lands AND the tab is no longer ready_to_pay.
 * FAIL means: the tab is still ready_to_pay, i.e. staff are still being told to settle a stale
 * figure — which is #301 part 1 unfixed.
 *
 * Self-cleaning, staging only.
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE = process.env.QR_SIM_BASE || 'https://flashtap-staging.llosperofficial.workers.dev'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const url = process.env.SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url.includes(STAGING_REF)) throw new Error(`GUARD: ${url} is not the staging project`)
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

async function main() {
  const version = await api('/api/version')
  console.log(`\nWORKER ${BASE}\nSHA    ${version.body?.commit ?? '?'}\n`)

  const tn = 9805 + Math.floor(Math.random() * 40)
  await admin.from('restaurant_tables').delete().eq('restaurant_id', RID).eq('table_number', tn)
  const { data: tbl } = await admin
    .from('restaurant_tables')
    .insert({ restaurant_id: RID, table_number: tn, active: true, is_view_only: false, is_kiosk: false, status: 'available' })
    .select('id, current_session_version')
    .single()

  const { data: mi } = await admin
    .from('menu_items')
    .insert({ restaurant_id: RID, name: `p301-${randomUUID().slice(0, 6)}`, base_price: 30, status: 'available', track_inventory: false })
    .select('id, name, base_price')
    .single()

  const sid = `probe-301-${randomUUID()}`
  const tab = await api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber: tn, sessionId: sid, displayName: 'p301' }),
  })
  const tabId = tab.body?.tabId
  const token = tab.body?.sessionToken || ''

  const { data: order } = await admin
    .from('orders')
    .insert({
      restaurant_id: RID, tab_id: tabId, table_id: tbl.id, table_number: tn,
      session_id: sid, member_session_id: sid, channel: 'table',
      status: 'accepted', payment_status: 'pending',
      items: [{ menuItemId: mi.id, name: mi.name, displayName: mi.name, quantity: 1, unitPrice: 30, subtotal: 26.09, tax: 3.91, total: 30 }],
      subtotal: 26.09, tax: 3.91, total: 30, placed_at: new Date().toISOString(),
    })
    .select('id, total')
    .single()

  // Tell staff we are ready to pay.
  const rtp = await api(`/api/tabs/${tabId}/ready-to-pay`, {
    method: 'POST',
    headers: token ? { 'x-session-token': token } : {},
    body: JSON.stringify({ restaurantId: RID, sessionId: sid, paymentPreference: 'cash' }),
  })
  /**
   * THE ROUTE ANSWERED 403 on the first run of this probe, so the tab stayed `open` and the
   * verdict below read PASS for the trivial reason that there was no flag to clear. The control
   * caught it. The route's own auth is not what this probe is about, so the state is set
   * directly — and the control is now FATAL rather than advisory.
   */
  if (rtp.status !== 200 && rtp.status !== 201) {
    await admin
      .from('tabs')
      .update({ status: 'ready_to_pay', payment_preference: 'cash', ready_to_pay_at: new Date().toISOString() })
      .eq('id', tabId)
  }
  const before = (await admin.from('tabs').select('status').eq('id', tabId).single()).data
  console.log(`  ready-to-pay route      : ${rtp.status}${rtp.status === 200 ? '' : '  (set directly instead)'}`)
  console.log(`  [control] tabs.status   : ${before?.status}`)
  if (before?.status !== 'ready_to_pay') {
    console.error('  ABORT: the control failed — the tab is not ready_to_pay, so nothing below would mean anything.')
    process.exit(1)
  }

  // THE SUBJECT: add through the EDIT route, the path that bypasses POST /api/orders.
  const lock = await api(`/api/guest/orders/${order.id}/edit`, {
    method: 'POST',
    headers: token ? { 'x-session-token': token } : {},
    body: JSON.stringify({ restaurantId: RID, sessionIds: [sid] }),
  })
  let added = { status: 0, body: null as any }
  if (lock.status === 200 && lock.body?.lockToken) {
    added = await api(`/api/guest/orders/${order.id}/edit`, {
      method: 'PATCH',
      headers: token ? { 'x-session-token': token } : {},
      body: JSON.stringify({
        restaurantId: RID, sessionIds: [sid], lockToken: lock.body.lockToken,
        add: [{ menuItemId: mi.id, name: mi.name, displayName: mi.name, quantity: 1, selectedVariants: {}, size: null, addons: [], specialInstructions: '' }],
      }),
    })
  }
  const after = (await admin.from('tabs').select('status').eq('id', tabId).single()).data
  const orderAfter = (await admin.from('orders').select('total').eq('id', order.id).single()).data

  console.log(`  lock                    : ${lock.status}`)
  console.log(`  addition (PATCH)        : ${added.status}`)
  console.log(`  order total  ${order.total} -> ${orderAfter?.total}`)
  console.log(`  tabs.status AFTER       : ${after?.status}`)

  const additionLanded = added.status === 200 && Number(orderAfter?.total) > Number(order.total)
  const queueCleared = after?.status !== 'ready_to_pay'
  console.log(
    `\n  VERDICT: addition landed=${additionLanded}  ready-to-pay cleared=${queueCleared}  ->  ` +
      (additionLanded && queueCleared
        ? 'PASS — the flag is a notification, and it no longer goes stale'
        : 'FAIL — staff are still being told to settle a figure that has moved'),
  )

  // cleanup
  await admin.from('order_requests').delete().eq('tab_id', tabId)
  await admin.from('orders').delete().eq('tab_id', tabId)
  await admin.from('customer_sessions').delete().eq('tab_id', tabId)
  await admin.from('payments').delete().eq('tab_id', tabId)
  await admin.from('tabs').delete().eq('id', tabId)
  await admin.from('restaurant_tables').delete().eq('id', tbl.id)
  await admin.from('menu_items').delete().eq('id', mi.id)
  console.log('  cleaned')
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
