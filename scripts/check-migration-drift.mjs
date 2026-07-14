/**
 * Fails the deploy if the target Supabase project's applied migration
 * history doesn't match the migrations committed in supabase/migrations/
 * (#38/#20). Read-only: never applies, repairs, or otherwise mutates
 * anything — detection only, per the incident report's principle that
 * migrations remain a deliberate human-approved action.
 *
 * Two failure modes, both real incidents that already happened once:
 *   - LOCAL_NOT_APPLIED: a migration is committed but not applied on the
 *     target DB -> deploying this code risks the exact PGRST202-style
 *     failure that caused the July 2026 incident.
 *   - APPLIED_NOT_LOCAL: the DB has an applied migration version with no
 *     matching committed file -> undocumented drift, silently accumulates
 *     the way 12 of the 13 missing migrations did.
 *
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/check-migration-drift.mjs
 */
import { readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations')

const supabaseUrl = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceKey) {
  console.error('MIGRATION DRIFT CHECK: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

function localMigrationVersions() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.match(/^(\d+)_/)?.[1])
    .filter((version) => Boolean(version))
    .sort()
}

async function appliedMigrationVersions(supabase) {
  const { data, error } = await supabase.rpc('list_applied_migration_versions')
  if (error) {
    throw new Error(`list_applied_migration_versions RPC failed: ${error.message}`)
  }
  return (data ?? []).map((row) => String(row.version)).sort()
}

async function main() {
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const local = new Set(localMigrationVersions())
  const applied = new Set(await appliedMigrationVersions(supabase))

  const localNotApplied = [...local].filter((v) => !applied.has(v)).sort()
  const appliedNotLocal = [...applied].filter((v) => !local.has(v)).sort()

  console.log(`MIGRATION DRIFT CHECK: ${local.size} local migration(s), ${applied.size} applied on target DB`)

  if (localNotApplied.length === 0 && appliedNotLocal.length === 0) {
    console.log('MIGRATION DRIFT CHECK: OK — local migrations and target DB are in sync.')
    return
  }

  console.error('MIGRATION DRIFT CHECK: FAILED')
  if (localNotApplied.length > 0) {
    console.error(
      `  Committed migrations NOT applied on target DB (deploying this code is unsafe):\n` +
        localNotApplied.map((v) => `    - ${v}`).join('\n'),
    )
  }
  if (appliedNotLocal.length > 0) {
    console.error(
      `  Migrations applied on target DB with NO matching committed file (undocumented drift):\n` +
        appliedNotLocal.map((v) => `    - ${v}`).join('\n'),
    )
  }
  console.error(
    '  Resolve via the guarded wrapper (scripts/safe-supabase-linked.ts) or by committing the ' +
      'missing migration file, then re-run this check. See FlashTap-Production-Migration-Drift-Incident-Report.docx.',
  )
  process.exit(1)
}

main().catch((error) => {
  console.error('MIGRATION DRIFT CHECK: error', error)
  process.exit(1)
})
