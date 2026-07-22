import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(__dirname, '../.env.test'), override: true })

async function main() {
  const admin = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const rid = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
  const { data: restaurant } = await admin
    .from('restaurants')
    .select('name,address,tax_rate')
    .eq('id', rid)
    .single()
  const { data: docs } = await admin
    .from('business_documents')
    .select(
      'id,document_type,document_number,business_name,address,phone,logo_url,subtotal,vat_amount,total,issued_at',
    )
    .eq('restaurant_id', rid)
    .order('created_at')
  console.log(JSON.stringify({ restaurant, docs }, null, 2))
}

void main()
