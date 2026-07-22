/**
 * Production: apply menu_categories / menu_subcategories / menu_items RLS write lockdown.
 *   npx tsx scripts/apply-menu-tables-rls-production.ts
 */
import { config } from 'dotenv'
import {
  PRODUCTION_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.production.local', override: true })

const MIGRATION = 'supabase/migrations/20260705200000_menu_tables_rls_write_lockdown.sql'

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
    '20260705200000',
  ])
  console.log('MENU_TABLES_RLS_WRITE_LOCKDOWN_PRODUCTION_OK')
}

main()
