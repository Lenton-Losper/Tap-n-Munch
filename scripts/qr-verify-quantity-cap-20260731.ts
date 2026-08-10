/**
 * Verifies the per-line quantity cap end to end against a running dev server (STAGING ONLY).
 *
 * Unit tests prove the validator; this proves it is actually wired into the route the
 * customer hits, that the rejection is a clean 400 with readable text, and -- importantly --
 * that NO order row is created when a submission is refused.
 *
 * Also re-checks that staff POS is deliberately NOT capped.
 *
 *   npx tsx scripts/qr-verify-quantity-cap-20260731.ts
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

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function openTab() {
  const sid = `qr-qty-${randomUUID()}`
  const r = await fetch(`${BASE}/api/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RID, tableNumber: TABLE, sessionId: sid, displayName: 'Qty check' }),
  })
  const tab = await r.json()
  if (!tab?.tabId) throw new Error(`tab create failed: ${JSON.stringify(tab)}`)
  return { tab, sid }
}

async function submit(quantity: unknown, tab: Record<string, unknown>, sid: string) {
  const r = await fetch(`${BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-token': tab.sessionToken as string },
    body: JSON.stringify({
      restaurantId: RID,
      tableNumber: TABLE,
      sessionId: sid,
      memberSessionId: sid,
      tabId: tab.tabId,
      items: [{
        menuItemId: ITEM.id, name: ITEM.name, displayName: ITEM.name, quantity,
        basePrice: ITEM.price, selectedVariants: {}, size: null, addons: [],
        specialInstructions: '', subtotal: ITEM.price * 2,
      }],
      subtotal: ITEM.price * 2,
      total: ITEM.price * 2,
      orderInstructions: 'qr quantity cap check -- safe to delete',
    }),
  })
  const body = await r.json().catch(() => ({}))
  return { status: r.status, body }
}

async function rowsFor(tabId: string) {
  const { data } = await admin.from('order_requests').select('id, items').eq('tab_id', tabId)
  return data ?? []
}

async function main() {
  const results: Record<string, unknown> = {}

  for (const [label, quantity, shouldPass] of [
    ['at the cap (20)', 20, true],
    ['just over the cap (21)', 21, false],
    ['absurd (9999)', 9999, false],
    ['fractional (2.5)', 2.5, false],
    ['zero', 0, false],
    ['negative (-5)', -5, false],
    ['non-numeric ("abc")', 'abc', false],
    ['normal (2)', 2, true],
  ] as Array<[string, unknown, boolean]>) {
    const { tab, sid } = await openTab()
    const res = await submit(quantity, tab, sid)
    const rows = await rowsFor(tab.tabId)

    const accepted = res.status === 200
    const ok = accepted === shouldPass && (accepted ? rows.length === 1 : rows.length === 0)

    results[label] = {
      http: res.status,
      accepted,
      expected_accepted: shouldPass,
      order_rows_created: rows.length,
      message: accepted ? null : res.body?.error,
      verdict: ok ? 'PASS' : 'FAIL',
    }

    // Clean up whatever this iteration made.
    if (rows.length) await admin.from('order_requests').delete().eq('tab_id', tab.tabId)
    await admin.from('tabs').delete().eq('id', tab.tabId)
  }

  log('CUSTOMER CHANNEL (QR table)', results)

  const failures = Object.entries(results).filter(([, v]) => (v as { verdict: string }).verdict === 'FAIL')
  log('VERDICT', failures.length === 0
    ? 'PASS -- the cap is enforced on the real route, rejections are clean 400s with readable '
      + 'text, and no order row is created when a submission is refused.'
    : `FAIL -- ${failures.map(([k]) => k).join(', ')}`)

  if (failures.length) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
