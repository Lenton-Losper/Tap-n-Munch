// @ts-nocheck
/**
 * #160 — READ ONLY. WHAT ACTUALLY HAPPENED TO THE FOUR BURNED ORDERS, IN ORDER.
 *
 * SELECTs only.
 *
 * probe-160-burned-merchant-order-nos-20260827.ts establishes WHICH orders hold a merchant order
 * number that can never be verified. This one reconstructs the SEQUENCE for each of them from
 * audit_logs and payment_events, which is what says whether the customer was in a loop and how
 * many times the system asked a question it had no way of answering.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const DIGI = 'ed8bda2b-beb0-4da7-9531-5b597344e6d5'
const H = (x) => { console.log('\n' + '='.repeat(100)); console.log(x); console.log('='.repeat(100)) }
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production, got ' + url)
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })
  console.log('READ ONLY — SELECTs only. connected to ' + url)
  console.log('measured ' + new Date().toISOString())

  const { data: orders, error: oErr } = await db
    .from('orders')
    .select('*')
    .eq('restaurant_id', DIGI)
    .not('paycloud_merchant_order_no', 'is', null)
    .order('placed_at', { ascending: true })
  if (oErr) throw new Error(oErr.message)

  for (const o of orders ?? []) {
    H(`ORDER #${o.order_number}  ${o.paycloud_merchant_order_no}  placed ${o.placed_at}`)
    const interesting = [
      'status', 'payment_status', 'payment_method', 'channel', 'total', 'paid_at',
      'payment_reference', 'payment_voucher_no', 'payment_checkout_url', 'terminal_sn',
      'terminal_status', 'cancelled_at', 'cancellation_reason', 'completed_at',
    ]
    for (const k of interesting) {
      if (k in o) console.log('  ' + pad(k, 24) + String(o[k] ?? '—').slice(0, 140))
    }

    const { data: audit, error: aErr } = await db
      .from('audit_logs')
      .select('created_at, action, metadata')
      .eq('entity_id', o.id)
      .order('created_at', { ascending: true })
    if (aErr) { console.log('  audit_logs unreadable: ' + aErr.message); continue }
    console.log(`\n  audit_logs — ${(audit ?? []).length} row(s)`)
    for (const r of audit ?? []) {
      console.log('    ' + pad(r.created_at, 28) + pad(r.action, 40) + JSON.stringify(r.metadata ?? {}).slice(0, 300))
    }

    const { data: pe, error: peErr } = await db
      .from('payment_events')
      .select('*')
      .eq('order_id', o.id)
      .order('created_at', { ascending: true })
    if (peErr) console.log('  payment_events unreadable: ' + peErr.message)
    else console.log(`\n  payment_events — ${(pe ?? []).length} row(s)`)
    for (const r of pe ?? []) console.log('    ' + JSON.stringify(r).slice(0, 400))
  }

  H('EVERY audit_logs ROW AT DIGI COFEE ON 2026-08-26 — the night it fired twice')
  const { data: night, error: nErr } = await db
    .from('audit_logs')
    .select('created_at, entity_type, entity_id, action, metadata')
    .eq('restaurant_id', DIGI)
    .gte('created_at', '2026-08-26T00:00:00Z')
    .order('created_at', { ascending: true })
  if (nErr) console.log('  unreadable: ' + nErr.message)
  for (const r of night ?? []) {
    console.log('  ' + pad(r.created_at, 28) + pad(r.action, 44) + JSON.stringify(r.metadata ?? {}).slice(0, 260))
  }
}

main().catch((e) => { console.error('FAILED:', e?.message ?? e); process.exit(1) })
