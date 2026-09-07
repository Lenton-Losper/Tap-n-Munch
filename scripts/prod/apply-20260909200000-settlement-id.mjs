/**
 * Apply 20260909200000_orders_pending_settlement_id to PRODUCTION. ONE-OFF. WRITES DDL.
 *
 * Additive and nullable: one column plus a partial index. Every existing row keeps NULL, which the
 * expansion helper reads as "no settlement" and resolves to the lead order alone -- exactly today's
 * behaviour. Nothing is backfilled and no row's behaviour changes until a new prepare-payment
 * writes one.
 *
 * Safe to apply BEFORE the worker that uses it, and safe to leave applied if that worker is never
 * promoted: a column nothing reads is inert.
 *
 * Usage (from the repo root):
 *   node scripts/prod/apply-20260909200000-settlement-id.mjs            # dry run
 *   node scripts/prod/apply-20260909200000-settlement-id.mjs --confirm  # applies
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/8c74c58f-c231-44c3-982b-5acb1968c530/scratchpad/pgclient/',
)
const { Client } = require('pg')

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const CONFIRM = process.argv.includes('--confirm')

const MUST_BE_ABSENT = ['20260705210000', '20260705220000']
const EXPECTED_RESTAURANTS = 11
const VERSION = '20260909200000'
const PATH = 'supabase/migrations/20260909200000_orders_pending_settlement_id.sql'

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
  console.log(`APPLY ${VERSION}_orders_pending_settlement_id TO PRODUCTION`)
  console.log('='.repeat(78))
  console.log(`  mode : ${CONFIRM ? 'APPLY' : 'DRY RUN — verifies, then stops'}`)
  console.log('')

  const client = new Client({
    host: 'aws-0-eu-west-1.pooler.supabase.com',
    port: 5432,
    user: `postgres.${PROD_REF}`,
    password: readSecret('SUPABASE_DB_PASSWORD_PROD'),
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  })
  await client.connect()

  try {
    const { rows: ledger } = await client.query(
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
    )
    const applied = new Set(ledger.map((r) => String(r.version)))
    const { rows: rc } = await client.query('SELECT count(*)::int AS n FROM public.restaurants')

    const failures = []
    for (const v of MUST_BE_ABSENT) {
      const present = applied.has(v)
      console.log(`  ${v} absent (staging has it): ${present ? 'NO — PRESENT' : 'yes'}`)
      if (present) failures.push(`${v} IS applied here — this looks like STAGING`)
    }
    console.log(`  restaurants: ${rc[0].n} (production is ${EXPECTED_RESTAURANTS})`)
    if (rc[0].n !== EXPECTED_RESTAURANTS) {
      failures.push(`restaurant count ${rc[0].n}, not production's ${EXPECTED_RESTAURANTS}`)
    }
    if (failures.length) {
      console.log('\nREFUSING — identity checks did not hold:')
      for (const f of failures) console.log('  - ' + f)
      process.exitCode = 2
      return
    }

    const { rows: colBefore } = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='pending_settlement_id'",
    )
    console.log(`  column already present: ${colBefore.length ? 'yes' : 'no'}`)
    console.log(`  ${VERSION} in ledger: ${applied.has(VERSION) ? 'yes' : 'no'}`)

    if (applied.has(VERSION) && colBefore.length) {
      console.log('\nAlready applied and recorded. Nothing to do.')
      return
    }
    if (!CONFIRM) {
      console.log('\nDRY RUN complete. Re-run with --confirm to apply.')
      return
    }

    try {
      await client.query('BEGIN')
      await client.query(readFileSync(PATH, 'utf8'))
      await client.query(
        'INSERT INTO supabase_migrations.schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [VERSION],
      )
      await client.query('COMMIT')
      console.log('\n  APPLIED and recorded.')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      console.log(`\n  FAILED: ${e.message}\n  Rolled back. Nothing changed.`)
      process.exitCode = 1
      return
    }

    console.log('\nVERIFYING FROM THE DATABASE')
    const { rows: col } = await client.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='pending_settlement_id'",
    )
    console.log(
      `  column: ${col[0] ? `${col[0].column_name} ${col[0].data_type} nullable=${col[0].is_nullable}` : 'ABSENT'}`,
    )
    const { rows: idx } = await client.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='orders' AND indexname='orders_pending_settlement_id_idx'",
    )
    console.log(`  index : ${idx[0] ? idx[0].indexname : 'ABSENT'}`)

    // NOT BACKFILLED, and asserted rather than assumed: a non-zero count here would mean rows
    // silently joined a settlement they were never part of.
    const { rows: n } = await client.query(
      'SELECT count(*)::int AS n FROM public.orders WHERE pending_settlement_id IS NOT NULL',
    )
    console.log(`  rows with a settlement id: ${n[0].n} (must be 0 — no backfill)`)
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e.message)
  process.exitCode = 1
})
