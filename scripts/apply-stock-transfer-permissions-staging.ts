/**
 * Staging: apply Workstream 4 migrations (permission backfill, transfer RLS, create_transfer
 * function + grant tightening on dispatch_transfer/receive_transfer).
 *   npx tsx scripts/apply-stock-transfer-permissions-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATIONS = [
  ['supabase/migrations/20260719210000_stock_transfer_permissions_backfill.sql', '20260719210000'],
  ['supabase/migrations/20260719220000_stock_transfers_rls.sql', '20260719220000'],
  ['supabase/migrations/20260719230000_create_transfer_function.sql', '20260719230000'],
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
  console.log('APPLY_STOCK_TRANSFER_PERMISSIONS_STAGING_OK')
}

main()
