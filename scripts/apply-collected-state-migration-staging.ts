import {
  STAGING_PROJECT_REF,
  readLinkedProjectRef,
  runSafeSupabaseLinked,
  formatAbortMessage,
  SafeSupabaseLinkedError,
} from './lib/safe-supabase-linked'

const FILE = '20260829160000_collected_state.sql'
const VERSION = FILE.split('_')[0]

function main(): void {
  console.log(`=== Applying ${FILE} to STAGING (${STAGING_PROJECT_REF}) ===\n`)

  const linkedRef = readLinkedProjectRef()
  if (linkedRef !== STAGING_PROJECT_REF) {
    throw new SafeSupabaseLinkedError(formatAbortMessage(STAGING_PROJECT_REF, linkedRef))
  }
  console.log(`    ref confirmed: ${linkedRef}`)

  runSafeSupabaseLinked(STAGING_PROJECT_REF, ['db', 'query', '--linked', '-f', `supabase/migrations/${FILE}`])
  runSafeSupabaseLinked(STAGING_PROJECT_REF, ['migration', 'repair', '--linked', '--status', 'applied', VERSION])
  console.log(`\n=== APPLIED AND RECORDED ===`)
}
main()
