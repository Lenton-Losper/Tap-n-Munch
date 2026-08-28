import {
  PRODUCTION_PROJECT_REF,
  readLinkedProjectRef,
  runSafeSupabaseLinked,
  formatAbortMessage,
  SafeSupabaseLinkedError,
} from './lib/safe-supabase-linked'

const FILE = '20260829170000_order_line_allocations.sql'
const VERSION = FILE.split('_')[0]

function main(): void {
  console.log(`=== Applying ${FILE} to PRODUCTION (${PRODUCTION_PROJECT_REF}) ===\n`)
  const linkedRef = readLinkedProjectRef()
  if (linkedRef !== PRODUCTION_PROJECT_REF) {
    throw new SafeSupabaseLinkedError(formatAbortMessage(PRODUCTION_PROJECT_REF, linkedRef))
  }
  console.log(`    ref confirmed: ${linkedRef}`)
  runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, ['db', 'query', '--linked', '-f', `supabase/migrations/${FILE}`])
  runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, ['migration', 'repair', '--linked', '--status', 'applied', VERSION])
  console.log(`\n=== APPLIED AND RECORDED ===`)
}
main()
