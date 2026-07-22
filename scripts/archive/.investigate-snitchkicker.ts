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
  const u = data.users.find((x) => x.email === 'snitchkicker@gmail.com')
  if (!u) { console.log('not found'); return }
  console.log(JSON.stringify(u, null, 2))

  const { data: pu, error: puErr } = await admin.from('users').select('*').eq('id', u.id).maybeSingle()
  console.log('public.users by id:', puErr ? puErr.message : JSON.stringify(pu))

  const { data: puByEmail, error: puByEmailErr } = await admin.from('users').select('*').ilike('email', u.email!).maybeSingle()
  console.log('public.users by email:', puByEmailErr ? puByEmailErr.message : JSON.stringify(puByEmail))

  const { data: ru, error: ruErr } = await admin.from('restaurant_users').select('*').eq('user_id', u.id)
  console.log('restaurant_users:', ruErr ? ruErr.message : JSON.stringify(ru))

  const { data: rest, error: restErr } = await admin.from('restaurants').select('*').eq('owner_id', u.id)
  console.log('restaurants owned:', restErr ? restErr.message : JSON.stringify(rest))
}
main().catch((e) => { console.error(e); process.exit(1) })
