/**
 * Staging: apply the tax_rates table + menu_items.tax_rate_id migration (Per-item VAT, Phase A).
 *   npx tsx scripts/apply-tax-rates-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATIONS = [
  ['supabase/migrations/20260721100000_tax_rates.sql', '20260721100000'],
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
  console.log('APPLY_TAX_RATES_STAGING_OK')
}

main()
