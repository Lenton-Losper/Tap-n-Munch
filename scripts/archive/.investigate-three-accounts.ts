import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })

const EMAILS = ['snitchkicker@gmail.com', 'ngetuuisgreat@gmail.com', 'xshadoey@gmail.com']

async function main() {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 })
  if (error) throw error
  for (const email of EMAILS) {
    const u = data.users.find((x) => x.email === email)
    console.log('='.repeat(80))
    console.log(email)
    if (!u) { console.log('  NOT FOUND in auth.users'); continue }
    console.log(`  id: ${u.id}`)
    console.log(`  created_at: ${u.created_at}`)
    console.log(`  last_sign_in_at: ${u.last_sign_in_at}`)
    console.log(`  updated_at: ${u.updated_at}`)
    console.log(`  app_metadata: ${JSON.stringify(u.app_metadata)}`)
  }

  console.log('='.repeat(80))
  console.log('restaurant_setup_status full table (4 rows):')
  const { data: setup, error: setupErr } = await admin.from('restaurant_setup_status').select('*')
  console.log(setupErr ? setupErr.message : JSON.stringify(setup, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
