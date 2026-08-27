// @ts-nocheck
/**
 * #160 — READ ONLY. WHICH ORDERS CARRY A MERCHANT ORDER NUMBER THAT NO CREDENTIAL SET CAN VERIFY.
 *
 * SELECTs only; this script writes nothing and must never be given a write.
 *
 * `prepare-payment` mints `orders.paycloud_merchant_order_no` without ever reading the venue's
 * Finatic credentials. At a venue with no merchant/store pair the number is BURNED: it looks
 * gateway-issued, no query can ever be formed against it, and every later probe lands in the
 * credential throw.
 *
 * Measures three things and prints the date, because a count is a measurement (Rule 20):
 *   1. Every venue's card pair, and whether its shape is plausible (12-digit merchant, 10-digit
 *      store) rather than merely present — Riviera's historical 123/456 passed a presence check.
 *   2. Every order carrying a paycloud_merchant_order_no at a venue with NO usable card pair,
 *      with its current status pair and its timestamps. That is the burned-number population.
 *   3. Recent prepare-payment activity at credential-less venues, to establish whether the defect
 *      is still firing rather than only that it once did.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const H = (x) => { console.log('\n' + '='.repeat(100)); console.log(x); console.log('='.repeat(100)) }
const pad = (s, n) => String(s === null || s === undefined ? '-' : s).slice(0, n).padEnd(n)

/** Shape, not presence. See scripts/check-venue-payment-readiness.mjs — same rule, same digits. */
const plausibleMerchant = (v) => /^\d{12}$/.test(String(v ?? '').trim())
const plausibleStore = (v) => /^\d{10}$/.test(String(v ?? '').trim())

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production, got ' + url)
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
    auth: { persistSession: false },
  })
  console.log('READ ONLY — SELECTs only. connected to ' + url)
  console.log('measured ' + new Date().toISOString())

  const { data: venues, error: vErr } = await db
    .from('restaurants')
    .select('id, name, finatic_merchant_no, finatic_store_no, finatic_terminal_sn, checkout_merchant_no, checkout_store_no')
    .order('created_at', { ascending: true })
  if (vErr) throw new Error(vErr.message)

  H('1. CARD PAIR PER VENUE — presence AND shape')
  const credentialless = new Set()
  const malformed = new Set()
  console.log('  ' + pad('venue', 24) + pad('merchant', 16) + pad('store', 14) + 'verdict')
  for (const v of venues ?? []) {
    const m = String(v.finatic_merchant_no ?? '').trim()
    const s = String(v.finatic_store_no ?? '').trim()
    let verdict
    if (!m || !s) { verdict = 'NO CARD PAIR — getRestaurantFinaticCredentials THROWS'; credentialless.add(v.id) }
    else if (!plausibleMerchant(m) || !plausibleStore(s)) { verdict = 'MALFORMED — credentials succeed, every gateway call carries garbage'; malformed.add(v.id) }
    else verdict = 'ok'
    console.log('  ' + pad(v.name, 24) + pad(m || '—', 16) + pad(s || '—', 14) + verdict)
  }
  console.log(`\n  ${credentialless.size} venue(s) with NO card pair; ${malformed.size} with a malformed one.`)

  H('2. BURNED NUMBERS — orders holding paycloud_merchant_order_no at a venue that cannot verify')
  const rows = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db
      .from('orders')
      .select('id, restaurant_id, order_number, channel, payment_method, payment_status, status, total, paycloud_merchant_order_no, placed_at, paid_at, cancellation_reason')
      .not('paycloud_merchant_order_no', 'is', null)
      .order('placed_at', { ascending: true })
      .range(f, f + 999)
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  const vname = new Map((venues ?? []).map((v) => [v.id, v.name]))
  console.log(`  ${rows.length} order(s) carry a merchant order number at all.`)

  const burned = rows.filter((o) => credentialless.has(o.restaurant_id))
  const onMalformed = rows.filter((o) => malformed.has(o.restaurant_id))

  console.log(`\n  BURNED (venue has no card pair): ${burned.length}`)
  console.log('  ' + pad('venue', 14) + pad('#', 5) + pad('status/payment', 26) + pad('total', 8) + pad('merchant order no', 24) + pad('created', 22) + 'cancellation_reason')
  for (const o of burned) {
    console.log('  ' + pad(vname.get(o.restaurant_id), 14) + pad(o.order_number, 5) +
      pad(`${o.status}/${o.payment_status}`, 26) + pad(o.total, 8) +
      pad(o.paycloud_merchant_order_no, 24) + pad(o.placed_at, 22) +
      String(o.cancellation_reason ?? '—'))
  }

  console.log(`\n  ON A MALFORMED PAIR (credentials succeed, answers are meaningless): ${onMalformed.length}`)
  for (const o of onMalformed) {
    console.log('  ' + pad(vname.get(o.restaurant_id), 14) + pad(o.order_number, 5) +
      pad(`${o.status}/${o.payment_status}`, 26) + pad(o.paycloud_merchant_order_no, 24) +
      String(o.placed_at))
  }

  H('3. IS IT STILL FIRING? merchant order numbers minted at credential-less venues, by day')
  const byDay = new Map()
  for (const o of burned) {
    const d = String(o.placed_at ?? '').slice(0, 10)
    byDay.set(d, (byDay.get(d) ?? 0) + 1)
  }
  for (const [d, n] of [...byDay.entries()].sort()) console.log('  ' + pad(d, 14) + n)

  H('4. THE SAME VENUES\' ORDERS WITHOUT A NUMBER — the easier class, for contrast')
  for (const rid of credentialless) {
    const { data, error } = await db
      .from('orders')
      .select('order_number, status, payment_status, payment_method, total, placed_at')
      .eq('restaurant_id', rid)
      .is('paycloud_merchant_order_no', null)
      .order('placed_at', { ascending: false })
      .limit(20)
    if (error) throw new Error(error.message)
    console.log(`\n  ${vname.get(rid)} — ${(data ?? []).length} shown (most recent first)`)
    for (const o of data ?? []) {
      console.log('    ' + pad(o.order_number, 5) + pad(`${o.status}/${o.payment_status}`, 26) +
        pad(o.payment_method, 10) + pad(o.total, 8) + String(o.placed_at))
    }
  }

  H('5. AUDIT TRAIL — payment_status_changes / order audit rows at credential-less venues')
  for (const o of burned) {
    const { data, error } = await db
      .from('order_audit_log')
      .select('event_type, created_at, details')
      .eq('order_id', o.id)
      .order('created_at', { ascending: true })
      .limit(50)
    if (error) { console.log('    (order_audit_log unreadable: ' + error.message + ')'); break }
    console.log(`\n  order #${o.order_number} (${o.paycloud_merchant_order_no}) — ${(data ?? []).length} audit row(s)`)
    for (const r of data ?? []) {
      console.log('    ' + pad(r.created_at, 26) + pad(r.event_type, 40) + JSON.stringify(r.details ?? {}).slice(0, 160))
    }
  }
}

main().catch((e) => { console.error('FAILED:', e?.message ?? e); process.exit(1) })
