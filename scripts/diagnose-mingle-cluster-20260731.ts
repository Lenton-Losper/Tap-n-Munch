/**
 * READ-ONLY diagnostic for six Mingle orders reported PENDING on 2026-07-31:
 *   #102 (N$45.00, 10:03:24)  #101 (N$45.00, 10:02:10)  #95 (N$50.00, 08:46:57)
 *   #87  (N$77.00, 07:50:42)  #86  (N$32.00, 07:50:11)  #85 (N$32.00, 07:49:41)
 *
 * Two jobs, NO WRITES of any kind:
 *
 *  1. Per order, the same E04111 evidence checklist as the #81 and #76/#69/#64 passes
 *     (scripts/diagnose-mingle-81-20260730.ts). Bar:
 *       1. status = 'pending' AND payment_status = 'pending'
 *       2. NO payment/launch marker ever set
 *       3. paycloud_merchant_order_no present
 *       4. audit_logs empty or only a prior decline/uncertain marker
 *       5. a FRESH live Finatic order.query returns E04111 right now
 *
 *  2. Cluster analysis. Six in a ~2h window is not obviously noise, so pull the signals that
 *     separate "one underlying cause" from "six coincidences": shared channel / table /
 *     session / payment route, idempotency keys, near-duplicate pairs, the audit timing
 *     relative to placement, and -- most decisive -- whether ANY Mingle order succeeded in
 *     the same window. A blanket outage and an intermittent fault look very different there.
 *
 *   npx tsx --env-file=.env.local scripts/diagnose-mingle-cluster-20260731.ts
 */
import { createClient } from '@supabase/supabase-js'
import { getRestaurantFinaticCredentials } from '../lib/payments/finatic-restaurant-credentials'
import { queryFinaticOrderPaid } from '../lib/payments/query-finatic-order-paid'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url || !serviceKey) throw new Error('Missing production Supabase URL / service role key')

const PROJECT = url.replace(/https:\/\/([a-z0-9]+).*/, '$1')
const MINGLE = '131c39d1-b816-407d-8c5f-e628fc38967e'
const TARGET_NUMBERS = [102, 101, 95, 87, 86, 85]

// The window the cluster sits in, widened to catch neighbours on either side.
const WINDOW_START = '2026-07-31T04:00:00.000Z' // 06:00 local
const WINDOW_END = '2026-07-31T10:00:00.000Z'   // 12:00 local

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

/** Local (Africa/Windhoek) wall clock, which is what the dashboard and the operator see. */
function local(iso: unknown): string {
  if (!iso) return '—'
  return new Date(String(iso)).toLocaleString('en-GB', {
    timeZone: 'Africa/Windhoek', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function itemSignature(items: unknown): string {
  if (!Array.isArray(items)) return '(none)'
  return items
    .map((i) => `${Number(i?.quantity) || 1}x${String(i?.display_name || i?.name || '?')}@${Number(i?.basePrice ?? i?.price ?? 0)}`)
    .sort()
    .join(' | ')
}

async function main() {
  console.log(`\n=== READ-ONLY DIAGNOSTIC -- project ${PROJECT} ===`)
  console.log(`=== Mingle ${MINGLE} -- orders ${TARGET_NUMBERS.join(', ')} ===`)
  console.log('=== NO WRITES PERFORMED ===')

  const { data: orders, error } = await admin
    .from('orders')
    .select('*')
    .eq('restaurant_id', MINGLE)
    .in('order_number', TARGET_NUMBERS)
    .order('order_number', { ascending: false })

  if (error) throw new Error(`Order load failed: ${error.message}`)
  console.log(`\nmatched ${orders?.length ?? 0} of ${TARGET_NUMBERS.length} requested order numbers`)

  const verdicts: Array<Record<string, unknown>> = []
  const auditByOrder: Record<number, Array<Record<string, unknown>>> = {}

  for (const o of orders ?? []) {
    const markers = {
      payment_reference: o.payment_reference,
      payment_voucher_no: o.payment_voucher_no,
      payment_checkout_url: o.payment_checkout_url,
      terminal_sn: o.terminal_sn,
      terminal_status: o.terminal_status,
    }
    const markerPresent = Object.entries(markers).filter(([, v]) => v)

    const { data: audit } = await admin
      .from('audit_logs')
      .select('action, created_at, metadata')
      .eq('entity_id', o.id)
      .order('created_at', { ascending: true })
    auditByOrder[Number(o.order_number)] = (audit ?? []) as Array<Record<string, unknown>>

    const { data: pays } = await admin
      .from('payments')
      .select('id, amount, status, payment_reference, created_at')
      .contains('order_ids', [o.id])

    const gate1 = o.status === 'pending' && o.payment_status === 'pending'
    const gate2 = markerPresent.length === 0
    const gate3 = Boolean(o.paycloud_merchant_order_no)

    let finatic: { code: string | null; message: string | null } = { code: null, message: null }
    if (gate3) {
      try {
        const creds = await getRestaurantFinaticCredentials(String(o.restaurant_id))
        const result = await queryFinaticOrderPaid({
          merchantOrderNo: String(o.paycloud_merchant_order_no),
          merchantNo: creds.merchantNo,
          storeNo: creds.storeNo,
        })
        finatic = { code: null, message: `CLEAN RESULT: ${JSON.stringify(result)}` }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        finatic = { code: message.includes('E04111') ? 'E04111' : 'OTHER', message }
      }
    }
    const gate5 = finatic.code === 'E04111'
    const meetsBar = gate1 && gate2 && gate3 && gate5

    verdicts.push({
      orderNumber: o.order_number,
      orderId: o.id,
      total: o.total,
      placed_at_local: local(o.placed_at),
      status: o.status,
      payment_status: o.payment_status,
      paycloud_merchant_order_no: o.paycloud_merchant_order_no,
      gate1_both_pending: gate1,
      gate2_no_markers: gate2,
      markers_present: markerPresent.map(([k]) => k),
      gate3_has_merchant_order_no: gate3,
      gate4_audit_actions: (audit ?? []).map((a) => a.action),
      gate5_finatic_e04111: gate5,
      finatic_code: finatic.code,
      finatic_message: finatic.message,
      payments_rows: (pays ?? []).length,
      VERDICT: meetsBar ? 'MEETS E04111 no-attempt bar' : 'DOES NOT MEET BAR -- do not auto-resolve',
    })
  }

  log('PER-ORDER VERDICTS', verdicts)

  // ---------------------------------------------------------------- cluster analysis
  console.log('\n\n################ CLUSTER ANALYSIS ################')

  const rows = (orders ?? []).slice().sort(
    (a, b) => new Date(String(a.placed_at)).getTime() - new Date(String(b.placed_at)).getTime(),
  )

  log('SHARED ATTRIBUTES (per order)', rows.map((o) => ({
    order: o.order_number,
    placed_local: local(o.placed_at),
    total: o.total,
    table: o.table_number,
    channel: o.channel,
    payment_method: o.payment_method,
    payment_channel: o.payment_channel,
    payment_provider: o.payment_provider,
    terminal_sn: o.terminal_sn,
    session_id: o.session_id,
    member_session_id: o.member_session_id,
    tab_id: o.tab_id,
    idempotency_key: o.idempotency_key,
    merchant_order_no: o.paycloud_merchant_order_no,
    items: itemSignature(o.items),
  })))

  const distinct = (key: string) => [...new Set(rows.map((o) => String((o as Record<string, unknown>)[key] ?? 'null')))]
  log('DISTINCT VALUES ACROSS THE SIX', {
    table_number: distinct('table_number'),
    channel: distinct('channel'),
    payment_method: distinct('payment_method'),
    payment_channel: distinct('payment_channel'),
    payment_provider: distinct('payment_provider'),
    terminal_sn: distinct('terminal_sn'),
    session_id: distinct('session_id'),
    tab_id: distinct('tab_id'),
  })

  // Near-duplicate detection, driven by data rather than by the amounts we were told.
  const pairs: Array<Record<string, unknown>> = []
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j]
      const gapSec = Math.abs(
        (new Date(String(b.placed_at)).getTime() - new Date(String(a.placed_at)).getTime()) / 1000,
      )
      if (gapSec > 15 * 60) continue
      const sameItems = itemSignature(a.items) === itemSignature(b.items)
      const sameTotal = Number(a.total) === Number(b.total)
      if (!sameItems && !sameTotal) continue
      pairs.push({
        pair: `#${a.order_number} + #${b.order_number}`,
        gap_seconds: gapSec,
        same_items: sameItems,
        same_total: sameTotal,
        same_session_id: String(a.session_id) === String(b.session_id),
        same_tab_id: String(a.tab_id) === String(b.tab_id),
        same_table: Number(a.table_number) === Number(b.table_number),
        same_idempotency_key: String(a.idempotency_key) === String(b.idempotency_key),
        idempotency_keys: [a.idempotency_key, b.idempotency_key],
        merchant_order_nos: [a.paycloud_merchant_order_no, b.paycloud_merchant_order_no],
        items_a: itemSignature(a.items),
        items_b: itemSignature(b.items),
      })
    }
  }
  log('NEAR-DUPLICATE PAIRS (<=15 min apart, matching items or total)', pairs.length ? pairs : 'none found')

  // Audit timing: how long after placement did the uncertain marker land?
  log('AUDIT TRAIL TIMING', rows.map((o) => {
    const entries = auditByOrder[Number(o.order_number)] ?? []
    return {
      order: o.order_number,
      placed_local: local(o.placed_at),
      audit: entries.map((a) => ({
        action: a.action,
        at_local: local(a.created_at),
        seconds_after_placement:
          (new Date(String(a.created_at)).getTime() - new Date(String(o.placed_at)).getTime()) / 1000,
        reason: (a.metadata as Record<string, unknown> | null)?.reason ?? null,
      })),
    }
  }))

  // The decisive question: did anything at Mingle succeed in the same window?
  const { data: neighbours } = await admin
    .from('orders')
    .select('order_number, total, status, payment_status, placed_at, paid_at, payment_method, payment_channel, terminal_sn, table_number, paycloud_merchant_order_no')
    .eq('restaurant_id', MINGLE)
    .gte('placed_at', WINDOW_START)
    .lte('placed_at', WINDOW_END)
    .order('placed_at', { ascending: true })

  const targetSet = new Set(TARGET_NUMBERS)
  log(`ALL MINGLE ORDERS ${local(WINDOW_START)} -- ${local(WINDOW_END)}`, (neighbours ?? []).map((o) => ({
    order: o.order_number,
    placed_local: local(o.placed_at),
    total: o.total,
    status: o.status,
    payment_status: o.payment_status,
    paid_local: local(o.paid_at),
    table: o.table_number,
    method: o.payment_method,
    terminal_sn: o.terminal_sn,
    in_cluster: targetSet.has(Number(o.order_number)) ? '<-- REPORTED' : '',
  })))

  const succeeded = (neighbours ?? []).filter((o) => o.payment_status === 'paid')
  const pendingInWindow = (neighbours ?? []).filter((o) => o.payment_status === 'pending')
  log('WINDOW SUMMARY', {
    total_orders_in_window: (neighbours ?? []).length,
    paid: succeeded.length,
    pending: pendingInWindow.length,
    other: (neighbours ?? []).length - succeeded.length - pendingInWindow.length,
    paid_order_numbers: succeeded.map((o) => o.order_number),
    pending_order_numbers: pendingInWindow.map((o) => o.order_number),
    interpretation: succeeded.length
      ? 'Payments DID succeed in this window -- not a blanket outage; look for an intermittent or per-attempt cause'
      : 'NOTHING succeeded in this window -- consistent with an outage or a systematically broken launch path',
  })

  // Are these six the whole story, or part of a longer-running pattern?
  const { data: allPending } = await admin
    .from('orders')
    .select('order_number, total, placed_at, cancellation_reason, status, payment_status')
    .eq('restaurant_id', MINGLE)
    .eq('payment_status', 'pending')
    .order('placed_at', { ascending: false })
  log('EVERY CURRENTLY-PENDING MINGLE ORDER', (allPending ?? []).map((o) => ({
    order: o.order_number, total: o.total, placed_local: local(o.placed_at),
  })))

  log('SUMMARY', verdicts.map((v) => ({
    order: v.orderNumber, total: v.total, placed: v.placed_at_local,
    verdict: v.VERDICT, finatic: v.finatic_code, audit: v.gate4_audit_actions,
  })))
}

main().catch((e) => { console.error(e); process.exit(1) })
