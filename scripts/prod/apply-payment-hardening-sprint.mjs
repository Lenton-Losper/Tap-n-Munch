/**
 * Apply the four payment-hardening migrations to PRODUCTION over a direct Postgres connection.
 * ONE-OFF. WRITES DDL.
 *
 * Modelled on scripts/prod/apply-migrations-direct-pg.mjs, which this keeps every safety property
 * of. CI has no DDL credentials at all, and `supabase db query` does not write the
 * `schema_migrations` row -- which makes the next deploy's drift gate fail after a perfectly
 * successful apply. So this connects directly and writes the DDL and the ledger row together.
 *
 * THE PASSWORD IS READ FROM THE FILE, NEVER FROM ARGV OR THE ENVIRONMENT, and never printed.
 *
 * IDENTITY IS VERIFIED FROM THE DATABASE, NOT FROM DNS. The ledger must NOT contain
 * 20260705210000 / 20260705220000: those two are applied on STAGING and deliberately absent from
 * production, so their absence distinguishes the two databases by state rather than by name.
 *
 * ORDER IS EXPLICIT AND IS NOT VERSION ORDER. docs/payment-hardening-remediation.md §3:
 *
 *     090000  the RPC + intent columns
 *     092000  only the LEAD order takes paycloud_merchant_order_no   <- fixes 090000
 *     093000  every transition checked BEFORE the first write        <- fixes 090000
 *     091000  the integrity constraints                              <- LAST, safe any time
 *
 * 090000 alone is NOT a shippable state: on its own it cannot settle a multi-order tab at all, and
 * it can leave an order paid by a settlement it refused. 092000 and 093000 are CREATE OR REPLACE of
 * the function 090000 creates, so they must follow it immediately. The array below is applied in
 * its own order and is never sorted.
 *
 * Each file runs in ITS OWN TRANSACTION together with its ledger row, so a failure leaves neither a
 * half-applied schema nor a ledger claiming something that did not land. Stops on first error.
 *
 * Usage (from the repo root):
 *   node scripts/prod/apply-payment-hardening-sprint.mjs            # dry run: connects, verifies, stops
 *   node scripts/prod/apply-payment-hardening-sprint.mjs --confirm  # applies
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire('file:///D:/dev/pgclient/')
const { Client } = require('pg')

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_ONLY = ['20260705210000', '20260705220000']
const ENV_FILE = 'D:/dev/flashtap/wt-harden/.env.local'
const CONFIRM = process.argv.includes('--confirm')

/** IN DEPLOY ORDER. Never sorted. See the header. */
const PLAN = [
  ['20260919090000', 'supabase/migrations/20260919090000_settle_order_payment_atomic.sql'],
  ['20260919092000', 'supabase/migrations/20260919092000_settle_lead_merchant_order_no.sql'],
  ['20260919093000', 'supabase/migrations/20260919093000_settle_validate_before_write.sql'],
  ['20260919091000', 'supabase/migrations/20260919091000_payment_integrity_constraints.sql'],
]

const HOSTS = [
  'aws-0-eu-west-1.pooler.supabase.com',
  'aws-1-eu-central-1.pooler.supabase.com',
  'aws-0-eu-central-1.pooler.supabase.com',
]

function secret(name) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(name + ' not found in ' + ENV_FILE)
}

async function main() {
  console.log('='.repeat(78))
  console.log('APPLY THE PAYMENT-HARDENING SPRINT TO PRODUCTION — direct Postgres')
  console.log('='.repeat(78))
  console.log('  project ref : ' + PROD_REF)
  console.log('  order       : ' + PLAN.map((p) => p[0]).join(' -> '))
  console.log('  mode        : ' + (CONFIRM ? 'APPLY' : 'DRY RUN — verifies, then stops'))
  console.log('')

  // An untracked .sql must never reach production.
  for (const [version, file] of PLAN) {
    execFileSync('git', ['ls-files', '--error-unmatch', file], { stdio: 'pipe' })
    console.log('  tracked in git: ' + version)
  }

  const password = secret('SUPABASE_DB_PASSWORD_PROD')
  if (!password) throw new Error('SUPABASE_DB_PASSWORD_PROD is empty')

  let client = null
  for (const host of HOSTS) {
    const trial = new Client({
      host,
      port: 5432,
      user: 'postgres.' + PROD_REF,
      password,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    })
    try {
      await trial.connect()
      client = trial
      console.log('\n  CONNECTED via ' + host + ':5432')
      break
    } catch (e) {
      console.log('  ' + host.padEnd(40) + ' ' + String(e.message).slice(0, 60))
      try {
        await trial.end()
      } catch {}
    }
  }
  if (!client) throw new Error('could not connect to production over any candidate host')

  try {
    // ---- identity, from state ---------------------------------------------------------------
    const { rows: so } = await client.query(
      'SELECT version FROM supabase_migrations.schema_migrations WHERE version = ANY($1)',
      [STAGING_ONLY],
    )
    if (so.length > 0) {
      throw new Error(
        'REFUSING: the connected database carries the staging-only markers ' +
          so.map((r) => r.version).join(', ') +
          ' — this is STAGING, not production.',
      )
    }
    console.log('  identity OK: staging-only markers absent (this is production)')

    // ---- none already applied ---------------------------------------------------------------
    const versions = PLAN.map((p) => p[0])
    const { rows: already } = await client.query(
      'SELECT version FROM supabase_migrations.schema_migrations WHERE version = ANY($1)',
      [versions],
    )
    if (already.length > 0) {
      throw new Error(
        'REFUSING: already in the ledger: ' +
          already.map((r) => r.version).join(', ') +
          ' — a verified-present object gets a ledger repair, never a re-run.',
      )
    }
    console.log('  none of the four is already applied')

    if (!CONFIRM) {
      console.log('\nDRY RUN complete. Re-run with --confirm to apply.')
      return
    }

    // ---- apply, in PLAN order, each with its ledger row in one transaction --------------------
    for (const [version, file] of PLAN) {
      const sql = readFileSync(file, 'utf8')
      process.stdout.write('\n  applying ' + version + ' (' + sql.length + ' B) ... ')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO supabase_migrations.schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [version],
        )
        await client.query('COMMIT')
        console.log('OK (schema + ledger committed together)')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        console.log('FAILED — rolled back')
        throw e
      }
    }

    const { rows: after } = await client.query(
      'SELECT version FROM supabase_migrations.schema_migrations WHERE version = ANY($1) ORDER BY version',
      [versions],
    )
    console.log(
      '\n  ledger now carries ' + after.length + ' of ' + versions.length + ': ' + after.map((r) => r.version).join(' '),
    )
    console.log('\nAPPLY_PAYMENT_HARDENING_OK')
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('\nERROR: ' + e.message)
  process.exit(1)
})
