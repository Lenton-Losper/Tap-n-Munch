/**
 * Does an order placed on a tab actually LAND on that tab?
 *
 * The concurrent simulation's self-test printed `saw 13.37 against 0.00` — the orders backing the
 * tab summed to ZERO. Both `tabs.total` and the sum were 0, so the money invariant agreed and
 * reported nothing. That is the "0 findings because nothing happened" trap one level below the
 * check counter: the assertions ran, on an empty fixture.
 *
 * One table, one order, then read the database directly. Self-cleaning, staging only.
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
    body = { raw: text.slice(0, 400) }
  }
  return { status: res.status, body }
}

async function main() {
  const tn = 9795
  await admin.from('restaurant_tables').delete().eq('restaurant_id', RID).eq('table_number', tn)

  const { data: tbl, error: te } = await admin
    .from('restaurant_tables')
    .insert({ restaurant_id: RID, table_number: tn, active: true, is_view_only: false, is_kiosk: false, status: 'available' })
    .select('id')
    .single()
  if (te) throw new Error(`table: ${te.message}`)

  const { data: mi, error: me } = await admin
    .from('menu_items')
    .insert({ restaurant_id: RID, name: `simc-dbg-${randomUUID().slice(0, 6)}`, base_price: 12, status: 'available', track_inventory: false })
    .select('id, name, base_price')
    .single()
  if (me) throw new Error(`menu: ${me.message}`)

  const sid = `probe-simc-dbg-${randomUUID()}`
  const tab = await api('/api/tabs', {
    method: 'POST',
    body: JSON.stringify({ restaurantId: RID, tableNumber: tn, sessionId: sid, displayName: 'dbg' }),
  })
  console.log('TAB     ', tab.status, JSON.stringify(tab.body).slice(0, 260))
  const tabId = tab.body?.tabId || tab.body?.tab?.id
  const token = tab.body?.sessionToken || tab.body?.token || ''

  const ord = await api('/api/orders', {
    method: 'POST',
    headers: token ? { 'x-session-token': token } : {},
    body: JSON.stringify({
      restaurantId: RID,
      tableNumber: tn,
      sessionId: sid,
      tabId,
      memberSessionId: sid,
      items: [
        {
          menuItemId: mi.id,
          name: mi.name,
          displayName: mi.name,
          quantity: 2,
          basePrice: 12,
          selectedVariants: {},
          size: null,
          addons: [],
          specialInstructions: '',
          subtotal: 24,
        },
      ],
      subtotal: 0,
      total: 0,
      orderInstructions: '',
    }),
  })
  console.log('ORDER   ', ord.status, JSON.stringify(ord.body).slice(0, 400))

  const { data: orows } = await admin
    .from('orders')
    .select('id, total, tab_id, status, payment_status, order_number')
    .eq('tab_id', tabId)
  console.log('DB orders on tab   :', JSON.stringify(orows))

  const { data: reqs } = await admin
    .from('order_requests')
    .select('id, total, tab_id, status')
    .eq('tab_id', tabId)
  console.log('DB requests on tab :', JSON.stringify(reqs))

  const { data: t } = await admin.from('tabs').select('total, status').eq('id', tabId).single()
  console.log('DB tabs row        :', JSON.stringify(t))

  // cleanup
  await admin.from('order_requests').delete().eq('tab_id', tabId)
  await admin.from('orders').delete().eq('tab_id', tabId)
  await admin.from('customer_sessions').delete().eq('tab_id', tabId)
  await admin.from('payments').delete().eq('tab_id', tabId)
  await admin.from('tabs').delete().eq('id', tabId)
  await admin.from('restaurant_tables').delete().eq('id', tbl.id)
  await admin.from('menu_items').delete().eq('id', mi.id)
  console.log('cleaned')
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e)
  process.exit(1)
})
