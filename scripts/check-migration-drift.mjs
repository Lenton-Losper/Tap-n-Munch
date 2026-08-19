/**
 * Fails the deploy if the target Supabase project's applied migration
 * history doesn't match the migrations committed in supabase/migrations/
 * (#38/#20). Read-only: never applies, repairs, or otherwise mutates
 * anything — detection only, per the incident report's principle that
 * migrations remain a deliberate human-approved action.
 *
 * Two failure modes, both real incidents that already happened once:
 *   - LOCAL_NOT_APPLIED: a migration is committed but not applied on the
 *     target DB -> deploying this code risks the exact PGRST202-style
 *     failure that caused the July 2026 incident.
 *   - APPLIED_NOT_LOCAL: the DB has an applied migration version with no
 *     matching committed file -> undocumented drift, silently accumulates
 *     the way 12 of the 13 missing migrations did.
 *
 * ENVIRONMENT SCOPE (#145). Some migrations belong to exactly one environment — a staging-only
 * seed, or a production-only bootstrap — and the naive full-set comparison had no way to say so.
 * That produced a genuine dilemma: a staging-only migration must exist as a committed file to
 * clear staging drift, and must never be reported as missing on production. Declare scope with a
 * header anywhere in the first 30 lines:
 *
 *     -- @env: staging        only expected on staging
 *     -- @env: production     only expected on production
 *     -- @env: both           explicit default
 *
 * No header means "both", so every existing migration keeps its current behaviour exactly.
 *
 * Scope decides only what is EXPECTED. A migration that has a committed file is always treated as
 * documented, whatever its scope, so scoping can never turn a real applied migration into
 * "undocumented drift". Applying one outside its scope is reported as a warning, not a failure —
 * it is worth knowing about, but it is not a reason to block a deploy.
 *
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/check-migration-drift.mjs
 *        MIGRATION_TARGET_ENV=staging|production overrides ref-based detection.
 */
import { readdirSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations')

const supabaseUrl = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceKey) {
  console.error('MIGRATION DRIFT CHECK: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const PROJECT_REFS = {
  ihlmmpmolnpchzgwyhgh: 'production',
  mdqjpxwczrhkxkbqatqa: 'staging',
}

/** Which environment SUPABASE_URL points at. An explicit override wins. */
function targetEnvironment() {
  const override = String(process.env.MIGRATION_TARGET_ENV ?? '').trim().toLowerCase()
  if (override === 'staging' || override === 'production') return override
  const ref = supabaseUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1]
  return PROJECT_REFS[ref] ?? 'unknown'
}

const SCOPE_RE = /^[ \t]*--[ \t]*@env:[ \t]*(staging|production|both)[ \t]*$/im

/** Reads the `-- @env:` header from the first 30 lines. Absent means 'both'. */
function scopeOf(fileName) {
  try {
    const head = readFileSync(join(MIGRATIONS_DIR, fileName), 'utf8')
      .split('\n')
      .slice(0, 30)
      .join('\n')
    const declared = head.match(SCOPE_RE)?.[1]
    return declared ? declared.toLowerCase() : 'both'
  } catch {
    return 'both'
  }
}

/** Every committed migration, with its declared scope. */
function localMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, version: name.match(/^(\d+)_/)?.[1], scope: scopeOf(name) }))
    .filter((m) => Boolean(m.version))
    .sort((a, b) => a.version.localeCompare(b.version))
}

async function appliedMigrationVersions(supabase) {
  const { data, error } = await supabase.rpc('list_applied_migration_versions')
  if (error) {
    throw new Error(`list_applied_migration_versions RPC failed: ${error.message}`)
  }
  return (data ?? []).map((row) => String(row.version)).sort()
}

async function main() {
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const env = targetEnvironment()
  const all = localMigrations()
  const applied = new Set(await appliedMigrationVersions(supabase))

  /**
   * #280 OPTION A — TWO FILES SHARING A VERSION MAKE THIS CHECK LIE.
   *
   * A migration is identified by its numeric prefix alone and versions are collapsed into a Set,
   * while the ledger stores one row per VERSION, not per file. So two different migrations with
   * the same prefix are indistinguishable here, and applying either one marks the version applied
   * and silences the other.
   *
   * IT HAS HAPPENED, and for three days: `20260811120000` was
   * `..._tabs_anon_grant_drop_members.sql` on main (#262, revoking an anon grant) and
   * `..._restaurant_terminals_status_check_live_vocabulary.sql` on cloudflare-staging (#193, a
   * CHECK on the table gating terminal auth). The dangerous direction was that applying #193's
   * file on staging would have let main read ITS `20260811120000` as satisfied and ship #262's
   * code with the anon grant still wide open — the exact exposure #262 exists to close.
   *
   * This is the lying-instrument shape: `MIGRATION DRIFT CHECK: OK` would have been true about
   * VERSIONS and false about MIGRATIONS. A wrong answer, well formatted, instead of an error.
   *
   * Checked BEFORE any comparison, and fatal, because every number computed below is derived from
   * a Set that has already discarded one of the duplicates — there is no partial answer worth
   * printing once this is true.
   *
   * WHAT THIS DOES NOT CATCH, stated so nobody reads more into a green than it carries: duplicates
   * living on DIFFERENT branches, where each branch sees only one file. That is exactly the state
   * that existed for three days. It fires the moment a cherry-pick brings them onto one branch,
   * which is when the damage would otherwise land. Option C — refusing a version already present
   * on any remote at creation time — is what closes that, and is not this.
   */
  const byVersion = new Map()
  for (const m of all) {
    if (!byVersion.has(m.version)) byVersion.set(m.version, [])
    byVersion.get(m.version).push(m.name)
  }
  const duplicates = [...byVersion.entries()].filter(([, names]) => names.length > 1)

  if (duplicates.length) {
    console.error('\nMIGRATION DRIFT CHECK: FAILED — duplicate migration version(s)\n')
    console.error(
      'Two committed files share one numeric prefix. The ledger stores one row per VERSION, so\n' +
        'applying either marks the version applied and silences the other. Every count this check\n' +
        'would print below is computed from a Set that has already dropped one of them.\n',
    )
    for (const [version, names] of duplicates) {
      console.error(`  ${version}`)
      for (const n of names) console.error(`      ${n}`)
    }
    console.error(
      '\nRename one of them to a free prefix and re-run. Do NOT apply either until you have,\n' +
        'and read both files first — they are different migrations, not a duplicate of one.\n',
    )
    process.exit(1)
  }

  // Every committed version regardless of scope: an applied migration that has ANY committed
  // file is documented, so scoping can never manufacture "undocumented drift".
  const allVersions = new Set(all.map((m) => m.version))
  const expected = all.filter((m) => m.scope === 'both' || m.scope === env)
  const outOfScope = all.filter((m) => m.scope !== 'both' && m.scope !== env)

  const localNotApplied = expected.map((m) => m.version).filter((v) => !applied.has(v)).sort()
  const appliedNotLocal = [...applied].filter((v) => !allVersions.has(v)).sort()
  const appliedOutOfScope = outOfScope.filter((m) => applied.has(m.version))

  console.log(
    `MIGRATION DRIFT CHECK: target=${env}; ${all.length} local migration(s), ` +
      `${expected.length} expected here, ${applied.size} applied on target DB`,
  )

  if (env === 'unknown') {
    console.warn(
      '  WARNING: could not identify the target environment from SUPABASE_URL, so every scoped ' +
        'migration is being treated as in scope. Set MIGRATION_TARGET_ENV to be explicit.',
    )
  }
  if (outOfScope.length > 0) {
    console.log(
      `  Excluded as out of scope for ${env}:\n` +
        outOfScope.map((m) => `    - ${m.version} (@env: ${m.scope})`).join('\n'),
    )
  }
  if (appliedOutOfScope.length > 0) {
    console.warn(
      `  WARNING: applied on ${env} despite being scoped elsewhere:\n` +
        appliedOutOfScope.map((m) => `    - ${m.version} (@env: ${m.scope})`).join('\n'),
    )
  }

  if (localNotApplied.length === 0 && appliedNotLocal.length === 0) {
    console.log('MIGRATION DRIFT CHECK: OK — local migrations and target DB are in sync.')
    return
  }

  console.error('MIGRATION DRIFT CHECK: FAILED')
  if (localNotApplied.length > 0) {
    console.error(
      `  Committed migrations NOT applied on target DB (deploying this code is unsafe):\n` +
        localNotApplied.map((v) => `    - ${v}`).join('\n'),
    )
  }
  if (appliedNotLocal.length > 0) {
    console.error(
      `  Migrations applied on target DB with NO matching committed file (undocumented drift):\n` +
        appliedNotLocal.map((v) => `    - ${v}`).join('\n'),
    )
  }
  console.error(
    '  Resolve via the guarded wrapper (scripts/safe-supabase-linked.ts) or by committing the ' +
      'missing migration file, then re-run this check. See FlashTap-Production-Migration-Drift-Incident-Report.docx.',
  )
  process.exit(1)
}

main().catch((error) => {
  console.error('MIGRATION DRIFT CHECK: error', error)
  process.exit(1)
})
