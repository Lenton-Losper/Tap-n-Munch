import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

async function main() {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 10 })
  if (error) throw error
  console.log(`total on page 1: ${data.users.length}`)
  for (const u of data.users) {
    console.log(`${u.created_at}  ${u.email}  provider=${u.app_metadata?.provider}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
