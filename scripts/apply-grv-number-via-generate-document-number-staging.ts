/**
 * Staging: apply the GRV numbering cleanup migration (assign_grv_number() now delegates
 * to generate_document_number() instead of duplicating the formatting logic).
 *   npx tsx scripts/apply-grv-number-via-generate-document-number-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATION = 'supabase/migrations/20260717150000_grv_number_via_generate_document_number.sql'

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
    '20260717150000',
  ])
  console.log('GRV_NUMBER_VIA_GENERATE_DOCUMENT_NUMBER_STAGING_OK')
}

main()
