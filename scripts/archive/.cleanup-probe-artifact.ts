/**
 * Cleanup: the RPC existence-probe accidentally executed create_restaurant_for_user
 * for real once the function existed. Remove the exact rows it created.
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!SUPABASE_URL.includes(PROD_REF) || !SERVICE_KEY) throw new Error('Refusing: wrong env')

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const RESTAURANT_ID = 'e53ef4df-b9e5-47dc-949f-5a8c6b3d0acd'
const FAKE_USER_ID = '00000000-0000-0000-0000-000000000000'

async function main() {
  console.log('Before cleanup:')
  const { data: r0 } = await admin.from('restaurants').select('*').eq('id', RESTAURANT_ID)
  console.log('  restaurants:', JSON.stringify(r0))
  const { data: ru0 } = await admin.from('restaurant_users').select('*').eq('restaurant_id', RESTAURANT_ID)
  console.log('  restaurant_users:', JSON.stringify(ru0))
  const { data: rr0 } = await admin.from('restaurant_roles').select('*').eq('restaurant_id', RESTAURANT_ID)
  console.log('  restaurant_roles:', JSON.stringify(rr0))
  const { data: rs0 } = await admin.from('restaurant_setup_status').select('*').eq('restaurant_id', RESTAURANT_ID)
  console.log('  restaurant_setup_status:', JSON.stringify(rs0))
  const { data: u0 } = await admin.from('users').select('*').eq('id', FAKE_USER_ID)
  console.log('  fake public.users row:', JSON.stringify(u0))

  console.log('\nDeleting...')
  const del1 = await admin.from('restaurant_users').delete().eq('restaurant_id', RESTAURANT_ID)
  console.log('  restaurant_users delete error:', del1.error)
  const del2 = await admin.from('restaurant_setup_status').delete().eq('restaurant_id', RESTAURANT_ID)
  console.log('  restaurant_setup_status delete error:', del2.error)
  const del3 = await admin.from('restaurant_roles').delete().eq('restaurant_id', RESTAURANT_ID)
  console.log('  restaurant_roles delete error:', del3.error)
  const del4 = await admin.from('restaurants').delete().eq('id', RESTAURANT_ID)
  console.log('  restaurants delete error:', del4.error)
  const del5 = await admin.from('users').delete().eq('id', FAKE_USER_ID)
  console.log('  fake users row delete error:', del5.error)

  console.log('\nAfter cleanup (should all be empty):')
  const { data: r1 } = await admin.from('restaurants').select('*').eq('id', RESTAURANT_ID)
  console.log('  restaurants:', JSON.stringify(r1))
  const { data: ru1 } = await admin.from('restaurant_users').select('*').eq('restaurant_id', RESTAURANT_ID)
  console.log('  restaurant_users:', JSON.stringify(ru1))
  const { data: rr1 } = await admin.from('restaurant_roles').select('*').eq('restaurant_id', RESTAURANT_ID)
  console.log('  restaurant_roles:', JSON.stringify(rr1))
  const { data: rs1 } = await admin.from('restaurant_setup_status').select('*').eq('restaurant_id', RESTAURANT_ID)
  console.log('  restaurant_setup_status:', JSON.stringify(rs1))
  const { data: u1 } = await admin.from('users').select('*').eq('id', FAKE_USER_ID)
  console.log('  fake public.users row:', JSON.stringify(u1))
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
