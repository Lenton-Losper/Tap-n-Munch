// @ts-nocheck
import { config } from 'dotenv'
config({ path: 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local', override: true })
const CN = 'b161c758-582d-4dfa-839a-9fa35c492a49'
const MG = '131c39d1-b816-407d-8c5f-e628fc38967e'
async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (!url.includes('ihlmmpmolnpchzgwyhgh')) throw new Error('not production')
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', { auth: { persistSession: false } })
  const want = { [CN]: [1250,1251,1297,1360,1382,1393,1426], [MG]: [667,676,677] }
  for (const [rid, nums] of Object.entries(want)) {
    const { data: rows } = await db.from('orders')
      .select('id,order_number,status,payment_status,cancelled_at,cancellation_reason')
      .eq('restaurant_id', rid).in('order_number', nums).order('order_number')
    for (const o of rows ?? []) {
      const { data: au } = await db.from('audit_logs')
        .select('action,metadata,created_at').eq('entity_id', o.id).eq('action', 'order.cancelled')
      const m = au?.[0]?.metadata ?? {}
      console.log('#' + String(o.order_number).padEnd(6) + String(o.status).padEnd(11) + '/' + String(o.payment_status).padEnd(10) +
        ' auditRows=' + (au ?? []).length + ' basis=' + (m.basis ?? '-') + ' ctl=#' + (m.positiveControl?.orderNumber ?? '-') +
        ' gw=' + String(m.gatewayAnswer ?? '-').slice(0,7) + ' reasonLen=' + String(o.cancellation_reason ?? '').length)
    }
  }
  console.log('\n--- untouched controls / originals ---')
  const { data: keep } = await db.from('orders').select('order_number,status,payment_status,total,restaurant_id')
    .in('order_number', [546, 678, 690, 694]).in('restaurant_id', [CN, MG]).order('order_number')
  for (const o of keep ?? []) {
    console.log('#' + String(o.order_number).padEnd(6) + (o.restaurant_id === CN ? 'ChowNow' : 'Mingle ') + '  ' +
      o.status + '/' + o.payment_status + '  N$' + o.total)
  }
  console.log('\n--- Mingle six left pending ---')
  const { data: left } = await db.from('orders').select('order_number,status,payment_status,total')
    .eq('restaurant_id', MG).in('order_number', [435,462,494,523,548,615]).order('order_number')
  console.log((left ?? []).map(o => '#' + o.order_number + ' ' + o.status + '/' + o.payment_status).join('  '))
  console.log('\nVERIFY_OK')
}
main().catch(e => { console.error('ABORTED:', e.message); process.exitCode = 1 })
