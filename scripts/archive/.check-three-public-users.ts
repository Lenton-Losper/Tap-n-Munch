import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const IDS = [
  { email: 'snitchkicker@gmail.com', id: '52e102a1-7f67-4cef-a5b9-da9c7c24b090' },
  { email: 'ngetuuisgreat@gmail.com', id: 'd1cfe3e3-0fc9-4074-8757-90e9ba7cea6c' },
  { email: 'xshadoey@gmail.com', id: '56215ac6-0e9d-42d4-a28c-cefd3cc518e5' },
]

async function main() {
  for (const { email, id } of IDS) {
    const { data: pu, error } = await admin.from('users').select('*').eq('id', id).maybeSingle()
    console.log('='.repeat(80))
    console.log(email, id)
    console.log('public.users:', error ? error.message : JSON.stringify(pu))

    const { data: ru } = await admin.from('restaurant_users').select('*').eq('user_id', id)
    console.log('restaurant_users:', JSON.stringify(ru))
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
