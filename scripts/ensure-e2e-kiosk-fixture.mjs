/**
 * Ensures the staging E2E kiosk fixture exists (active is_kiosk row at table 1001).
 * Safe to run repeatedly — upserts by restaurant_id + table_number.
 */
import { createClient } from '@supabase/supabase-js'

const STAGING_RESTAURANT = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const KIOSK_TABLE_NUMBER = 1001
const BASE_URL =
  process.env.E2E_BASE_URL ||
  process.env.FLASHTAP_BASE_URL ||
  'https://flashtap-staging.llosperofficial.workers.dev'

const supabaseUrl = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

const qrCodeUrl = `${BASE_URL}/menu/${STAGING_RESTAURANT}/kiosk?table=${KIOSK_TABLE_NUMBER}`

const { data: existing, error: lookupError } = await admin
  .from('restaurant_tables')
  .select('id')
  .eq('restaurant_id', STAGING_RESTAURANT)
  .eq('table_number', KIOSK_TABLE_NUMBER)
  .maybeSingle()

if (lookupError) {
  console.error('Fixture lookup failed:', lookupError.message)
  process.exit(1)
}

const row = {
  restaurant_id: STAGING_RESTAURANT,
  table_number: KIOSK_TABLE_NUMBER,
  table_name: 'E2E Kiosk',
  location: 'E2E fixture',
  capacity: null,
  is_kiosk: true,
  qr_code_url: qrCodeUrl,
  active: true,
}

if (existing?.id) {
  const { error } = await admin.from('restaurant_tables').update(row).eq('id', existing.id)
  if (error) {
    console.error('Fixture update failed:', error.message)
    process.exit(1)
  }
  console.log('E2E_KIOSK_FIXTURE_UPDATED', { table_number: KIOSK_TABLE_NUMBER })
} else {
  const { error } = await admin.from('restaurant_tables').insert(row)
  if (error) {
    console.error('Fixture insert failed:', error.message)
    process.exit(1)
  }
  console.log('E2E_KIOSK_FIXTURE_CREATED', { table_number: KIOSK_TABLE_NUMBER })
}
