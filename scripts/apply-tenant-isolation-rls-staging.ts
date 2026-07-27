/**
 * Staging: apply ENABLE+FORCE RLS for tabs/restaurants/users/customer_sessions.
 *   npx tsx scripts/apply-tenant-isolation-rls-staging.ts
 *
 * Marker: APPLY_TENANT_ISOLATION_RLS_STAGING_OK
 * Trigger: commit message contains [apply-tenant-isolation-rls]
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATION = 'supabase/migrations/20260726200000_enable_rls_tabs_restaurants_users_sessions.sql'
const VERSION = '20260726200000'

const url = process.env.SUPABASE_URL || process.env.STAGING_SUPABASE_URL || ''
if (!url.includes(STAGING_PROJECT_REF)) {
  throw new Error('Refusing: not staging Supabase')
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
    VERSION,
  ])
  console.log('APPLY_TENANT_ISOLATION_RLS_STAGING_OK')
}

main()
