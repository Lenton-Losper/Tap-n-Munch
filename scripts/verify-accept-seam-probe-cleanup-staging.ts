/**
 * READ-ONLY: confirm scripts/probe-accept-seam-pricing-staging.ts left nothing behind.
 *
 * The probe cleans up in `finally`, so this should report zero of everything even after a run
 * that failed mid-way. Run it after any probe run.
 *
 *   npx tsx scripts/verify-accept-seam-probe-cleanup-staging.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const url = process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (url.includes(PRODUCTION_REF)) throw new Error('REFUSING: PRODUCTION url')
if (!url.includes(STAGING_REF)) throw new Error(`REFUSING: not staging (${url})`)

function log(label: string, value: unknown) {
  console.log(`== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: menu } = await admin
    .from('menu_items')
    .select('id, name, base_price')
    .eq('restaurant_id', RESTAURANT_ID)
    .like('name', 'acceptseam-%')
  log('leftover probe menu_items', menu)

  const { data: requests } = await admin
    .from('order_requests')
    .select('id, status, session_id')
    .eq('restaurant_id', RESTAURANT_ID)
    .like('session_id', 'sess_acceptseam-%')
  log('leftover probe order_requests', requests)

  const { data: orders } = await admin
    .from('orders')
    .select('id, total, idempotency_key, customer_name')
    .eq('restaurant_id', RESTAURANT_ID)
    .like('customer_name', 'Accept Seam Probe%')
  log('leftover probe orders', orders)

  const { data: users } = await admin
    .from('users')
    .select('id, email')
    .like('email', 'acceptseam-%@flashtap-test.invalid')
  log('leftover probe users', users)

  const { data: seeded } = await admin
    .from('menu_items')
    .select('name, base_price, status')
    .eq('restaurant_id', RESTAURANT_ID)
    .in('name', ['Flat White', 'Cappuccino', 'Fries', 'Beef Burger', 'Still Water'])
    .order('name')
  log('seeded fixture prices (must be unchanged by the probe)', seeded)

  const leftovers =
    (menu?.length || 0) + (requests?.length || 0) + (orders?.length || 0) + (users?.length || 0)
  if (leftovers > 0) {
    throw new Error(`${leftovers} probe row(s) left behind`)
  }
  console.log('VERIFY_ACCEPT_SEAM_PROBE_CLEANUP_OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
