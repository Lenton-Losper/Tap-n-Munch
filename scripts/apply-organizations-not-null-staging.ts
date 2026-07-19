/**
 * Staging: apply the final Workstream 2 migration (stock_items.organization_stock_item_id
 * SET NOT NULL). Run ONLY after apply-organizations-staging.ts and
 * verify-organizations-staging.ts both pass -- verify confirms 100% backfill coverage and
 * zero unique-index violations before this locks the column down.
 *   npx tsx scripts/apply-organizations-not-null-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATION = 'supabase/migrations/20260719150000_organization_stock_items_not_null.sql'

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
    '20260719150000',
  ])
  console.log('APPLY_ORGANIZATIONS_NOT_NULL_STAGING_OK')
}

main()
