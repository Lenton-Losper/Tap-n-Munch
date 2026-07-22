import { config } from 'dotenv'
config({ path: '.env.production.local', override: true })
import { createClient } from '@supabase/supabase-js'

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const RIVIERA = '01bf27f1-a958-4322-bb3e-cc5240987808'

async function main() {
  const { data: owners } = await admin
    .from('restaurant_users')
    .select('user_id, role')
    .eq('restaurant_id', RIVIERA)
    .eq('role', 'owner')

  for (const row of owners ?? []) {
    const { data: u } = await admin.from('users').select('id, email, full_name').eq('id', row.user_id).maybeSingle()
    console.log('Riviera owner:', u)
  }

  const { data: leftovers } = await admin
    .from('users')
    .select('id, email')
    .or('email.like.analytics.prod.verify%,email.like.analytics.prod.ui%,email.like.analytics-leak-prod%')
  console.log('leftover verify users:', leftovers)
}

main()
