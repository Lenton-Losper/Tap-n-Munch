/** READ-ONLY: do the two restaurant IDs that 20260705210000 seeds short_code for exist on production? */
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
if (!url.includes('ihlmmpmolnpchzgwyhgh')) throw new Error(`REFUSING: expected production, got ${url}`)
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

const IDS: Record<string, string> = {
  '01bf27f1-a958-4322-bb3e-cc5240987808': 'RIV',
  'b161c758-582d-4dfa-839a-9fa35c492a49': 'FNB',
}

async function main() {
  const { data, error } = await db.from('restaurants').select('id, name').in('id', Object.keys(IDS))
  if (error) throw new Error(error.message)
  console.log('short_code seed targets, checked on PRODUCTION:')
  for (const [id, code] of Object.entries(IDS)) {
    const hit = (data ?? []).find((r) => String(r.id) === id)
    console.log(`  ${code}  ${id}  ${hit ? 'EXISTS -> ' + String(hit.name) : 'NOT ON PRODUCTION'}`)
  }
  const { data: all } = await db.from('restaurants').select('id, name')
  console.log(`  (production has ${(all ?? []).length} restaurants: ${(all ?? []).map((r) => String(r.name)).join(', ')})`)
}

main().catch((e) => { console.error('THREW:', e?.message ?? e); process.exit(1) })
