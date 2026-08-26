/**
 * Apply `20260826120000_held_payments.sql` over a direct Postgres connection. WRITES DDL.
 *
 * WHY NOT CI. The staging workflow's apply job ran on 2026-08-26 and refused: SUPABASE_ACCESS_TOKEN,
 * STAGING_DATABASE_URL, DATABASE_URL, SUPABASE_DB_URL, STAGING_SUPABASE_DB_PASSWORD and
 * SUPABASE_DB_PASSWORD are ALL empty in Actions — printed by the job's own credential probe. That is
 * why every sibling apply job in that workflow carries `continue-on-error: true` and a comment
 * telling the operator to paste the SQL by hand. This is the same route
 * `scripts/prod/apply-migrations-direct-pg.mjs` took for the 2026-08-24 batch.
 *
 * THE PASSWORD IS READ FROM THE FILE, NEVER FROM ARGV OR THE ENVIRONMENT, and never printed. A
 * secret on a command line is visible in the process table and in shell history.
 *
 * IDENTITY IS VERIFIED FROM THE DATABASE, NOT FROM DNS, and the check is INVERTED PER TARGET.
 * Local DNS here answers every hostname with the router address, so a name lookup proves nothing.
 * Instead the script asserts against the connected server:
 *
 *   staging     20260705210000 and 20260705220000 ARE in the ledger
 *   production  they are NOT
 *
 * Those two migrations are applied on staging and deliberately absent from production, so their
 * presence distinguishes the two databases BY STATE rather than by name. Running the staging
 * command against production fails the check, and vice versa. That is the whole point of doing it
 * this way round: a mistyped ref is caught by the database disagreeing, not by me reading carefully.
 *
 * ONE VERSION, HARD-CODED. Never "everything pending" — that would sweep in whatever else is
 * unapplied on the target, which is a different decision needing a different review.
 *
 * The file and its ledger row go in ONE transaction, so a failure leaves neither a half-applied
 * schema nor a ledger claiming something that did not land. `db query` does NOT write the ledger
 * row, which is the trap that makes the next deploy's drift gate fail after a successful apply.
 *
 * Usage (from the qrd-stage repo root):
 *   node scripts/apply-held-payments-direct-pg.mjs staging               # dry run
 *   node scripts/apply-held-payments-direct-pg.mjs staging --confirm     # applies
 *   node scripts/apply-held-payments-direct-pg.mjs production --confirm
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/',
)
const { Client } = require('pg')

const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const VERSION = '20260826120000'

/** Applied on staging, deliberately NOT on production. Presence identifies the database. */
const STAGING_ONLY = ['20260705210000', '20260705220000']

const TARGETS = {
  staging: {
    ref: 'mdqjpxwczrhkxkbqatqa',
    secret: 'SUPABASE_DB_PASSWORD_STAGING',
    expectStagingOnly: true,
    hosts: [
      { label: 'pooler eu-central-1 (aws-1)', host: 'aws-1-eu-central-1.pooler.supabase.com' },
      { label: 'pooler eu-central-1 (aws-0)', host: 'aws-0-eu-central-1.pooler.supabase.com' },
      { label: 'pooler eu-west-1', host: 'aws-0-eu-west-1.pooler.supabase.com' },
    ],
  },
  production: {
    ref: 'ihlmmpmolnpchzgwyhgh',
    secret: 'SUPABASE_DB_PASSWORD_PROD',
    expectStagingOnly: false,
    hosts: [
      { label: 'pooler eu-west-1', host: 'aws-0-eu-west-1.pooler.supabase.com' },
      { label: 'pooler eu-central-1 (aws-1)', host: 'aws-1-eu-central-1.pooler.supabase.com' },
      { label: 'pooler eu-central-1 (aws-0)', host: 'aws-0-eu-central-1.pooler.supabase.com' },
    ],
  },
}

function readSecret(name) {
  const text = readFileSync(ENV_FILE, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`${name} not found in ${ENV_FILE}`)
}

function migrationPath(version) {
  const dir = 'supabase/migrations'
  const file = readdirSync(dir).find((f) => f.startsWith(version + '_') && f.endsWith('.sql'))
  if (!file) throw new Error(`no migration file for ${version}`)
  return `${dir}/${file}`
}

async function main() {
  const targetName = process.argv[2]
  const CONFIRM = process.argv.includes('--confirm')
  const target = TARGETS[targetName]
  if (!target) {
    console.error('Usage: node scripts/apply-held-payments-direct-pg.mjs <staging|production> [--confirm]')
    process.exit(1)
  }

  console.log('='.repeat(78))
  console.log(`APPLY ${VERSION}_held_payments TO ${targetName.toUpperCase()} — direct Postgres`)
  console.log('='.repeat(78))
  console.log(`  target project ref : ${target.ref}`)
  console.log(`  password source    : ${ENV_FILE} (${target.secret}, not printed)`)
  console.log(`  mode               : ${CONFIRM ? 'APPLY' : 'DRY RUN — verifies, then stops'}`)
  console.log('')

  const password = readSecret(target.secret)
  if (!password) throw new Error(`${target.secret} is empty`)

  // Session mode (5432), not transaction mode (6543): DDL and explicit transactions need a session.
  let client = null
  let used = null
  for (const c of target.hosts) {
    const trial = new Client({
      host: c.host,
      port: 5432,
      user: `postgres.${target.ref}`,
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
      console.log(`  ${c.label.padEnd(30)} ${String(e.message).slice(0, 70)}`)
      try {
        await trial.end()
      } catch {}
    }
  }
  if (!client) throw new Error(`could not connect to ${targetName} over any candidate host`)
  console.log(`\n  CONNECTED via ${used.label}  (${used.host}:5432)`)

  try {
    const { rows: ledger } = await client.query(
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
    )
    const applied = new Set(ledger.map((r) => String(r.version)))
    console.log(`  ledger rows: ${applied.size}`)

    const failures = []

    // ---------------------------------------------------------------- identity, by state
    for (const v of STAGING_ONLY) {
      const present = applied.has(v)
      const ok = present === target.expectStagingOnly
      console.log(
        `  identity ${v}: ${present ? 'present' : 'absent'}  ` +
          `(expected ${target.expectStagingOnly ? 'present' : 'absent'} on ${targetName})  ${ok ? 'OK' : 'MISMATCH'}`,
      )
      if (!ok) {
        failures.push(
          `${v} is ${present ? 'present' : 'absent'} — this is NOT ${targetName}. Refusing.`,
        )
      }
    }

    // ---------------------------------------------------------------- not already applied
    if (applied.has(VERSION)) {
      failures.push(`${VERSION} is already in the ledger on ${targetName}. Nothing to do.`)
    }

    // ---------------------------------------------------------------- and the table itself
    const { rows: existing } = await client.query(
      "SELECT to_regclass('public.held_payments') AS t",
    )
    const tableExists = existing[0]?.t !== null
    console.log(`  public.held_payments exists: ${tableExists}`)
    if (tableExists && !applied.has(VERSION)) {
      // The table without the ledger row is the `db query` trap: the SQL ran, the ledger did not
      // record it, and the next deploy's drift gate fails having applied the migration correctly.
      // That wants a ledger REPAIR, not a re-run. Never re-run a verified-present object.
      console.log('')
      console.log('  The TABLE exists but the LEDGER ROW does not.')
      console.log('  That is a ledger repair, not a re-run:')
      console.log(`    INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('${VERSION}');`)
      failures.push('table present without ledger row — repair the ledger, do not re-run the DDL')
    }

    if (failures.length) {
      console.log('')
      for (const f of failures) console.log(`  REFUSING: ${f}`)
      process.exitCode = 1
      return
    }

    console.log('\n  All preconditions pass.')

    if (!CONFIRM) {
      console.log('\n  DRY RUN. Nothing was written. Re-run with --confirm to apply.')
      return
    }

    // ---------------------------------------------------------------- apply
    const path = migrationPath(VERSION)
    const sql = readFileSync(path, 'utf8')
    console.log(`\n  applying ${path} (${sql.length} bytes)`)

    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query(
        'INSERT INTO supabase_migrations.schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING',
        [VERSION],
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
    console.log('  applied and recorded in one transaction.')

    // ---------------------------------------------------------------- verify what landed
    const { rows: after } = await client.query(
      `SELECT
         (SELECT to_regclass('public.held_payments') IS NOT NULL) AS tbl,
         (SELECT count(*) FROM pg_constraint WHERE conname = 'held_payments_idempotency_unique') AS uniq,
         (SELECT count(*) FROM pg_indexes WHERE tablename = 'held_payments') AS idx,
         (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.held_payments'::regclass) AS rls,
         (SELECT count(*) FROM pg_policies WHERE tablename = 'held_payments') AS policies,
         (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = $1) AS ledger`,
      [VERSION],
    )
    const r = after[0]
    console.log('')
    console.log('  VERIFIED ON THE SERVER:')
    console.log(`    table                              ${r.tbl}`)
    console.log(`    held_payments_idempotency_unique   ${r.uniq}   <- the two-sided property rests on this`)
    console.log(`    indexes                            ${r.idx}`)
    console.log(`    row level security                 ${r.rls}`)
    console.log(`    policies                           ${r.policies}`)
    console.log(`    ledger row                         ${r.ledger}`)

    if (Number(r.uniq) !== 1) {
      console.log('\n  *** held_payments_idempotency_unique IS MISSING. The endpoint is NOT safe to ship. ***')
      process.exitCode = 1
      return
    }
    console.log(`\nAPPLY_HELD_PAYMENTS_${targetName.toUpperCase()}_OK`)
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error('ABORTED:', e.message)
  process.exit(1)
})
