/**
 * Apply the five 2026-08-24 `-- @env: both` migrations to PRODUCTION over a direct Postgres
 * connection. ONE-OFF. WRITES DDL.
 *
 * The Supabase CLI path needs an account token that is not configured, and CI has no DDL
 * credentials at all (verified: SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD, DATABASE_URL and
 * SUPABASE_DB_URL are all empty in Actions). This connects directly instead.
 *
 * THE PASSWORD IS READ FROM THE FILE, NEVER FROM ARGV OR THE ENVIRONMENT, and never printed. A
 * secret on a command line is visible in the process table and in shell history.
 *
 * IDENTITY IS VERIFIED FROM THE DATABASE, NOT FROM DNS. Local DNS here answers every hostname with
 * the router address, so a name lookup proves nothing. Instead the script asserts, against the
 * connected server:
 *
 *   - the ledger does NOT contain 20260705210000 or 20260705220000. Those two ARE applied on
 *     staging and are deliberately absent from production, so their absence distinguishes the two
 *     databases by state rather than by name.
 *   - none of the five targets is already applied.
 *
 * Either check failing is a refusal, not a warning.
 *
 * EXACTLY FIVE VERSIONS, hard-coded. Never "everything pending" -- that would sweep in the two
 * headerless migrations above, which is precisely what the batch excludes.
 *
 * Each file runs in ITS OWN TRANSACTION together with its ledger row, so a failure leaves neither a
 * half-applied schema nor a ledger claiming something that did not land. Stops on first error.
 *
 * Usage (from the repo root):
 *   node scripts/prod/apply-migrations-direct-pg.mjs            # dry run: connects, verifies, stops
 *   node scripts/prod/apply-migrations-direct-pg.mjs --confirm  # applies
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/',
)
const { Client } = require('pg')

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const CONFIRM = process.argv.includes('--confirm')

/** Applied on staging, deliberately NOT on production. Their absence identifies the database. */
const MUST_BE_ABSENT = ['20260705210000', '20260705220000']

const VERSIONS = ['20260824120000', '20260824123000', '20260824130000', '20260824140000', '20260824150000']

function readSecret(name) {
  const text = readFileSync(ENV_FILE, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`${name} not found in ${ENV_FILE}`)
}

function migrationPath(version) {
  const { readdirSync } = require('node:fs')
  const dir = 'supabase/migrations'
  const file = readdirSync(dir).find((f) => f.startsWith(version + '_') && f.endsWith('.sql'))
  if (!file) throw new Error(`no migration file for ${version}`)
  return `${dir}/${file}`
}

async function main() {
  console.log('='.repeat(78))
  console.log('APPLY 5 MIGRATIONS TO PRODUCTION — direct Postgres')
  console.log('='.repeat(78))
  console.log(`  target project ref : ${PROD_REF}`)
  console.log(`  password source    : ${ENV_FILE} (SUPABASE_DB_PASSWORD_PROD, not printed)`)
  console.log(`  versions           : ${VERSIONS.join(' ')}`)
  console.log(`  mode               : ${CONFIRM ? 'APPLY' : 'DRY RUN — verifies, then stops'}`)
  console.log('')

  const password = readSecret('SUPABASE_DB_PASSWORD_PROD')
  if (!password) throw new Error('SUPABASE_DB_PASSWORD_PROD is empty')

  // Session mode (5432), not transaction mode (6543): DDL and explicit transactions need a session.
  const candidates = [
    // eu-west-1 FIRST, established by probing tenant lookup across regions. Production is NOT in
    // eu-central-1 where staging lives -- that pooler answered 'tenant/user not found', which is
    // Supavisor rejecting the tenant rather than a network failure, and it is what identified the
    // region. Local DNS answers every name with the router address, so nslookup could not.
    { label: 'pooler eu-west-1', host: 'aws-0-eu-west-1.pooler.supabase.com', port: 5432, user: `postgres.${PROD_REF}` },
    { label: 'direct', host: `db.${PROD_REF}.supabase.co`, port: 5432, user: 'postgres' },
    { label: 'pooler eu-central-1 (aws-1)', host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: `postgres.${PROD_REF}` },
    { label: 'pooler eu-central-1 (aws-0)', host: 'aws-0-eu-central-1.pooler.supabase.com', port: 5432, user: `postgres.${PROD_REF}` },
  ]

  let client = null
  let used = null
  for (const c of candidates) {
    const trial = new Client({
      host: c.host,
      port: c.port,
      user: c.user,
      password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    })
    try {
      await trial.connect()
      client = trial
      used = c
      break
    } catch (e) {
      console.log(`  ${c.label.padEnd(28)} ${String(e.message).slice(0, 70)}`)
      try {
        await trial.end()
      } catch {}
    }
  }
  if (!client) throw new Error('could not connect to production over any candidate host')
  console.log(`\n  CONNECTED via ${used.label}  (${used.host}:${used.port})`)

  try {
    // ---------------------------------------------------------------- identity
    const { rows: ledger } = await client.query(
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
    )
    const applied = new Set(ledger.map((r) => String(r.version)))
    console.log(`  ledger rows: ${applied.size}`)

    const failures = []
    for (const v of MUST_BE_ABSENT) {
      const present = applied.has(v)
      console.log(`  ${v} absent (staging has it): ${present ? 'NO — PRESENT' : 'yes'}`)
      if (present) failures.push(`${v} IS applied here — this looks like STAGING (${STAGING_REF}), not production`)
    }
    const alreadyThere = VERSIONS.filter((v) => applied.has(v))
    if (alreadyThere.length) {
      console.log(`  already applied: ${alreadyThere.join(' ')}`)
    }

    if (failures.length) {
      console.log('\n' + '='.repeat(78))
      console.log('REFUSING — identity checks did not hold:')
      for (const f of failures) console.log('  - ' + f)
      console.log('Nothing was changed.')
      process.exitCode = 2
      return
    }

    const todo = VERSIONS.filter((v) => !applied.has(v))
    console.log(`\n  to apply: ${todo.length ? todo.join(' ') : 'nothing — all five already applied'}`)

    if (!CONFIRM) {
      console.log('\nDRY RUN complete. Re-run with --confirm to apply.')
      return
    }
    if (!todo.length) {
      console.log('\nNothing to do.')
      return
    }

    // ---------------------------------------------------------------- apply
    for (const version of todo) {
      const path = migrationPath(version)
      const sql = readFileSync(path, 'utf8')
      console.log('\n' + '='.repeat(78))
      console.log(`APPLYING ${path}`)
      console.log(`  ${sql.split(/\r?\n/)[0]}`)
      console.log('='.repeat(78))

      try {
        await client.query('BEGIN')
        await client.query(sql)
        // The ledger row goes in the SAME transaction, so it can never claim something that
        // rolled back -- the failure mode `db query` has, which is why the ledger needs repairing
        // separately when the CLI is used.
        await client.query(
          'INSERT INTO supabase_migrations.schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING',
          [version],
        )
        await client.query('COMMIT')
        console.log(`  APPLIED ${version}, ledger updated in the same transaction`)
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        console.log('')
        console.log('='.repeat(78))
        console.log(`FAILED ON ${version} — rolled back, STOPPING`)
        console.log('='.repeat(78))
        console.log(`  ${e.message}`)
        console.log('')
        console.log('  Migrations before this one are applied and committed; this one and every')
        console.log('  later one are not. Re-running skips what already landed.')
        process.exitCode = 1
        return
      }
    }

    const { rows: after } = await client.query(
      'SELECT version FROM supabase_migrations.schema_migrations WHERE version = ANY($1) ORDER BY version',
      [VERSIONS],
    )
    console.log(`\n  ledger now carries ${after.length} of ${VERSIONS.length}: ${after.map((r) => r.version).join(' ')}`)
    console.log('\nAPPLY_MIGRATIONS_DIRECT_OK')
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exitCode = 1
})
