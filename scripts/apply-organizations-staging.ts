/**
 * Staging: apply Workstream 2 migrations 1-4 (organizations + membership + canonical item
 * identity, up to and including the organization_stock_items backfill). Deliberately stops
 * short of 20260719150000 (the NOT NULL migration) -- that one is applied separately by
 * apply-organizations-not-null-staging.ts, only after verify-organizations-staging.ts
 * confirms 100% backfill coverage.
 *   npx tsx scripts/apply-organizations-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATIONS = [
  ['supabase/migrations/20260719110000_organizations_and_membership.sql', '20260719110000'],
  ['supabase/migrations/20260719120000_organizations_backfill.sql', '20260719120000'],
  ['supabase/migrations/20260719130000_organization_stock_items.sql', '20260719130000'],
  ['supabase/migrations/20260719140000_organization_stock_items_backfill.sql', '20260719140000'],
  ['supabase/migrations/20260719160000_create_restaurant_for_user_organization.sql', '20260719160000'],
] as const

const url = process.env.SUPABASE_URL!
if (!url?.includes(STAGING_PROJECT_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

function main(): void {
  runShellCommand(`npx supabase link --project-ref ${STAGING_PROJECT_REF}`)
  for (const [file, version] of MIGRATIONS) {
    runSafeSupabaseLinked(STAGING_PROJECT_REF, ['db', 'query', '--linked', '-f', file])
    runSafeSupabaseLinked(STAGING_PROJECT_REF, [
      'migration',
      'repair',
      '--linked',
      '--status',
      'applied',
      version,
    ])
  }
  console.log('APPLY_ORGANIZATIONS_STAGING_OK')
}

main()
