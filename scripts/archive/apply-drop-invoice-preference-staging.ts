/**
 * Staging: backfill invoice_requests from order/tab preference columns and drop them.
 *   npx tsx scripts/apply-drop-invoice-preference-staging.ts
 */
import { config } from 'dotenv'
import { STAGING_PROJECT_REF, runShellCommand } from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const url = process.env.SUPABASE_URL!
if (!url?.includes(STAGING_PROJECT_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const MIGRATION = 'supabase/migrations/20260705250000_drop_invoice_preference_columns.sql'

runShellCommand(`npx supabase link --project-ref ${STAGING_PROJECT_REF}`)
runShellCommand(`npx supabase db query --linked -f "${MIGRATION}"`)
console.log('DROP_INVOICE_PREFERENCE_MIGRATION_APPLIED_OK')
