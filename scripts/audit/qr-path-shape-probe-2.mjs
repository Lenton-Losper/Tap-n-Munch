/**
 * READ-ONLY staging probe #2 for the QR-ordering-path audit (ov-e-qraudit).
 *
 * Follow-up to qr-path-shape-probe.mjs, which guessed the wrong Finatic column names and
 * could not distinguish "variant_groups is []" from "variant_groups has priced options".
 * Correct column names come from lib/cache/restaurant-cache.ts:5 at 21d5133.
 *
 * PRODUCTION REFUSAL: allowlist of exactly one project ref (staging). The production ref
 * is never named here, so no swapped .env can widen the allowlist.
 *
 * Every statement below is a SELECT.
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

const { data: creds, error: credsError } = await db
  .from('restaurants')
  .select('id, name, finatic_merchant_no, finatic_store_no, finatic_terminal_sn, checkout_merchant_no, checkout_store_no')
show(
  'restaurants — which Finatic fields are populated (values masked)',
  credsError ||
    (creds || []).map((r) => ({
      id: r.id,
      name: r.name,
      hasMerchantNo: Boolean(String(r.finatic_merchant_no || '').trim()),
      hasStoreNo: Boolean(String(r.finatic_store_no || '').trim()),
      hasTerminalSn: Boolean(String(r.finatic_terminal_sn || '').trim()),
      hasCheckoutMerchantNo: Boolean(String(r.checkout_merchant_no || '').trim()),
      hasCheckoutStoreNo: Boolean(String(r.checkout_store_no || '').trim()),
    }))
)

const { data: items, error: itemsError } = await db
  .from('menu_items')
  .select('id, restaurant_id, name, base_price, has_sizes, sizes, has_addons, addons, variant_groups, variants, tax_rate_id, status')
  .limit(1000)
if (itemsError) {
  show('menu_items', itemsError)
} else {
  const withGroups = (items || []).filter(
    (i) => Array.isArray(i.variant_groups) && i.variant_groups.length > 0
  )
  const withLegacyVariants = (items || []).filter(
    (i) => Array.isArray(i.variants) && i.variants.length > 0
  )
  show('menu_items with NON-EMPTY variant_groups', withGroups)
  show('menu_items with NON-EMPTY legacy variants', withLegacyVariants)
  show('counts', {
    total: (items || []).length,
    withNonEmptyVariantGroups: withGroups.length,
    withNonEmptyLegacyVariants: withLegacyVariants.length,
    withSizes: (items || []).filter((i) => i.has_sizes && (i.sizes || []).length > 0).length,
    withAddons: (items || []).filter((i) => i.has_addons && (i.addons || []).length > 0).length,
  })
}

// Do accepted order_requests' stored totals match the orders row created from them?
const { data: accepted, error: acceptedError } = await db
  .from('order_requests')
  .select('id, total, total_reviewed, subtotal, tax, accepted_order_id, status, channel')
  .eq('status', 'accepted')
  .not('accepted_order_id', 'is', null)
  .limit(50)
if (acceptedError) {
  show('accepted order_requests', acceptedError)
} else {
  const ids = (accepted || []).map((r) => r.accepted_order_id)
  const { data: orders } = await db
    .from('orders')
    .select('id, total, subtotal, tax, payment_status, status, payment_checkout_url')
    .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
  const byId = new Map((orders || []).map((o) => [o.id, o]))
  show(
    'quoted vs recorded (order_request -> orders)',
    (accepted || []).map((r) => {
      const o = byId.get(r.accepted_order_id)
      const quoted = r.total_reviewed ?? r.total
      return {
        requestId: r.id,
        channel: r.channel,
        quotedTotal: quoted,
        orderTotal: o?.total ?? null,
        matches: o ? Math.abs(Number(quoted) - Number(o.total)) < 0.005 : null,
        orderPaymentStatus: o?.payment_status ?? null,
        orderStatus: o?.status ?? null,
        hasCheckoutUrl: Boolean(o?.payment_checkout_url),
      }
    })
  )
}

// Terminal states nothing automatic clears.
const { data: stuck, error: stuckError } = await db
  .from('order_requests')
  .select('id, status, placed_at, decided_at')
  .in('status', ['accepting', 'waiting_review'])
  .limit(100)
show('order_requests currently in accepting/waiting_review', stuckError || stuck)
