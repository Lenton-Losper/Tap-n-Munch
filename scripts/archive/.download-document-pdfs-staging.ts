import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })


const STAGING_TEST_PASSWORD = requireStagingTestPassword()

const STAGING_BASE = 'https://flashtap-staging.llosperofficial.workers.dev'
const OUT_DIR = resolve(__dirname, '../test-results/document-pdfs')

const DOCS = [
  { id: '23a201cb-eb47-4f90-89d7-535e73f181b7', label: 'invoice-1-original' },
  { id: '24fb800d-61ae-4c62-969f-a47d24279321', label: 'quote-1-original' },
]

async function main() {
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await client.auth.signInWithPassword({
    email: 'flashtap.staging.test@gmail.com',
    password: STAGING_TEST_PASSWORD,
  })
  if (error || !data.session) throw error ?? new Error('sign-in failed')

  const token = data.session.access_token
  mkdirSync(OUT_DIR, { recursive: true })

  for (const doc of DOCS) {
    const res = await fetch(`${STAGING_BASE}/api/admin/documents/${doc.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const contentType = res.headers.get('content-type') ?? ''
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`${doc.label} (${doc.id}): HTTP ${res.status} ${body}`)
    }
    if (!contentType.includes('application/pdf')) {
      throw new Error(`${doc.label}: expected PDF, got ${contentType}`)
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    const outPath = resolve(OUT_DIR, `${doc.label}.pdf`)
    writeFileSync(outPath, bytes)
    console.log(`saved ${outPath} (${bytes.length} bytes)`)
  }
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
