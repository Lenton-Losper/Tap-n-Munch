/**
 * Staging: apply Phase 4A composite FK migration.
 *
 *   npx tsx scripts/apply-restaurant-roles-fk-staging.ts
 *
 * Uses scripts/lib/safe-supabase-linked.ts — see CONTRIBUTING.md.
 * Never run raw `supabase db query --linked` or `migration repair --linked`.
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATION = 'supabase/migrations/20260705140000_restaurant_roles_composite_fk.sql'

const url = process.env.SUPABASE_URL!
if (!url?.includes(STAGING_PROJECT_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

function linkStaging(): void {
  const command = `npx supabase link --project-ref ${STAGING_PROJECT_REF}`
  console.log(`> ${command}`)
  runShellCommand(command)
}

function main(): void {
  linkStaging()
  runSafeSupabaseLinked(STAGING_PROJECT_REF, ['db', 'query', '--linked', '-f', MIGRATION])
  runSafeSupabaseLinked(STAGING_PROJECT_REF, [
    'migration',
    'repair',
    '--linked',
    '--status',
    'applied',
    '20260705140000',
  ])
  console.log('RESTAURANT_ROLES_FK_STAGING_OK')
}

main()
