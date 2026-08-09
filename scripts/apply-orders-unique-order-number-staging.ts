/**
 * Staging: apply the (firebase_restaurant_id, order_number) unique index (#127).
 *   npx tsx scripts/apply-orders-unique-order-number-staging.ts
 *
 * Refuses to run unless scripts/check-duplicate-order-numbers-readonly.ts comes back clean first —
 * a unique index cannot be created over existing duplicates, and a half-applied migration that
 * errored is worse than an unapplied one.
 *
 * `db query` executes the SQL but does NOT record it in supabase_migrations.schema_migrations, so
 * the `migration repair` step is what actually clears scripts/check-migration-drift.mjs. Both are
 * required; running only the first leaves the deploy gate failing.
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const VERSION = '20260809120000'
const MIGRATION = `supabase/migrations/${VERSION}_orders_unique_order_number.sql`

const url = process.env.SUPABASE_URL!
if (!url?.includes(STAGING_PROJECT_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

function main(): void {
  runShellCommand('npx tsx scripts/check-duplicate-order-numbers-readonly.ts')
  runShellCommand(`npx supabase link --project-ref ${STAGING_PROJECT_REF}`)
  runSafeSupabaseLinked(STAGING_PROJECT_REF, ['db', 'query', '--linked', '-f', MIGRATION])
  runSafeSupabaseLinked(STAGING_PROJECT_REF, [
    'migration',
    'repair',
    '--linked',
    '--status',
    'applied',
    VERSION,
  ])
  console.log('APPLY_ORDERS_UNIQUE_ORDER_NUMBER_STAGING_OK')
}

main()
