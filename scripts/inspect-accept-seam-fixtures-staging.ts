/**
 * READ-ONLY staging inspection: what the accept-seam probe can actually be driven with.
 *
 * Establishes, without writing anything, whether the staging test restaurant has the pieces a
 * non-mocked order_requests -> accept round trip needs: an orderable table, chargeable menu
 * items, tax rates, restaurant_settings.payment_methods, and the order_requests columns the
 * seam reads.
 *
 *   npx tsx scripts/inspect-accept-seam-fixtures-staging.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

// .env.local points at PRODUCTION. .env.test points at staging. Load .env.test with override so
// a stray shell/.env.local value can never redirect this at production.
config({ path: resolve(__dirname, '../.env.test'), override: true })

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (url.includes(PRODUCTION_REF)) {
  throw new Error(`REFUSING: resolved Supabase URL is PRODUCTION (${url}).`)
}
if (!url.includes(STAGING_REF)) {
  throw new Error(`REFUSING: resolved Supabase URL is not staging ${STAGING_REF} (${url}).`)
}
if (!serviceKey) throw new Error('Need SUPABASE_SERVICE_ROLE_KEY')

function log(label: string, value: unknown) {
  console.log(`== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function main() {
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: restaurant, error: rErr } = await admin
    .from('restaurants')
    .select('id, name, firebase_id, finatic_merchant_no, finatic_store_no')
    .eq('id', RESTAURANT_ID)
    .maybeSingle()
  log('restaurant', rErr ? { error: rErr.message } : restaurant)

  const { data: tables, error: tErr } = await admin
    .from('restaurant_tables')
    .select('id, table_number, active, is_kiosk, is_view_only')
    .eq('restaurant_id', RESTAURANT_ID)
    .order('table_number')
  log('tables', tErr ? { error: tErr.message } : tables)

  const { data: menu, error: mErr } = await admin
    .from('menu_items')
    .select('id, name, base_price, status, tax_rate_id, sizes, addons, category_id')
    .eq('restaurant_id', RESTAURANT_ID)
    .order('name')
  log(
    'menu_items',
    mErr
      ? { error: mErr.message }
      : (menu || []).map((m) => ({
          id: m.id,
          name: m.name,
          base_price: m.base_price,
          status: m.status,
          tax_rate_id: m.tax_rate_id,
          sizes: (m.sizes || []).length,
          addons: (m.addons || []).length,
          category_id: m.category_id,
        })),
  )

  const { data: rates, error: taxErr } = await admin
    .from('tax_rates')
    .select('*')
    .eq('restaurant_id', RESTAURANT_ID)
  log('tax_rates', taxErr ? { error: taxErr.message } : rates)

  const { data: settings, error: sErr } = await admin
    .from('restaurant_settings')
    .select('restaurant_id, payment_methods, settings_version')
    .eq('restaurant_id', RESTAURANT_ID)
    .maybeSingle()
  log('restaurant_settings', sErr ? { error: sErr.message } : settings)

  const { data: reqSample, error: reqErr } = await admin
    .from('order_requests')
    .select('*')
    .eq('restaurant_id', RESTAURANT_ID)
    .limit(1)
  log(
    'order_requests columns',
    reqErr ? { error: reqErr.message } : Object.keys(reqSample?.[0] || {}),
  )

  const { count: openRequests } = await admin
    .from('order_requests')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('status', 'waiting_review')
  log('waiting_review requests already present', openRequests)

  const { data: catRow, error: cErr } = await admin
    .from('menu_categories')
    .select('id, name')
    .eq('restaurant_id', RESTAURANT_ID)
    .limit(5)
  log('menu_categories', cErr ? { error: cErr.message } : catRow)

  console.log('INSPECT_ACCEPT_SEAM_FIXTURES_OK')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
