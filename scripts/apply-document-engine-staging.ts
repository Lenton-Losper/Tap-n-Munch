/**
 * Staging: apply Document Engine migration (credit_note, lineage, correct_invoice).
 *
 *   npx tsx scripts/apply-document-engine-staging.ts
 *
 * Requires SUPABASE_ACCESS_TOKEN linked against staging. Staging only.
 */
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

const MIGRATION_FILE =
  'supabase/migrations/20260725200000_document_engine_credit_notes_lineage.sql'
const MIGRATION_VERSION = '20260725200000'

function main(): void {
  const url = process.env.SUPABASE_URL || process.env.STAGING_SUPABASE_URL || ''
  if (url && !url.includes(STAGING_PROJECT_REF)) {
    throw new Error(`Refusing: SUPABASE_URL is not staging (${STAGING_PROJECT_REF})`)
  }

  runShellCommand(`npx supabase link --project-ref ${STAGING_PROJECT_REF} --yes`)
  runSafeSupabaseLinked(STAGING_PROJECT_REF, [
    'db',
    'query',
    '--linked',
    '-f',
    MIGRATION_FILE,
  ])
  runSafeSupabaseLinked(STAGING_PROJECT_REF, [
    'migration',
    'repair',
    '--linked',
    '--status',
    'applied',
    MIGRATION_VERSION,
  ])
  console.log('APPLY_DOCUMENT_ENGINE_STAGING_OK')
}

main()
