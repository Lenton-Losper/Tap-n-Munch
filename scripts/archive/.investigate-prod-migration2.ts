import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  // Exact param shape used by lib/auth/create-restaurant.ts:80-87
  const { data, error } = await admin.rpc('create_restaurant_for_user', {
    p_user_id: '00000000-0000-0000-0000-000000000000',
    p_email: 'rpc-existence-probe@example.com',
    p_full_name: 'probe',
    p_phone: '0000000000',
    p_restaurant_name: 'probe',
    p_roles: [{ role_slug: 'owner', display_name: 'Owner', permissions: [], is_system: true }],
  })
  console.log('Exact-signature RPC probe:', JSON.stringify({ data, error }, null, 2))

  // Also check Postgres function catalog directly (may be blocked by RLS/permissions, worth trying)
  const { data: fnRows, error: fnErr } = await admin
    .from('pg_proc' as any)
    .select('proname')
    .eq('proname', 'create_restaurant_for_user')
  console.log('pg_proc direct query (likely blocked, informational only):', JSON.stringify({ fnRows, fnErr }, null, 2))
}
main().catch((e) => { console.error('probe threw:', e); process.exit(1) })
