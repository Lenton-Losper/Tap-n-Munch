import {
  STAGING_PROJECT_REF,
  readLinkedProjectRef,
  runSafeSupabaseLinked,
  formatAbortMessage,
  SafeSupabaseLinkedError,
} from './lib/safe-supabase-linked'

/**
 * Both already live on production (Deploy 3) -- confirmed never applied to staging via
 * `supabase migration list --linked` (remote column blank for both). That gap is why
 * POST /api/admin/staff/bulk-create failed on staging with "null value in column id of relation
 * users" before it could even reach the email check: 20260829131000 adds the staff_members
 * columns this route writes, and 20260829131100 is the email-nullable flip its own docblock
 * depends on.
 */
const MIGRATIONS = ['20260829131000_staff_without_logins.sql', '20260829131100_users_email_nullable.sql']

function versionOf(filename: string): string {
  return filename.split('_')[0]
}

function main(): void {
  console.log(`=== Applying ${MIGRATIONS.length} Deploy 3 migrations to STAGING (${STAGING_PROJECT_REF}) ===\n`)

  for (const file of MIGRATIONS) {
    const version = versionOf(file)
    const linkedRef = readLinkedProjectRef()
    if (linkedRef !== STAGING_PROJECT_REF) {
      throw new SafeSupabaseLinkedError(formatAbortMessage(STAGING_PROJECT_REF, linkedRef))
    }
    runSafeSupabaseLinked(STAGING_PROJECT_REF, ['db', 'query', '--linked', '-f', `supabase/migrations/${file}`])
    runSafeSupabaseLinked(STAGING_PROJECT_REF, ['migration', 'repair', '--linked', '--status', 'applied', version])
    console.log(`    ${file} -- APPLIED AND RECORDED`)
  }
  console.log('\n=== DONE ===')
}
main()
