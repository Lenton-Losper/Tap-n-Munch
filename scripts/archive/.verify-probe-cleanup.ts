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

async function count(table: string, column: string, value: string): Promise<{ count: number; rows: any[] }> {
  const { data, error, count: c } = await admin.from(table).select('*', { count: 'exact' }).eq(column, value)
  if (error) throw new Error(`${table}.${column}=${value}: ${error.message}`)
  return { count: c ?? 0, rows: data ?? [] }
}

async function main() {
  const r1 = await count('restaurants', 'id', RESTAURANT_ID)
  console.log(`1. restaurants WHERE id = '${RESTAURANT_ID}': count=${r1.count}`)
  if (r1.count > 0) console.log('   ROWS:', JSON.stringify(r1.rows))

  const r2 = await count('users', 'id', FAKE_USER_ID)
  console.log(`2. public.users WHERE id = '${FAKE_USER_ID}': count=${r2.count}`)
  if (r2.count > 0) console.log('   ROWS:', JSON.stringify(r2.rows))

  for (const table of ['restaurant_users', 'restaurant_roles', 'restaurant_setup_status']) {
    const byRestaurant = await count(table, 'restaurant_id', RESTAURANT_ID)
    console.log(`3. ${table} WHERE restaurant_id = '${RESTAURANT_ID}': count=${byRestaurant.count}`)
    if (byRestaurant.count > 0) console.log('   ROWS:', JSON.stringify(byRestaurant.rows))
  }

  // restaurant_roles has no user_id column; restaurant_users/restaurant_setup_status don't have user_id either
  // except restaurant_users.user_id -- check that explicitly too
  const ruByUser = await count('restaurant_users', 'user_id', FAKE_USER_ID)
  console.log(`3b. restaurant_users WHERE user_id = '${FAKE_USER_ID}': count=${ruByUser.count}`)
  if (ruByUser.count > 0) console.log('   ROWS:', JSON.stringify(ruByUser.rows))
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
