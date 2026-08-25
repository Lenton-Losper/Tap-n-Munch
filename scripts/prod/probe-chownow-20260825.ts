/**
 * FNB ChowNow, 2026-08-25 — READ ONLY. Gateway truth for the non-settled orders.
 *
 * Asks Finatic directly, with ChowNow's own credentials, whether each candidate was charged.
 *
 * LIVE POSITIVE CONTROLS IN THE SAME RUN, and this is not optional. A query path that has broken —
 * wrong credentials, an expired session, a gateway outage — returns "not paid" for everything, and
 * "not paid" is exactly the answer that would authorise a cancel. Controls are orders KNOWN to be
 * paid, from the same venue and the same morning: if a control does not come back PAID, every other
 * reading in this run is worthless and nothing may be acted on.
 *
 * This is the read half only. It writes nothing.
 */
// @ts-nocheck
import { config } from 'dotenv'
import { resolve } from 'path'

// The PRODUCTION env: this worktree's own .env.local points at staging, and the Finatic client
// needs the production PAYCLOUD_* credentials as well as the production Supabase keys.
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const { queryFinaticOrderPaid } = await import('../../lib/payments/query-finatic-order-paid')

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url.includes(PROD_REF)) throw new Error(`REFUSING: not production — ${url}`)
  const db = createClient(url, key, { auth: { persistSession: false } })

  const CN = 'b161c758-582d-4dfa-839a-9fa35c492a49'
  const { data: venue } = await db
    .from('restaurants')
    .select('name, finatic_merchant_no, finatic_store_no')
    .eq('id', CN)
    .single()
  if (!venue?.finatic_merchant_no || !venue?.finatic_store_no) {
    console.log('REFUSING: ChowNow has no Finatic credentials — every reading would be unverifiable.')
    process.exit(2)
  }
  console.log(`venue: ${venue.name}   merchant ${venue.finatic_merchant_no} / store ${venue.finatic_store_no}`)

  const ask = async (label: string, orderNumber: number, bno: string | null) => {
    if (!bno) {
      console.log(`  ${label} #${orderNumber}  NO GATEWAY REFERENCE — nothing to query`)
      return { orderNumber, verdict: 'no_reference' as const }
    }
    const at = new Date().toISOString()
    try {
      const r = await queryFinaticOrderPaid({
        merchantOrderNo: bno,
        merchantNo: String(venue.finatic_merchant_no),
        storeNo: String(venue.finatic_store_no),
      })
      console.log(
        `  ${label} #${orderNumber}  paid=${String(r.paid).padEnd(5)} status=${String(r.transStatus ?? '-').padEnd(4)}` +
          ` amount=${r.amount ?? '-'}  recognised=${r.recognised ?? '-'}  code=${r.gatewayCode ?? '-'}  at ${at}`,
      )
      return { orderNumber, verdict: r.paid ? ('paid' as const) : ('not_paid' as const), raw: r, at }
    } catch (e) {
      console.log(`  ${label} #${orderNumber}  UNREACHABLE: ${e instanceof Error ? e.message : e}`)
      return { orderNumber, verdict: 'unreachable' as const, at }
    }
  }

  // ---------------------------------------------------------------- controls first
  console.log('\nLIVE POSITIVE CONTROLS — known-paid orders from the same venue, same morning.')
  console.log('If any of these is not PAID, the query path is broken and NOTHING below may be acted on.')
  const { data: controls } = await db
    .from('orders')
    .select('order_number, paycloud_merchant_order_no')
    .eq('restaurant_id', CN)
    .eq('payment_status', 'paid')
    .not('paycloud_merchant_order_no', 'is', null)
    .gte('placed_at', new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString())
    .order('placed_at', { ascending: false })
    .limit(3)

  const controlResults = []
  for (const c of controls ?? []) {
    controlResults.push(await ask('CONTROL', c.order_number, c.paycloud_merchant_order_no))
  }
  const controlsOk = controlResults.length >= 2 && controlResults.every((c) => c.verdict === 'paid')
  console.log(`  => controls ${controlsOk ? 'PASS — the query path is working' : '*** FAILED — readings below are worthless ***'}`)

  // ---------------------------------------------------------------- candidates
  console.log('\nCANDIDATES — every non-settled order at this venue')
  const { data: stranded } = await db
    .from('orders')
    .select('order_number, total, payment_status, status, paycloud_merchant_order_no, placed_at')
    .eq('restaurant_id', CN)
    .not('payment_status', 'in', '("paid","cancelled")')
    .neq('status', 'cancelled')
    .order('placed_at')

  const results = []
  for (const o of stranded ?? []) {
    results.push({ ...(await ask('CANDIDATE', o.order_number, o.paycloud_merchant_order_no)), total: o.total })
  }

  // ---------------------------------------------------------------- the cancelled-then-repeated pair
  console.log('\n#1254 — CANCELLED, then #1255 rang up again with the same items. Was #1254 charged?')
  const { data: pair } = await db
    .from('orders')
    .select('order_number, total, status, payment_status, paycloud_merchant_order_no, cancellation_reason')
    .eq('restaurant_id', CN)
    .in('order_number', [1254, 1255])
    .order('order_number')
  for (const o of pair ?? []) {
    console.log(`  #${o.order_number} ${o.status}/${o.payment_status} N$${o.total} reason=${o.cancellation_reason ?? '-'}`)
    await ask('  ->', o.order_number, o.paycloud_merchant_order_no)
  }

  console.log('\n=============================================================')
  console.log('VERDICTS')
  console.log('=============================================================')
  console.log(`  controls: ${controlsOk ? 'PASS' : 'FAIL — DO NOT ACT'}`)
  for (const r of results) {
    console.log(`  #${r.orderNumber}  N$${r.total}  ->  ${r.verdict.toUpperCase()}`)
  }
  console.log('\n  paid        -> DO NOT CANCEL. Route through markOrderPaidConfirmed.')
  console.log('  unreachable -> DO NOT CANCEL. Unreachable is not "not charged".')
  console.log('  no_reference-> no charge is possible; safe to cancel.')
  console.log('  not_paid    -> gateway confirms no charge; safe to cancel.')
  console.log('\nPROBE_CHOWNOW_OK')
}

main().catch((e) => {
  console.error('ABORTED:', e instanceof Error ? e.message : e)
  process.exitCode = 1
})
