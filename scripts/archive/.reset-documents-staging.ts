import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  await admin.from('business_documents').delete().eq('restaurant_id', RESTAURANT_ID)
  await admin
    .from('document_sequences')
    .update({ current_number: 0 })
    .eq('restaurant_id', RESTAURANT_ID)
  console.log('reset ok')
}

void main()
