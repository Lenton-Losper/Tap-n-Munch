/**
 * Production: apply orders.terminal_status migration.
 *
 *   npx tsx scripts/apply-orders-terminal-status-production.ts
 *
 * Requires linked Supabase CLI auth (SUPABASE_ACCESS_TOKEN) against production.
 * Not run yet -- needs explicit sign-off (schema change close to Monday's
 * Mingle launch). Staging verified first.
 */
import {
  PRODUCTION_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

const MIGRATION_FILE = 'supabase/migrations/20260725140000_orders_terminal_status.sql'
const MIGRATION_VERSION = '20260725140000'

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
  console.log('APPLY_ORDERS_TERMINAL_STATUS_PRODUCTION_OK')
}

main()
