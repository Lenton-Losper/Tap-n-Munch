/**
 * Apply supabase/migrations/20260908090000_terminal_payment_intents.sql to PRODUCTION over a
 * direct Postgres connection. ONE-OFF. WRITES DDL.
 *
 * Same shape as apply-migrations-direct-pg.mjs, and the same reasons: CI has no DDL credentials
 * (SUPABASE_ACCESS_TOKEN, SUPABASE_DB_PASSWORD, DATABASE_URL and SUPABASE_DB_URL are all empty in
 * Actions), and the CLI path needs an account token that is not configured here.
 *
 * THE PASSWORD IS READ FROM THE FILE, NEVER FROM ARGV OR THE ENVIRONMENT, and never printed.
 *
 * IDENTITY IS VERIFIED FROM THE DATABASE, NOT FROM DNS. Local DNS answers every hostname with the
 * router address, so a name lookup proves nothing. Three assertions against the connected server:
 *
 *   - 20260705210000 and 20260705220000 are ABSENT. Both ARE applied on staging and deliberately
 *     are not here, so their absence separates the two databases by state rather than by name.
 *   - the restaurant count is 11, production's known figure. Staging's differs.
 *   - the target version is not already in the ledger.
 *
 * Any of those failing is a refusal, not a warning.
 *
 * ONE VERSION, hard-coded. Never "everything pending".
 *
 * WHY IT IS SAFE TO APPLY BEFORE THE WORKER SHIPS: the file only CREATEs. It adds a table nothing
 * currently reads and touches no existing object, so production behaviour is identical the instant
 * before and the instant after. That ordering is also required -- the drift gate in the deploy
 * refuses to promote a worker whose migrations are not in the ledger.
 *
 * Usage (from the repo root):
 *   node scripts/prod/apply-20260908090000-payment-intents.mjs            # dry run
 *   node scripts/prod/apply-20260908090000-payment-intents.mjs --confirm  # applies
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/8c74c58f-c231-44c3-982b-5acb1968c530/scratchpad/pgclient/',
)
const { Client } = require('pg')

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const CONFIRM = process.argv.includes('--confirm')

/** Applied on staging, deliberately NOT on production. Their absence identifies the database. */
const MUST_BE_ABSENT = ['20260705210000', '20260705220000']
const EXPECTED_RESTAURANTS = 11

const VERSION = '20260908090000'
const PATH = 'supabase/migrations/20260908090000_terminal_payment_intents.sql'

function readSecret(name) {
  const text = readFileSync(ENV_FILE, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`${name} not found in ${ENV_FILE}`)
}

async function main() {
  console.log('='.repeat(78))
  console.log('APPLY 20260908090000_terminal_payment_intents TO PRODUCTION — direct Postgres')
  console.log('='.repeat(78))
  console.log(`  target project ref : ${PROD_REF}`)
  console.log(`  password source    : ${ENV_FILE} (SUPABASE_DB_PASSWORD_PROD, not printed)`)
  console.log(`  version            : ${VERSION}`)
  console.log(`  mode               : ${CONFIRM ? 'APPLY' : 'DRY RUN — verifies, then stops'}`)
  console.log('')

  const password = readSecret('SUPABASE_DB_PASSWORD_PROD')
  if (!password) throw new Error('SUPABASE_DB_PASSWORD_PROD is empty')

  // Session mode (5432), not transaction mode (6543): DDL and explicit transactions need a session.
  const candidates = [
    { label: 'pooler eu-west-1', host: 'aws-0-eu-west-1.pooler.supabase.com', port: 5432, user: `postgres.${PROD_REF}` },
    { label: 'direct', host: `db.${PROD_REF}.supabase.co`, port: 5432, user: 'postgres' },
    { label: 'pooler eu-central-1 (aws-1)', host: 'aws-1-eu-central-1.pooler.supabase.com', port: 5432, user: `postgres.${PROD_REF}` },
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

    const { rows: rc } = await client.query('SELECT count(*)::int AS n FROM public.restaurants')
    console.log(`  restaurants: ${rc[0].n} (production is ${EXPECTED_RESTAURANTS})`)
    if (rc[0].n !== EXPECTED_RESTAURANTS) {
      failures.push(`restaurant count is ${rc[0].n}, not production's ${EXPECTED_RESTAURANTS}`)
    }

    // Is the object already there, ledger or no ledger? A verified-present object gets a ledger
    // repair, never a re-run.
    const { rows: tbl } = await client.query(
      "SELECT to_regclass('public.terminal_payment_intents') IS NOT NULL AS present",
    )
    const tablePresent = tbl[0].present
    const inLedger = applied.has(VERSION)
    console.log(`  table present: ${tablePresent ? 'yes' : 'no'}`)
    console.log(`  ${VERSION} in ledger: ${inLedger ? 'yes' : 'no'}`)

    if (failures.length) {
      console.log('\n' + '='.repeat(78))
      console.log('REFUSING — identity checks did not hold:')
      for (const f of failures) console.log('  - ' + f)
      console.log('Nothing was changed.')
      process.exitCode = 2
      return
    }

    if (tablePresent && inLedger) {
      console.log('\nAlready applied and recorded. Nothing to do.')
      return
    }
    if (tablePresent && !inLedger) {
      console.log('\nTable exists but the ledger does not record it: this is a REPAIR, not a re-run.')
    }

    if (!CONFIRM) {
      console.log('\nDRY RUN complete. Re-run with --confirm to apply.')
      return
    }

    // ---------------------------------------------------------------- apply
    const sql = readFileSync(PATH, 'utf8')
    console.log('\n' + '='.repeat(78))
    console.log(`APPLYING ${PATH}`)
    console.log('='.repeat(78))

    try {
      await client.query('BEGIN')
      if (!tablePresent) {
        await client.query(sql)
      }
      // The ledger row goes in the SAME transaction, so a failure leaves neither a half-applied
      // schema nor a ledger claiming something that did not land.
      await client.query(
        'INSERT INTO supabase_migrations.schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [VERSION],
      )
      await client.query('COMMIT')
      console.log('  APPLIED and recorded.')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      console.log(`  FAILED: ${e.message}`)
      console.log('  Rolled back. Nothing changed.')
      process.exitCode = 1
      return
    }

    // ---------------------------------------------------------------- verify
    console.log('\n' + '='.repeat(78))
    console.log('VERIFYING FROM THE DATABASE')
    console.log('='.repeat(78))

    const { rows: cols } = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='terminal_payment_intents'
        ORDER BY ordinal_position`,
    )
    console.log(`  columns (${cols.length}): ${cols.map((c) => c.column_name).join(', ')}`)

    const { rows: idx } = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND tablename='terminal_payment_intents' ORDER BY indexname`,
    )
    console.log(`  indexes (${idx.length}): ${idx.map((i) => i.indexname).join(', ')}`)

    const { rows: rls } = await client.query(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'public.terminal_payment_intents'::regclass`,
    )
    console.log(`  RLS enabled: ${rls[0].relrowsecurity}`)

    const { rows: pol } = await client.query(
      `SELECT policyname FROM pg_policies
        WHERE schemaname='public' AND tablename='terminal_payment_intents'`,
    )
    console.log(`  policies: ${pol.map((p) => p.policyname).join(', ') || '(none)'}`)

    /**
     * A POSITIVE CONTROL FOR THE SCOPE CONSTRAINT. "The DDL ran" does not prove the CHECK bites --
     * a constraint that accepts everything looks identical from information_schema. This tries to
     * insert a row naming BOTH kinds of target, which the constraint must reject, and rolls back
     * either way so nothing is left behind.
     */
    await client.query('BEGIN')
    let constraintBites = false
    try {
      await client.query(
        `INSERT INTO public.terminal_payment_intents
           (restaurant_id, merchant_order_no, amount_cents, scope, order_ids, allocation_ids)
         SELECT id, 'PROBE-BOTH-TARGETS', 100, 'orders',
                ARRAY[gen_random_uuid()], ARRAY[gen_random_uuid()]
           FROM public.restaurants LIMIT 1`,
      )
    } catch (e) {
      constraintBites = /scope_targets/.test(e.message)
    }
    await client.query('ROLLBACK')
    console.log(`  scope constraint rejects a both-targets row: ${constraintBites ? 'YES' : 'NO — CHECK IT'}`)

    const { rows: n } = await client.query('SELECT count(*)::int AS n FROM public.terminal_payment_intents')
    console.log(`  rows: ${n[0].n} (nothing is backfilled, by instruction)`)
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e.message)
  process.exitCode = 1
})
