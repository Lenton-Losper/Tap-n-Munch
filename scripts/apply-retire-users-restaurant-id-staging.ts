/**
 * Staging: apply retirement of users.restaurant_id (repoint bug_reports RLS to
 * user_restaurant_ids(), drop the redundant restaurants SELECT policy, drop the column).
 *   npx tsx scripts/apply-retire-users-restaurant-id-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATION = 'supabase/migrations/20260719100000_retire_users_restaurant_id.sql'

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
    '20260719100000',
  ])
  console.log('RETIRE_USERS_RESTAURANT_ID_STAGING_OK')
}

main()
