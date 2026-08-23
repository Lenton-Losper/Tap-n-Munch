/**
 * #302 / #305 on PRODUCTION — read-only, and it must distinguish FIXED from BROKEN.
 *
 * Deploy 1 is a redaction: a foreign session must stop receiving `session_id` and
 * `member_session_id` on a guest order read. The whole of what changes is what comes back in one
 * JSON body, so one read tests it — but only if the read is known to WORK. "Both fields are
 * absent" is also what a 404, a 500, a wrong table number and a typo'd query string look like.
 * An assertion that has only ever seen `null` proves nothing.
 *
 * So each shape reports three things, and the first is the point:
 *
 *   [control] did the ORDER ROW come back at all
 *             whether session_id / member_session_id are present
 *             the values, truncated, when they are — so a leak is legible
 *
 * Run it BEFORE the deploy and the ids arrive with the row: the defect observed on production
 * rather than inferred from staging. Run it after and the row must still arrive while the raw ids
 * are gone. A run where a row does not arrive is INCONCLUSIVE, not a pass, and it says so.
 *
 * BOTH SHAPES, because Deploy 1 is two fixes in one file and they leak different fields:
 *
 *   tab order   #302 — `session_id` goes out raw. `member_session_id` is already the derived
 *                      `mk_…` key, because #262's substitution needs a tab and has one.
 *   tab-less    #305 — the derivation cannot run without a `tab_id`, so `member_session_id`
 *                      itself goes out RAW. A tab-order-only check would miss this entirely.
 *
 * STRICTLY READ-ONLY. One `.select()` per shape to find an existing order, and one HTTP GET each.
 * No insert, update, delete or rpc anywhere in this file, and no fixture is seeded — production is
 * not a test environment.
 *
 * SEVERITY, so this is not over-read: on production a leaked id cannot be escalated into a
 * rewritten order, because the edit route does not exist on `main`. It reaches
 * `guest/orders/by-session`, `tabs/[tabId]/view` and the #304 receipt-email route. Disclosure,
 * not takeover.
 *
 *   npx tsx scripts/probe-302-305-production-readonly.ts
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const BASE = process.env.PROD_BASE || 'https://flashtap.app'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!url.includes(PRODUCTION_REF)) {
  throw new Error(
    'REFUSING: this probe is for PRODUCTION and SUPABASE_URL is not the production project.\n' +
      `  wanted a URL containing ${PRODUCTION_REF}, got: ${url || '(unset)'}`,
  )
}
if (!key) throw new Error('REFUSING: no SUPABASE_SERVICE_ROLE_KEY')

const db: SupabaseClient = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const COLUMNS =
  'id, restaurant_id, table_number, session_id, member_session_id, tab_id, status, payment_status, placed_at'

type Outcome = 'leak' | 'closed' | 'inconclusive'

async function checkOne(order: Record<string, unknown>): Promise<Outcome> {
  const ownerSession = String(order.session_id ?? '')
  const ownerMember = String(order.member_session_id ?? '')

  console.log(`  target order : ${String(order.id)}`)
  console.log(`  table_number : ${String(order.table_number)}`)
  console.log(`  status       : ${String(order.status)} / ${String(order.payment_status)}`)
  console.log(`  tab_id       : ${order.tab_id ? String(order.tab_id) : 'null  (the derivation cannot run)'}`)
  console.log(`  placed_at    : ${String(order.placed_at)}`)

  // The foreign caller: a session id that has never existed anywhere.
  const attacker = `probe-foreign-${randomUUID()}`
  const qs = new URLSearchParams({
    restaurantId: String(order.restaurant_id),
    table_number: String(order.table_number),
    session_id: attacker,
  })
  const res = await fetch(`${BASE}/api/guest/orders/${String(order.id)}?${qs.toString()}`, {
    headers: { 'Cache-Control': 'no-cache' },
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON body is reported through `text` below */
  }

  const rows: any[] = Array.isArray(json?.orders) ? json.orders : json?.order ? [json.order] : []
  const row = rows.find((r) => String(r?.id) === String(order.id)) ?? rows[0] ?? null

  // THE POSITIVE CONTROL. Without this, "no ids" cannot be told from "no answer".
  console.log(`  HTTP ${res.status}`)
  console.log(`  [control] the order row came back : ${row ? 'YES' : 'NO'}`)
  if (!row) {
    console.log(`  body: ${text.slice(0, 160)}`)
    console.log('  INCONCLUSIVE — the row did not come back, so absence of ids proves nothing here.')
    return 'inconclusive'
  }

  const report = (label: string, value: unknown, ownerValue: string) => {
    const v = String(value ?? '')
    const present = v.length > 0 && v !== 'null' && v !== 'undefined'
    const isOwnerRaw = ownerValue.length > 0 && v === ownerValue
    const shown = present ? `PRESENT  "${v.slice(0, 26)}${v.length > 26 ? '…' : ''}"` : 'absent/null'
    console.log(`  ${label.padEnd(20)} : ${shown}${isOwnerRaw ? "   <-- THE OWNER'S RAW ID" : ''}`)
    return isOwnerRaw
  }

  const sidRaw = report('session_id', row.session_id, ownerSession)
  const msidRaw = report('member_session_id', row.member_session_id, ownerMember)

  return sidRaw || msidRaw ? 'leak' : 'closed'
}

async function main() {
  console.log('=== #302/#305 production read-only probe ===')
  console.log(`    app: ${BASE}`)
  console.log(`    db : ${PRODUCTION_REF} (READ-ONLY: selects only, no writes)`)

  const version = await fetch(`${BASE}/api/version?cb=${Math.floor(Math.random() * 1e9)}`, {
    headers: { 'Cache-Control': 'no-cache' },
  })
  const served = ((await version.json()) as { commit?: string })?.commit ?? 'unknown'
  console.log(`\nserved commit: ${served}`)

  let anyLeak = false
  let anyInconclusive = false

  for (const shape of ['tab order (#302)', 'tab-less order (#305)'] as const) {
    const tabless = shape.startsWith('tab-less')
    let q = db.from('orders').select(COLUMNS).not('session_id', 'is', null).not('table_number', 'is', null)
    q = tabless ? q.is('tab_id', null) : q.not('tab_id', 'is', null)

    const { data: order, error } = await q.order('placed_at', { ascending: false }).limit(1).maybeSingle()
    if (error) throw new Error(`read failed: ${error.message}`)

    console.log(`\n---- ${shape} ----`)
    if (!order) {
      console.log('  no order of this shape exists on production — nothing to test here.')
      continue
    }
    const outcome = await checkOne(order as Record<string, unknown>)
    if (outcome === 'leak') anyLeak = true
    if (outcome === 'inconclusive') anyInconclusive = true
  }

  console.log('')
  if (anyLeak) {
    console.log('LEAKING — at least one shape handed a foreign session a raw id.')
    console.log('Expected BEFORE the deploy; a defect after it.')
    process.exitCode = 1
  } else if (anyInconclusive) {
    console.log('INCONCLUSIVE — a read did not return its row, so absence of ids proves nothing there.')
    process.exitCode = 2
  } else {
    console.log('CLOSED — every row came back and no raw id did.')
    console.log('The per-shape control above is what makes that meaningful rather than merely quiet.')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
