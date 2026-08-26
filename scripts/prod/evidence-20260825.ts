// @ts-nocheck
/**
 * READ ONLY. Two questions:
 *  (1) The ONLY false positive that matters: a PAID order carrying neither marker. If the
 *      discriminator were "no markers => not paid" those would be miscancelled. Query them
 *      against Finatic: they must come back PAID, proving the gateway leg catches what the
 *      marker leg misses. This is a positive control for the exact failure mode, not a generic one.
 *  (2) Mingle #676/#677/#678 - PROVE they are one sale, do not infer it.
 */
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const CN = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const MG = '131c39d1-b816-407d-8c5f-e628fc38967e'

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const { queryFinaticOrderPaid } = await import('../../lib/payments/query-finatic-order-paid')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes(PROD_REF)) throw new Error('REFUSING: not production')
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })

  const creds = {}
  for (const id of [CN, MG]) {
    const { data } = await db.from('restaurants').select('name,finatic_merchant_no,finatic_store_no').eq('id', id).single()
    creds[id] = data
  }
  const ask = async (rid, bno) => {
    if (!bno) return { verdict: 'no_reference' }
    try {
      const r = await queryFinaticOrderPaid({ merchantOrderNo: bno,
        merchantNo: String(creds[rid].finatic_merchant_no), storeNo: String(creds[rid].finatic_store_no) })
      return { verdict: r.paid ? 'PAID' : 'not_paid', raw: r }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e)
      return { verdict: m.includes('E04111') ? 'E04111' : 'ERROR', msg: m }
    }
  }

  console.log('\n########## (1) POSITIVE CONTROL: PAID orders with NEITHER marker ##########')
  for (const [rid, label] of [[CN, 'ChowNow'], [MG, 'Mingle']]) {
    const rows = []
    for (let f = 0; ; f += 1000) {
      const { data, error } = await db.from('orders')
        .select('order_number,total,payment_status,payment_method,paycloud_merchant_order_no,payment_reference,payment_voucher_no,placed_at')
        .eq('restaurant_id', rid).eq('payment_status', 'paid').neq('payment_method', 'cash')
        .is('payment_reference', null).is('payment_voucher_no', null).range(f, f + 999)
      if (error) throw new Error(error.message)
      rows.push(...(data ?? [])); if (!data || data.length < 1000) break
    }
    console.log('\n' + label + ': ' + rows.length + ' paid order(s) with neither marker')
    for (const o of rows) {
      const r = await ask(rid, o.paycloud_merchant_order_no)
      console.log('  #' + o.order_number + '  N$' + o.total + '  bno=' + (o.paycloud_merchant_order_no ?? 'NONE') +
        '  -> gateway says ' + r.verdict + (r.raw ? ' amount=' + r.raw.amount : '') + '   ' + String(o.placed_at).slice(0,19))
    }
  }

  console.log('\n########## (2) Mingle #676 / #677 / #678 - PROVE, do not infer ##########')
  const { data: trio } = await db.from('orders')
    .select('id,order_number,total,subtotal,status,payment_status,items,terminal_sn,paycloud_merchant_order_no,payment_reference,payment_voucher_no,placed_at,paid_at,payment_attempt_started_at,payment_attempt_source,table_number,channel')
    .eq('restaurant_id', MG).in('order_number', [675, 676, 677, 678, 679]).order('order_number')
  for (const o of trio ?? []) {
    console.log('\n  #' + o.order_number + '  ' + o.status + '/' + o.payment_status + '  N$' + o.total +
      '  placed ' + String(o.placed_at).slice(0,19) + '  paid_at ' + String(o.paid_at ?? '-').slice(0,19))
    console.log('     id=' + o.id)
    console.log('     bno=' + o.paycloud_merchant_order_no + '  ref=' + (o.payment_reference ?? '-') + '  voucher=' + (o.payment_voucher_no ?? '-'))
    console.log('     terminal_sn=' + (o.terminal_sn ?? '-') + '  attempt_started=' + String(o.payment_attempt_started_at ?? '-').slice(0,19) + '  src=' + (o.payment_attempt_source ?? '-'))
    const items = Array.isArray(o.items) ? o.items : []
    console.log('     ITEMS: ' + items.map(i => (i.quantity ?? i.qty) + ' x ' + (i.name ?? i.item_name) + ' @' + (i.price ?? '-')).join(' | '))
  }

  console.log('\n  --- audit_logs + payment_events naming any of them ---')
  const ids = (trio ?? []).map(o => o.id)
  const { data: ev } = await db.from('payment_events')
    .select('created_at,event_type,order_ids,amount,metadata').overlaps('order_ids', ids).order('created_at')
  for (const e of ev ?? []) {
    const which = (e.order_ids ?? []).map(i => (trio ?? []).find(t => t.id === i)?.order_number ?? i.slice(0,8))
    console.log('   ' + String(e.created_at).slice(0,19) + '  ' + String(e.event_type).padEnd(30) + ' #' + which.join(',#') +
      '  amount=' + (e.amount ?? '-') + '  ' + JSON.stringify(e.metadata ?? {}).slice(0, 220))
  }
  console.log('\n  --- gateway truth for the trio ---')
  for (const o of trio ?? []) {
    const r = await ask(MG, o.paycloud_merchant_order_no)
    console.log('   #' + o.order_number + ' (' + o.payment_status + ')  -> ' + r.verdict + (r.raw ? '  amount=' + r.raw.amount + ' transNo=' + (r.raw.transNo ?? '-') : ''))
  }
  console.log('\nEVIDENCE_OK')
}
main().catch(e => { console.error('ABORTED:', e.message); process.exitCode = 1 })
