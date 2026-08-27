import { readFileSync } from 'node:fs'
import { queryFinaticOrderPaid } from '@/lib/payments/query-finatic-order-paid'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'
const ENV = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const sec = (n: string): string => {
  for (const l of readFileSync(ENV,'utf8').split(/\r?\n/)) { const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && m[1]===n) return m[2].trim().replace(/^["']|["']$/g,'') }
  throw new Error(n)
}
for (const k of ['NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','PAYCLOUD_ENDPOINT','PAYCLOUD_APP_ID','PAYCLOUD_GATEWAY_PUBLIC_KEY','PAYCLOUD_NOTIFY_URL','PAYCLOUD_RETURN_URL','PAYCLOUD_PRIVATE_KEY','PAYCLOUD_SIGNATURE_BASE64URL','PAYCLOUD_MERCHANT_NO','PAYCLOUD_STORE_NO','PAYCLOUD_TERMINAL_SN']) {
  try { process.env[k] = process.env[k] || sec(k) } catch { /* optional */ }
}
const RIVIERA = '2ca7e63a-dd8e-4bfa-9b0b-e0e6b0b6a0b6'
async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { data: v } = await sb.from('restaurants').select('id').eq('name','Riviera').single()
  const creds = await getRestaurantFinaticCredentials(v!.id)
  const CASES: Array<[string,string,string]> = [
    ['#12  CASH order (what the control PICKS)', 'FT17870967741284193', 'cash'],
    ['#6   CARD order (what it SHOULD pick)',    'FT17865507287746658', 'card'],
  ]
  for (const [label, ref, method] of CASES) {
    try {
      const r = await queryFinaticOrderPaid({ merchantOrderNo: ref, merchantNo: creds.merchantNo, storeNo: creds.storeNo })
      console.log(`\n${label}\n  method=${method} paid=${r.paid} recognised=${r.statusRecognised} status=${r.status} amount=${r.amount}`)
    } catch (e) {
      console.log(`\n${label}\n  method=${method} THREW: ${e instanceof Error ? e.message : e}`)
    }
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
