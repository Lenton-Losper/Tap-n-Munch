/**
 * Production: apply Phase 4B is_invite_eligible migration.
 *   npx tsx scripts/apply-restaurant-roles-invite-eligible-production.ts
 */
import { config } from 'dotenv'
import {
  PRODUCTION_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.production.local', override: true })

const MIGRATION = 'supabase/migrations/20260705150000_restaurant_roles_invite_eligible.sql'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
if (!url?.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error('Refusing: not production Supabase (.env.production.local)')
}

function main(): void {
  runShellCommand(`npx supabase link --project-ref ${PRODUCTION_PROJECT_REF}`)
  runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, ['db', 'query', '--linked', '-f', MIGRATION])
  runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, [
    'migration',
    'repair',
    '--linked',
    '--status',
    'applied',
    '20260705150000',
  ])
  console.log('RESTAURANT_ROLES_INVITE_ELIGIBLE_PRODUCTION_OK')
}

main()
