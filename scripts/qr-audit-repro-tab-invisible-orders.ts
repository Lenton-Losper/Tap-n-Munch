/**
 * Repro: a customer places a QR order and their Tab page shows nothing (STAGING ONLY).
 *
 * Two independent causes stack. This isolates each so a fix can be shown to close both:
 *
 *   BUG A (wrong table)  fetchGuestOrdersBySession (lib/guest-orders/queries.ts:113) reads
 *                        `orders` only. QR submissions land in `order_requests`. Its siblings
 *                        fetchGuestOrderById and fetchGuestActiveTableOrders both fall back;
 *                        this one does not. So even querying with the CORRECT session id
 *                        returns nothing.
 *
 *   BUG B (wrong id)     Two session-id namespaces exist and nothing syncs them:
 *                          lib/session.ts        -> flashtap_session_v1, localStorage,  `sess_<uuid>`
 *                          contexts/tab-context  -> tab_session_id,      sessionStorage, `session_<ts>_<rand>`
 *                        Orders are submitted with the second. tab/page.tsx:109 queries with
 *                        the first via getCurrentSession(), so the filter can never match.
 *
 *   npx tsx scripts/qr-audit-repro-tab-invisible-orders.ts
 */
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE = process.env.QR_AUDIT_BASE || 'http://localhost:3101'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TABLE = 9101
const ITEM = { id: '9c4a176e-2eda-44e3-a0bc-b5fda4144403', name: 'Chicken burger', price: 25 }

// Exactly how each namespace mints an id.
const tabContextSessionId = () => `session_${Date.now()}_${Math.random().toString(36).slice(2)}`
const legacySessionId = () => `sess_${randomUUID()}`

async function bySession(sessionIds: string[], tabId: string) {
  const qs = new URLSearchParams({ restaurantId: RID, tabId })
  // Repeated params, so this works both before the fix (route reads the first) and after.
  for (const s of sessionIds) qs.append('session_id', s)
  const r = await fetch(`${BASE}/api/guest/orders/by-session?${qs.toString()}`)
  const body = await r.json().catch(() => ({}))
  return { status: r.status, count: Number(body?.count ?? 0), orders: body?.orders ?? [] }
}

async function main() {
  // --- a customer scans, opens a tab, and orders ---
  const submitSid = tabContextSessionId()
  const create = await fetch(`${BASE}/api/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RID, tableNumber: TABLE, sessionId: submitSid, displayName: 'Tab Repro' }),
  })
  const tab = await create.json()
  if (!tab?.tabId) throw new Error(`tab create failed: ${JSON.stringify(tab)}`)

  const submit = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-token': tab.sessionToken },
    body: JSON.stringify({
      restaurantId: RID,
      tableNumber: TABLE,
      sessionId: submitSid,
      memberSessionId: submitSid,
      tabId: tab.tabId,
      items: [{
        menuItemId: ITEM.id, name: ITEM.name, displayName: ITEM.name, quantity: 2,
        basePrice: ITEM.price, selectedVariants: {}, size: null, addons: [],
        specialInstructions: '', subtotal: ITEM.price * 2,
      }],
      subtotal: ITEM.price * 2,
      total: ITEM.price * 2,
      orderInstructions: 'qr-audit tab-visibility repro -- safe to delete',
    }),
  })
  const submitted = await submit.json()
  console.log(`submitted: HTTP ${submit.status} id=${submitted.orderId} status=${submitted.status}`)

  // Ground truth, straight from the DB.
  const { data: reqRow } = await admin
    .from('order_requests').select('id, session_id, status, total').eq('id', submitted.orderId).maybeSingle()
  const { data: orderRow } = await admin
    .from('orders').select('id').eq('id', submitted.orderId).maybeSingle()
  console.log(`DB: order_requests row = ${reqRow ? `${reqRow.id} (${reqRow.status}, N$${reqRow.total})` : 'NONE'}`)
  console.log(`DB: orders row         = ${orderRow ? orderRow.id : 'NONE'}`)

  // --- BUG A: query with the CORRECT session id ---
  const a = await bySession([submitSid], tab.tabId)
  console.log(`\nBUG A  by-session with the submitting id -> HTTP ${a.status}, count ${a.count}`)
  console.log(`       ${a.count === 0 ? 'FAIL: the order exists but is invisible (order_requests never queried)' : 'ok: pending order returned'}`)

  // --- BUG B: the other namespace, alone, as tab/page.tsx used to send it ---
  // Expected to return 0 both before AND after the fix: that id genuinely owns no orders, and
  // matching it anyway would leak another guest's tab. The bug was never that this should
  // return rows -- it was that the page sent ONLY this id. The fix is at the caller, which
  // now sends both; the END check below is what proves it.
  const pageSid = legacySessionId()
  const b = await bySession([pageSid], tab.tabId)
  console.log(`\nBUG B  by-session with getCurrentSession()-style id alone -> HTTP ${b.status}, count ${b.count}`)
  console.log(`       ${b.count === 0 ? 'correctly 0 (fail-closed) -- this id owns nothing; the page must not send it alone' : 'LEAK: matched an order it does not own'}`)

  // --- END STATE: both ids, which is what fetchOrdersForTab now sends ---
  const c = await bySession([pageSid, submitSid], tab.tabId)
  console.log(`\nEND    by-session with BOTH ids -> HTTP ${c.status}, count ${c.count}`)
  console.log(`       ${c.count > 0 ? 'PASS: the customer would see their pending order' : 'FAIL: still invisible'}`)

  // Cleanup.
  await admin.from('order_requests').delete().eq('id', submitted.orderId)
  await admin.from('tabs').delete().eq('id', tab.tabId)
  console.log('\ncleaned up')

  const fixed = a.count > 0 && c.count > 0
  console.log(`\nOVERALL: ${fixed ? 'FIXED' : 'BROKEN'}`)
  process.exit(fixed ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
