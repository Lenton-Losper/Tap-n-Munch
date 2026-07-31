/**
 * READ-ONLY: what separates the 6 failed POS card payments from the 13 that succeeded in the
 * same window on 2026-07-31? Same restaurant, same channel, same payment route, interleaved
 * in time -- so the cause is per-attempt, not environmental.
 *
 * Also stress-tests the resolution procedure itself. The "no payment attempt" verdict rests
 * on: no marker set + E04111. That is only sound if SUCCESSFUL payments reliably DO set a
 * marker. If a success can also leave every marker null, then E04111 could equally mean
 * "paid under a merchant order number we no longer have" -- and cancelling would be wrong.
 * There is a known history here: commit 8ab91b2 "stop push-to-terminal rotating the merchant
 * order number".
 *
 *   npx tsx --env-file=.env.local scripts/diagnose-mingle-cluster-discriminator-20260731.ts
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!url || !serviceKey) throw new Error('Missing production Supabase URL / service role key')

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const MINGLE = '131c39d1-b816-407d-8c5f-e628fc38967e'
const WINDOW_START = '2026-07-31T04:00:00.000Z'
const WINDOW_END = '2026-07-31T10:00:00.000Z'
const FAILED = [85, 86, 87, 95, 101, 102]

function local(iso: unknown): string {
  if (!iso) return '—'
  return new Date(String(iso)).toLocaleString('en-GB', {
    timeZone: 'Africa/Windhoek', hour12: false,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function log(label: string, value: unknown) {
  console.log(`\n== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  const { data: rows, error } = await admin
    .from('orders')
    .select('*')
    .eq('restaurant_id', MINGLE)
    .gte('placed_at', WINDOW_START)
    .lte('placed_at', WINDOW_END)
    .order('placed_at', { ascending: true })
  if (error) throw new Error(error.message)

  const failedSet = new Set(FAILED)

  log('MARKER PRESENCE: failed vs paid', (rows ?? []).map((o) => ({
    order: o.order_number,
    outcome: failedSet.has(Number(o.order_number)) ? 'PENDING' : String(o.payment_status).toUpperCase(),
    placed: local(o.placed_at),
    paid: local(o.paid_at),
    secs_to_paid: o.paid_at
      ? Math.round((new Date(String(o.paid_at)).getTime() - new Date(String(o.placed_at)).getTime()) / 1000)
      : null,
    payment_reference: o.payment_reference ? 'SET' : null,
    payment_voucher_no: o.payment_voucher_no ? 'SET' : null,
    payment_trans_no: o.payment_trans_no ? 'SET' : null,
    paycloud_transaction_id: o.paycloud_transaction_id ? 'SET' : null,
    checkout_url: o.payment_checkout_url ? 'SET' : null,
    terminal_sn: o.terminal_sn ?? null,
    terminal_status: o.terminal_status ?? null,
    provider: o.payment_provider ?? null,
    merchant_order_no: o.paycloud_merchant_order_no,
  })))

  // Does any successful payment leave every marker null? If so the procedure's core
  // assumption is unsafe.
  const paid = (rows ?? []).filter((o) => o.payment_status === 'paid')
  const paidWithNoMarker = paid.filter(
    (o) => !o.payment_reference && !o.payment_voucher_no && !o.payment_trans_no && !o.paycloud_transaction_id,
  )
  log('PROCEDURE SAFETY CHECK', {
    paid_orders_in_window: paid.length,
    paid_with_every_marker_null: paidWithNoMarker.length,
    offending_order_numbers: paidWithNoMarker.map((o) => o.order_number),
    conclusion: paidWithNoMarker.length === 0
      ? 'SOUND: every successful payment set at least one marker, so "no marker + E04111" reliably means no payment reached Finatic'
      : 'UNSAFE: a payment succeeded with no marker set -- E04111 + no marker can NOT be treated as proof of no attempt',
  })

  // Which marker actually discriminates?
  const markerNames = ['payment_reference', 'payment_voucher_no', 'payment_trans_no', 'paycloud_transaction_id'] as const
  log('MARKER COVERAGE AMONG PAID ORDERS', Object.fromEntries(
    markerNames.map((m) => [
      m,
      `${paid.filter((o) => (o as Record<string, unknown>)[m]).length}/${paid.length} paid orders have it set`,
    ]),
  ))

  // Merchant order number shape -- a rotation bug would show as a stored number that does not
  // match the placement time.
  log('MERCHANT ORDER NO vs PLACEMENT TIME', (rows ?? []).map((o) => {
    const mo = String(o.paycloud_merchant_order_no || '')
    const embedded = mo.startsWith('FT') ? Number(mo.slice(2, 15)) : null
    const placedMs = new Date(String(o.placed_at)).getTime()
    return {
      order: o.order_number,
      outcome: failedSet.has(Number(o.order_number)) ? 'PENDING' : String(o.payment_status).toUpperCase(),
      merchant_order_no: mo,
      embedded_ts_local: embedded ? local(new Date(embedded).toISOString()) : null,
      placed_local: local(o.placed_at),
      drift_seconds: embedded ? Math.round((placedMs - embedded) / 1000) : null,
    }
  }))

  // Any audit noise around the failures that is not the uncertain marker?
  const ids = (rows ?? []).map((o) => String(o.id))
  const { data: audits } = await admin
    .from('audit_logs')
    .select('entity_id, action, created_at')
    .in('entity_id', ids)
    .order('created_at', { ascending: true })
  const byOrder = new Map((rows ?? []).map((o) => [String(o.id), o.order_number]))
  const actionCounts: Record<string, number> = {}
  for (const a of audits ?? []) actionCounts[String(a.action)] = (actionCounts[String(a.action)] ?? 0) + 1
  log('AUDIT ACTIONS ACROSS THE WHOLE WINDOW', {
    counts: actionCounts,
    per_order: (audits ?? []).reduce((acc: Record<string, string[]>, a) => {
      const n = String(byOrder.get(String(a.entity_id)) ?? '?')
      ;(acc[n] ||= []).push(`${a.action}@${local(a.created_at)}`)
      return acc
    }, {}),
  })
}

main().catch((e) => { console.error(e); process.exit(1) })
