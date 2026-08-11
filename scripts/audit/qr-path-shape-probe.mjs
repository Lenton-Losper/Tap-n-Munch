/**
 * READ-ONLY staging probe for the QR-ordering-path audit (ov-e-qraudit).
 *
 * Establishes DATA SHAPE only — tax-rate inclusivity, variant_groups shape, and
 * restaurant payment_methods — because the code audit alone cannot tell whether the
 * divergences it finds in the pricing path are reachable with real rows.
 *
 * PRODUCTION REFUSAL: hard-refuses any URL that is not the staging project ref. The
 * production ref is never named as an allowed value anywhere in this file; the guard is
 * an allowlist of exactly one, so a mistyped or swapped .env cannot widen it.
 *
 * Every statement below is a SELECT. There is no write path in this file.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.test' })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'

const url = String(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '')
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '')

const ref = (url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1] || ''
if (ref !== STAGING_REF) {
  console.error(`REFUSED: resolved project ref "${ref}" is not the staging ref. No query was sent.`)
  process.exit(1)
}
if (!key) {
  console.error('REFUSED: no service role key in .env.test.')
  process.exit(1)
}

const db = createClient(url, key, { auth: { persistSession: false } })

const show = (label, value) => {
  console.log(`\n=== ${label} ===`)
  console.log(JSON.stringify(value, null, 2))
}

const { data: rates, error: ratesError } = await db
  .from('tax_rates')
  .select('id, restaurant_id, name, percentage, is_inclusive, is_default')
show('tax_rates (is_inclusive / percentage)', ratesError || rates)

const { data: items, error: itemsError } = await db
  .from('menu_items')
  .select('id, restaurant_id, name, base_price, has_sizes, sizes, has_addons, addons, variant_groups, tax_rate_id, status')
  .not('variant_groups', 'is', null)
  .limit(25)
show('menu_items with variant_groups', itemsError || items)

const { data: settings, error: settingsError } = await db
  .from('restaurant_settings')
  .select('restaurant_id, payment_methods, settings_version')
show('restaurant_settings.payment_methods', settingsError || settings)

const { data: creds, error: credsError } = await db
  .from('restaurants')
  .select('id, name, finatic_merchant_no, finatic_store_no, finatic_checkout_merchant_no, finatic_checkout_store_no')
show(
  'restaurants — which Finatic fields are populated (values masked)',
  credsError ||
    (creds || []).map((r) => ({
      id: r.id,
      name: r.name,
      hasMerchantNo: Boolean(String(r.finatic_merchant_no || '').trim()),
      hasStoreNo: Boolean(String(r.finatic_store_no || '').trim()),
      hasCheckoutMerchantNo: Boolean(String(r.finatic_checkout_merchant_no || '').trim()),
      hasCheckoutStoreNo: Boolean(String(r.finatic_checkout_store_no || '').trim()),
    }))
)

const { data: requests, error: requestsError } = await db
  .from('order_requests')
  .select('status, channel, payment_method, payment_channel')
  .limit(500)
if (requestsError) {
  show('order_requests status distribution', requestsError)
} else {
  const counts = {}
  for (const r of requests || []) {
    const k = `${r.status} | ch=${r.channel} | pm=${r.payment_method} | pc=${r.payment_channel}`
    counts[k] = (counts[k] || 0) + 1
  }
  show('order_requests status distribution', counts)
}
