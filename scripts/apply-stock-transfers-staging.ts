/**
 * Staging: apply Workstream 3 migrations (stock_transfers/stock_transfer_items schema,
 * ledger reason values, dispatch/receive/cancel functions).
 *   npx tsx scripts/apply-stock-transfers-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATIONS = [
  ['supabase/migrations/20260719170000_stock_transfers.sql', '20260719170000'],
  ['supabase/migrations/20260719180000_stock_movements_transfer_reasons.sql', '20260719180000'],
  ['supabase/migrations/20260719190000_transfer_dispatch_receive_cancel_functions.sql', '20260719190000'],
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
  console.log('APPLY_STOCK_TRANSFERS_STAGING_OK')
}

main()
