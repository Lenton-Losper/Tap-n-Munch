/**
 * READ-ONLY. Queries Finatic for the six Mingle held orders plus a positive control.
 * Writes NOTHING. The write pass is a separate script that re-queries in its own run.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { queryFinaticOrderPaid } from '@/lib/payments/query-finatic-order-paid'
import { getRestaurantFinaticCredentials } from '@/lib/payments/finatic-restaurant-credentials'

const ENV = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const sec = (n: string): string => {
  for (const l of readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === n) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`missing ${n}`)
}
// Every variable paycloud.js's requiredEnv() reads, loaded from .env.local. A missing one throws
// at query time and every order reads as an ERROR -- which is why the positive control below is
// not optional: without it, six failed calls look exactly like six not-paid answers.
const NEEDED = [
  'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  // Exactly what payments/paycloud.js requiredEnv()s -- enumerated from the source, not guessed.
  // My first list was assembled from a grep whose regex truncated names at the first digit.
  'PAYCLOUD_ENDPOINT', 'PAYCLOUD_APP_ID', 'PAYCLOUD_GATEWAY_PUBLIC_KEY',
  'PAYCLOUD_NOTIFY_URL', 'PAYCLOUD_RETURN_URL',
]
const missing: string[] = []
for (const k of NEEDED) {
  try { process.env[k] = process.env[k] || sec(k) } catch { missing.push(k) }
}
for (const k of ['PAYCLOUD_PRIVATE_KEY', 'PAYCLOUD_SIGNATURE_BASE64URL', 'PAYCLOUD_SIGN_TYPE', 'PAYCLOUD_MERCHANT_NO', 'PAYCLOUD_STORE_NO', 'PAYCLOUD_TERMINAL_SN']) {
  try { process.env[k] = process.env[k] || sec(k) } catch { /* genuinely optional */ }
}
if (missing.length) {
  console.error('REFUSING: missing env -> ' + missing.join(', '))
  process.exit(2)
}
process.env.SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

async function main() {
  const { data: venue } = await sb.from('restaurants').select('id, name').ilike('name', 'Mingle%').single()
  if (!venue) throw new Error('venue not found')
  const creds = await getRestaurantFinaticCredentials(venue.id)
  console.log(`venue: ${venue.name}  merchant=${String(creds.merchantNo).slice(0,4)}…  store=${String(creds.storeNo).slice(0,4)}…`)

  const { data: held } = await sb
    .from('orders')
    .select('id, order_number, total, placed_at, paycloud_merchant_order_no, payment_status, status, channel')
    .eq('restaurant_id', venue.id)
    .eq('payment_status', 'pending')
    .lt('placed_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    .order('placed_at', { ascending: true })

  console.log(`\nheld orders: ${held?.length ?? 0}\n`)
  console.log('ord   total   age_d  ref                    | gateway paid  recognised  status        amount  txn')
  console.log('-'.repeat(112))

  for (const o of held ?? []) {
    const age = ((Date.now() - new Date(o.placed_at as string).getTime()) / 86400000).toFixed(1)
    const ref = o.paycloud_merchant_order_no as string | null
    if (!ref) { console.log(`${String(o.order_number).padEnd(5)} ${String(o.total).padEnd(7)} ${age.padEnd(6)} (no gateway reference)   | UNVERIFIABLE - nothing to ask about`); continue }
    try {
      const r = await queryFinaticOrderPaid({ merchantOrderNo: ref, merchantNo: creds.merchantNo, storeNo: creds.storeNo })
      console.log(`${String(o.order_number).padEnd(5)} ${String(o.total).padEnd(7)} ${age.padEnd(6)} ${ref.padEnd(22)} | ${String(r.paid).padEnd(12)} ${String(r.statusRecognised).padEnd(11)} ${r.status.padEnd(13)} ${String(r.amount).padEnd(7)} ${r.transactionId ?? '-'}`)
    } catch (e) {
      console.log(`${String(o.order_number).padEnd(5)} ${String(o.total).padEnd(7)} ${age.padEnd(6)} ${ref.padEnd(22)} | ERROR ${e instanceof Error ? e.message : e}`)
    }
  }

  // POSITIVE CONTROL: a known-PAID order at this venue must come back paid=true.
  // Without it, six "not paid" answers are indistinguishable from six failed calls.
  const { data: ctl } = await sb
    .from('orders')
    .select('order_number, paycloud_merchant_order_no, total')
    .eq('restaurant_id', venue.id).eq('payment_status', 'paid')
    .not('paycloud_merchant_order_no', 'is', null)
    .order('paid_at', { ascending: false }).limit(1).single()
  console.log('\nPOSITIVE CONTROL (a known-paid order at this venue):')
  if (!ctl) { console.log('  *** NO CONTROL AVAILABLE — the six answers below prove nothing ***'); return }
  const cr = await queryFinaticOrderPaid({ merchantOrderNo: ctl.paycloud_merchant_order_no as string, merchantNo: creds.merchantNo, storeNo: creds.storeNo })
  console.log(`  order #${ctl.order_number} (N$${ctl.total}) -> paid=${cr.paid} recognised=${cr.statusRecognised} status=${cr.status} amount=${cr.amount}`)
  console.log(cr.paid ? '  CONTROL PASSES — the gateway is answering and we can read it.' : '  *** CONTROL FAILED — do NOT trust any not-paid answer above ***')
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
