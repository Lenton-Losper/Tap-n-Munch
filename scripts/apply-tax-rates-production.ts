/**
 * Production: apply the tax_rates table + menu_items.tax_rate_id migration
 * (Per-item VAT, Phase A). Schema-only, additive, behavior-preserving -- nullable
 * tax_rate_id and no existing code path reads it until the Phase C deploy.
 *   npx tsx scripts/apply-tax-rates-production.ts
 */
import { config } from 'dotenv'
import {
  PRODUCTION_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.production.local', override: true })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
if (!url?.includes(PRODUCTION_PROJECT_REF)) {
  throw new Error('Refusing: not production Supabase (.env.production.local)')
}

const MIGRATIONS = [
  ['supabase/migrations/20260721100000_tax_rates.sql', '20260721100000'],
] as const

function main(): void {
  runShellCommand(`npx supabase link --project-ref ${PRODUCTION_PROJECT_REF}`)
  for (const [file, version] of MIGRATIONS) {
    runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, ['db', 'query', '--linked', '-f', file])
    runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, [
      'migration',
      'repair',
      '--linked',
      '--status',
      'applied',
      version,
    ])
  }
  console.log('APPLY_TAX_RATES_PRODUCTION_OK')
}

main()
