/**
 * Production: apply platform ops console migration (alert acks, bug triage columns,
 * audit correlation_id, bug_reports → restaurants FK).
 *
 *   npx tsx scripts/apply-platform-ops-console-production.ts
 *
 * Requires linked Supabase CLI auth (SUPABASE_ACCESS_TOKEN) against production.
 * Additive / IF NOT EXISTS — safe to re-run.
 */
import {
  PRODUCTION_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

const MIGRATION_FILE = 'supabase/migrations/20260724180000_platform_ops_console.sql'
const MIGRATION_VERSION = '20260724180000'

function main(): void {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.PRODUCTION_SUPABASE_URL ||
    ''
  if (url && !url.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error(
      `Refusing: SUPABASE_URL is not production (${PRODUCTION_PROJECT_REF})`,
    )
  }

  runShellCommand(`npx supabase link --project-ref ${PRODUCTION_PROJECT_REF} --yes`)
  runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, [
    'db',
    'query',
    '--linked',
    '-f',
    MIGRATION_FILE,
  ])
  runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, [
    'migration',
    'repair',
    '--linked',
    '--status',
    'applied',
    MIGRATION_VERSION,
  ])
  console.log('APPLY_PLATFORM_OPS_CONSOLE_PRODUCTION_OK')
}

main()
