/**
 * Apply the organisation merge to PRODUCTION, in order, through the mandatory safe wrapper.
 *
 *   npx tsx scripts/apply-org-merge-production.ts            # 00 then 01, then verify
 *   npx tsx scripts/apply-org-merge-production.ts dsgdsg     # 03 only, after the merge has landed
 *
 * NO `migration repair`, deliberately. Every other apply-*-production.ts in this repo pairs
 * `db query` with a ledger repair because it is applying a MIGRATION. These files are a one-off
 * DATA change to specific rows on one database: they describe no schema, must never replay onto
 * staging or a fresh environment, and have no business in schema_migrations. Recording them there
 * would be a lie about what the ledger means.
 *
 * The project ref is confirmed before every operation -- once by this script against the URL, and
 * again inside runSafeSupabaseLinked, which refuses to run if the linked project is not the one
 * named. Two independent checks because a mis-linked CLI is the failure that silently hits the
 * wrong database.
 */
import {
  PRODUCTION_PROJECT_REF,
  runSafeSupabaseLinked,
  runShellCommand,
} from './lib/safe-supabase-linked'

const MERGE_FILES = [
  'ops/org-merge/00-rename-chownow-coke.sql',
  'ops/org-merge/01-merge-chownow-into-riviera.sql',
  'ops/org-merge/02-verify-merge.sql',
] as const

const DSGDSG_FILES = ['ops/org-merge/03-deactivate-dsgdsg.sql'] as const

function main(): void {
  const mode = process.argv[2] === 'dsgdsg' ? 'dsgdsg' : 'merge'
  const files = mode === 'dsgdsg' ? DSGDSG_FILES : MERGE_FILES

  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.PRODUCTION_SUPABASE_URL ||
    ''
  if (!url) {
    throw new Error('Refusing: no SUPABASE_URL to confirm the project ref against')
  }
  if (!url.includes(PRODUCTION_PROJECT_REF)) {
    throw new Error(`Refusing: SUPABASE_URL is not production (${PRODUCTION_PROJECT_REF})`)
  }
  console.log(`Project ref confirmed: ${PRODUCTION_PROJECT_REF}`)
  console.log(`Mode: ${mode}`)

  runShellCommand(`npx supabase link --project-ref ${PRODUCTION_PROJECT_REF} --yes`)

  for (const file of files) {
    console.log(`\n=============== ${file}`)
    // Each file is its own transaction and its own assertions. Running them one call at a time
    // means a failure stops the sequence here rather than being carried past -- 01 must not run
    // if 00 did not commit.
    runSafeSupabaseLinked(PRODUCTION_PROJECT_REF, ['db', 'query', '--linked', '-f', file])
  }

  console.log(`\nAPPLY_ORG_MERGE_${mode.toUpperCase()}_OK`)
}

main()
