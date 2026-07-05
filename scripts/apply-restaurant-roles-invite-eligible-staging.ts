/**
 * Staging: apply Phase 4B is_invite_eligible migration.
 *   npx tsx scripts/apply-restaurant-roles-invite-eligible-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATION = 'supabase/migrations/20260705150000_restaurant_roles_invite_eligible.sql'

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
    '20260705150000',
  ])
  console.log('RESTAURANT_ROLES_INVITE_ELIGIBLE_STAGING_OK')
}

main()
