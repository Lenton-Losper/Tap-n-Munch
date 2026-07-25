/**
 * Production: apply orders/payment_events indexes migration (Mingle go-live
 * capacity fix).
 *
 *   npx tsx scripts/apply-orders-payment-events-indexes-production.ts
 *
 * Requires linked Supabase CLI auth (SUPABASE_ACCESS_TOKEN) against production.
 * Not run yet -- staging verified first, production requires sign-off.
 */
import {
  PRODUCTION_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

const MIGRATION_FILE = 'supabase/migrations/20260725130000_orders_payment_events_indexes.sql'
const MIGRATION_VERSION = '20260725130000'

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
  console.log('APPLY_ORDERS_PAYMENT_EVENTS_INDEXES_PRODUCTION_OK')
}

main()
