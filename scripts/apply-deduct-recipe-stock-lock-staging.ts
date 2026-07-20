/**
 * Staging: apply the deduct_recipe_stock advisory-lock migration (closes the
 * transfer-vs-sale concurrency gap flagged during Workstream 3 verification).
 *   npx tsx scripts/apply-deduct-recipe-stock-lock-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATION = 'supabase/migrations/20260719200000_deduct_recipe_stock_advisory_lock.sql'

const url = process.env.SUPABASE_URL!
if (!url?.includes(STAGING_PROJECT_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

function main(): void {
  runShellCommand(`npx supabase link --project-ref ${STAGING_PROJECT_REF}`)
  runSafeSupabaseLinked(STAGING_PROJECT_REF, ['db', 'query', '--linked', '-f', MIGRATION])
  runSafeSupabaseLinked(STAGING_PROJECT_REF, [
    'migration',
    'repair',
    '--linked',
    '--status',
    'applied',
    '20260719200000',
  ])
  console.log('APPLY_DEDUCT_RECIPE_STOCK_LOCK_STAGING_OK')
}

main()
