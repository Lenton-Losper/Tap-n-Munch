/**
 * Read-only: confirms specific migration versions are present in production's
 * supabase_migrations.schema_migrations via the existing list_applied_migration_versions()
 * RPC. Same discipline as the rest of this investigation -- verify via direct production
 * read, not assume the apply script's exit code was sufficient.
 *
 *   node scripts/verify-production-migration-batch.mjs 20260719110000 20260719120000 ...
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'

config({ path: '.env.production.local', override: true })

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url?.includes(PROD_REF)) throw new Error(`Refusing: not production Supabase (${url})`)

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

const expectedVersions = process.argv.slice(2)
if (expectedVersions.length === 0) {
  throw new Error('Usage: node verify-production-migration-batch.mjs <version> [<version> ...]')
}

async function main() {
  const { data, error } = await db.rpc('list_applied_migration_versions')
  if (error) throw new Error(`list_applied_migration_versions RPC failed: ${error.message}`)
  const applied = new Set((data ?? []).map((row) => String(row.version)))

  const missing = expectedVersions.filter((v) => !applied.has(v))
  if (missing.length > 0) {
    console.error('BATCH_VERIFY_FAILED -- missing from supabase_migrations.schema_migrations:')
    for (const v of missing) console.error(`  - ${v}`)
    process.exit(1)
  }

  console.log(`BATCH_VERIFY_OK -- all ${expectedVersions.length} version(s) confirmed applied:`)
  for (const v of expectedVersions) console.log(`  - ${v}`)
}

main().catch((err) => {
  console.error('BATCH_VERIFY_ERROR', err)
  process.exit(1)
})
