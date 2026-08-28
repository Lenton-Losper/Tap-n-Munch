/**
 * Staging: apply 20260828235900_order_line_events_four_state_check.sql -- widens
 * order_line_events.from_state/to_state to the real four-state vocabulary. See that migration's
 * own docblock for what this fixes and how it was discovered (a live staging proof, not a guess).
 *
 *   npx tsx scripts/apply-order-line-events-four-state-check-staging.ts
 */
import { config } from 'dotenv'
import {
  STAGING_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

config({ path: '.env.test', override: true })

const MIGRATION = 'supabase/migrations/20260828235900_order_line_events_four_state_check.sql'

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
    '20260828235900',
  ])
  console.log('APPLY_ORDER_LINE_EVENTS_FOUR_STATE_CHECK_STAGING_OK')
}

main()
