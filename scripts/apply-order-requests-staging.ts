/**
 * Staging: apply order_requests migration.
 *
 *   npx tsx scripts/apply-order-requests-staging.ts
 *
 * Requires linked Supabase CLI auth against staging.
 */
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

const MIGRATION_FILE = 'supabase/migrations/20260726100000_order_requests.sql'
const MIGRATION_VERSION = '20260726100000'

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
  console.log('APPLY_ORDER_REQUESTS_STAGING_OK')
}

main()
