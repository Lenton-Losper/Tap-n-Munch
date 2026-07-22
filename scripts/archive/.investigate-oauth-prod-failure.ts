/**
 * READ-ONLY investigation: recent auth.users signups on production vs
 * matching public.users / restaurant_users rows. No writes.
 */
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: resolve(__dirname, '../.env.production.local'), override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_URL.includes(PROD_REF) || !SERVICE_KEY) {
  throw new Error('Refusing: production Supabase credentials missing/mismatched')
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

async function main() {
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  console.log(`Querying auth.users created since ${sinceIso}\n`)

  // Paginate admin.listUsers and filter client-side by created_at (no direct SQL filter available)
  const recent: any[] = []
  let page = 1
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw error
    if (!data.users.length) break
    for (const u of data.users) {
      if (u.created_at >= sinceIso) recent.push(u)
    }
    const oldestOnPage = data.users[data.users.length - 1].created_at
    if (oldestOnPage < sinceIso) break
    if (data.users.length < 200) break
    page++
  }

  recent.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  console.log(`Found ${recent.length} auth.users created in the last hour\n`)

  for (const u of recent) {
    console.log('='.repeat(80))
    console.log(`auth.users id=${u.id}`)
    console.log(`  email: ${u.email}`)
    console.log(`  created_at: ${u.created_at}`)
    console.log(`  last_sign_in_at: ${u.last_sign_in_at}`)
    console.log(`  provider: ${u.app_metadata?.provider}, providers: ${JSON.stringify(u.app_metadata?.providers)}`)
    console.log(`  identities: ${JSON.stringify((u.identities || []).map((i: any) => ({ provider: i.provider, id: i.id, identity_id: i.identity_id })))}`)

    const { data: pu, error: puErr } = await admin
      .from('users')
      .select('id, email, full_name')
      .eq('id', u.id)
      .maybeSingle()
    if (puErr) console.log(`  public.users lookup by id ERROR: ${puErr.message}`)
    else console.log(`  public.users by id: ${pu ? JSON.stringify(pu) : 'NOT FOUND'}`)

    if (!pu && u.email) {
      const { data: puByEmail, error: puByEmailErr } = await admin
        .from('users')
        .select('id, email, full_name')
        .ilike('email', u.email)
        .maybeSingle()
      if (puByEmailErr) console.log(`  public.users lookup by email ERROR: ${puByEmailErr.message}`)
      else if (puByEmail) console.log(`  public.users by email (DIFFERENT id!): ${JSON.stringify(puByEmail)}`)
      else console.log(`  public.users by email: NOT FOUND`)
    }

    const { data: ru, error: ruErr } = await admin
      .from('restaurant_users')
      .select('restaurant_id, role, user_id')
      .eq('user_id', u.id)
    if (ruErr) console.log(`  restaurant_users lookup ERROR: ${ruErr.message}`)
    else console.log(`  restaurant_users rows: ${ru && ru.length ? JSON.stringify(ru) : 'NONE'}`)
  }

  console.log('\n' + '='.repeat(80))
  console.log('Done.')
}

main().catch((error) => {
  console.error('Investigation failed:', error)
  process.exit(1)
})
