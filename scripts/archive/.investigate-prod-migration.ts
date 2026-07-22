import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  // Does the RPC function exist on production?
  const { data: rpcData, error: rpcError } = await admin.rpc('create_restaurant_for_user', {
    p_user_id: '00000000-0000-0000-0000-000000000000',
    p_email: 'rpc-existence-probe@example.com',
    p_full_name: 'probe',
    p_phone: '0000000000',
    p_restaurant_name: 'probe',
  })
  console.log('RPC call result:', JSON.stringify({ data: rpcData, error: rpcError }, null, 2))
}
main().catch((e) => { console.error('probe threw:', e); process.exit(1) })
