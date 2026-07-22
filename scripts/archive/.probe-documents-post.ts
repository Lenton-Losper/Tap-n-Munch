import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })


const STAGING_TEST_PASSWORD = requireStagingTestPassword()

const url = process.env.SUPABASE_URL!
const anon = process.env.SUPABASE_ANON_KEY!
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY!

async function main() {
  const client = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await client.auth.signInWithPassword({
    email: 'flashtap.staging.test@gmail.com',
    password: STAGING_TEST_PASSWORD,
  })
  if (error) throw error
  const token = data.session!.access_token

  const body = {
    restaurant_id: 'a1999166-ddfa-40d1-ad1f-2f01282a1652',
    type: 'invoice',
    ship_to: { name: 'API Ship', customFields: { 'GL Number': '1234' } },
    bill_to: { name: 'API Bill', organization: 'Org' },
    line_items: [
      { description: 'Line A', quantity: 3, unit_price: 45.5 },
      { description: 'Line B', quantity: 2, unit_price: 120 },
    ],
    due_date: '2026-08-15',
  }

  const res = await fetch(
    'https://flashtap-staging.llosperofficial.workers.dev/api/admin/documents',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  console.log('POST status', res.status)
  console.log(await res.text())

  const admin = createClient(url, svc, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: docs } = await admin
    .from('business_documents')
    .select('id,document_type,document_number,bill_to,ship_to,subtotal,total,created_at')
    .eq('restaurant_id', 'a1999166-ddfa-40d1-ad1f-2f01282a1652')
    .order('created_at', { ascending: true })
  console.log('docs', JSON.stringify(docs, null, 2))
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
