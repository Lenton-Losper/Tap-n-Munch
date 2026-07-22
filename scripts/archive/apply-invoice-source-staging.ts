/**
 * Staging: apply invoice source + restaurant billing columns migration.
 *   npx tsx scripts/apply-invoice-source-staging.ts
 */
import { config } from 'dotenv'
import { STAGING_PROJECT_REF, runShellCommand } from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const url = process.env.SUPABASE_URL!
if (!url?.includes(STAGING_PROJECT_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const MIGRATION = 'supabase/migrations/20260705230000_invoice_requests_source.sql'

runShellCommand(`npx supabase link --project-ref ${STAGING_PROJECT_REF}`)
runShellCommand(`npx supabase db query --linked -f "${MIGRATION}"`)
console.log('INVOICE_SOURCE_MIGRATION_APPLIED_OK')
