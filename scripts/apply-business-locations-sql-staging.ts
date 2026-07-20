/**
 * Staging: apply the Business & Locations SQL functions (seed_restaurant_roles extraction,
 * create_restaurant_for_user organization-name param, create_organization_location).
 *   npx tsx scripts/apply-business-locations-sql-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATIONS = [
  ['supabase/migrations/20260720100000_seed_restaurant_roles_function.sql', '20260720100000'],
  ['supabase/migrations/20260720110000_create_organization_location_function.sql', '20260720110000'],
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
  console.log('APPLY_BUSINESS_LOCATIONS_SQL_STAGING_OK')
}

main()
