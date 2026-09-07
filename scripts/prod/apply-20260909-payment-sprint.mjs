/**
 * Apply the three remaining 2026-09-09 payment-sprint migrations to PRODUCTION. ONE-OFF. WRITES DDL.
 *
 * ================================================================================================
 * ORDER IS A SAFETY REQUIREMENT, NOT A PREFERENCE
 * ================================================================================================
 *
 * THESE MUST LAND BEFORE THE WORKER IS PROMOTED.
 *
 * The pending commit widens SETTLEMENT_PAYMENT_METHODS to accept 'paytoday'. On the settle route
 * the orders are claimed paid FIRST (payment_status: 'paid'), the `payments` insert happens after,
 * and its failure is only console.error'd -- never thrown, by explicit design, because by then the
 * money has moved.
 *
 * So a worker deployed ahead of these migrations would: accept a PayToday settlement, mark the
 * orders paid, settle the tab, issue receipts -- and then violate the CHECK on payments.method and
 * swallow it. Orders paid, no money row, nothing raised. Fail-OPEN on the money path, reachable by
 * ordering alone.
 *
 * Applying first is safe in the other direction: every one of these is additive or widening, so
 * production behaves identically until the worker that uses them ships.
 *
 * ================================================================================================
 * WHAT EACH ONE DOES
 * ================================================================================================
 *
 *   20260909140000  terminal_payment_intents gains tip_cents / tip_staff_user_id, so a split
 *                   charge's single amount can be split back into items and gratuity at settlement
 *                   -- including by the webhook, which is the only path when the device never
 *                   reports back.
 *
 *   20260909160000  restaurant_settings.payment_methods and payments.method accept 'paytoday'.
 *                   Deliberately does NOT touch order_line_allocation_settlements or payment_tips:
 *                   v1 is whole-order only with no PayToday gratuity, and those constraints failing
 *                   loudly IS the enforcement.
 *
 *   20260909180000  orders gains pending_charge_cents / pending_tip_cents / pending_tip_staff_user_id
 *                   -- what the reader was asked for on a whole-order charge, so the amount sent to
 *                   the gateway is the amount verification compares against.
 *
 * Each runs in ITS OWN TRANSACTION with its ledger row, so a failure leaves neither a half-applied
 * schema nor a ledger claiming something that did not land. Stops on first error.
 *
 * Usage (from the repo root):
 *   node scripts/prod/apply-20260909-payment-sprint.mjs            # dry run
 *   node scripts/prod/apply-20260909-payment-sprint.mjs --confirm  # applies
 */
import { readFileSync, readdirSync } from 'node:fs'
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

/** ASCENDING, and applied in this order. */
const VERSIONS = ['20260909140000', '20260909160000', '20260909180000']

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
  console.log('='.repeat(78))
  console.log('APPLY 3 PAYMENT-SPRINT MIGRATIONS TO PRODUCTION — direct Postgres')
  console.log('='.repeat(78))
  console.log(`  versions : ${VERSIONS.join(' -> ')}`)
  console.log(`  mode     : ${CONFIRM ? 'APPLY' : 'DRY RUN — verifies, then stops'}`)
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
    // ---------------------------------------------------------------- identity
    const { rows: ledger } = await client.query(
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
    )
    const applied = new Set(ledger.map((r) => String(r.version)))
    const { rows: rc } = await client.query('SELECT count(*)::int AS n FROM public.restaurants')

    const failures = []
    for (const v of MUST_BE_ABSENT) {
      const present = applied.has(v)
      console.log(`  ${v} absent (staging has it): ${present ? 'NO — PRESENT' : 'yes'}`)
      if (present) failures.push(`${v} IS applied here — this looks like STAGING (${STAGING_REF})`)
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

    console.log('')
    for (const v of VERSIONS) {
      console.log(`  ${v} in ledger: ${applied.has(v) ? 'yes (will skip)' : 'no'}`)
    }

    const todo = VERSIONS.filter((v) => !applied.has(v))
    console.log(`\n  to apply: ${todo.length ? todo.join(' ') : 'nothing'}`)

    if (!CONFIRM) {
      console.log('\nDRY RUN complete. Re-run with --confirm to apply.')
      return
    }
    if (!todo.length) {
      console.log('\nNothing to do.')
      return
    }

    // ---------------------------------------------------------------- apply, in order
    for (const version of todo) {
      const path = migrationPath(version)
      console.log('\n' + '='.repeat(78))
      console.log(`APPLYING ${path}`)
      console.log('='.repeat(78))
      try {
        await client.query('BEGIN')
        await client.query(readFileSync(path, 'utf8'))
        await client.query(
          'INSERT INTO supabase_migrations.schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
          [version],
        )
        await client.query('COMMIT')
        console.log('  APPLIED and recorded.')
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        console.log(`  FAILED: ${e.message}`)
        console.log('  Rolled back. Later migrations NOT attempted.')
        process.exitCode = 1
        return
      }
    }

    // ---------------------------------------------------------------- verify from the database
    console.log('\n' + '='.repeat(78))
    console.log('VERIFYING FROM THE DATABASE')
    console.log('='.repeat(78))

    const cols = async (table, names) => {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name = ANY($2)`,
        [table, names],
      )
      const found = rows.map((r) => r.column_name).sort()
      console.log(`  ${table}: ${found.join(', ') || '(NONE)'}`)
      return found.length === names.length
    }

    const a = await cols('terminal_payment_intents', ['tip_cents', 'tip_staff_user_id'])
    const b = await cols('orders', [
      'pending_charge_cents',
      'pending_tip_cents',
      'pending_tip_staff_user_id',
    ])

    const { rows: pm } = await client.query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
        WHERE conname='payment_methods_valid_values'
          AND conrelid='public.restaurant_settings'::regclass`,
    )
    const settingsOk = String(pm[0]?.d ?? '').includes('paytoday')
    console.log(`  restaurant_settings accepts paytoday: ${settingsOk ? 'yes' : 'NO'}`)

    const { rows: pmeth } = await client.query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
        WHERE conname='payments_method_valid_values' AND conrelid='public.payments'::regclass`,
    )
    const paymentsOk = String(pmeth[0]?.d ?? '').includes('paytoday')
    console.log(`  payments.method accepts paytoday:     ${paymentsOk ? 'yes' : 'NO'}`)

    /**
     * v1 SCOPE, VERIFIED RATHER THAN ASSUMED. These two must still refuse paytoday -- they are what
     * stops a split PayToday settlement or a PayToday gratuity being recorded before the product
     * supports either.
     */
    for (const [table, conname] of [
      ['order_line_allocation_settlements', null],
      ['payment_tips', null],
    ]) {
      const { rows } = await client.query(
        `SELECT pg_get_constraintdef(oid) d FROM pg_constraint
          WHERE conrelid=$1::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%method%'`,
        [`public.${table}`],
      )
      void conname
      const defs = rows.map((r) => r.d).join(' | ')
      const stillNarrow = defs.includes("'cash'") && !defs.includes('paytoday')
      console.log(`  ${table} still refuses paytoday: ${stillNarrow ? 'yes' : 'NO — CHECK THIS'}`)
    }

    /**
     * A POSITIVE CONTROL that the new CHECK actually bites, rolled back. "The DDL ran" cannot tell a
     * working constraint from one that accepts everything.
     */
    await client.query('BEGIN')
    let rejects = false
    try {
      await client.query(
        `INSERT INTO public.payments (restaurant_id, amount, method, status)
         SELECT id, 1, 'not_a_method', 'completed' FROM public.restaurants LIMIT 1`,
      )
    } catch (e) {
      rejects = /payments_method_valid_values/.test(e.message)
    }
    await client.query('ROLLBACK')
    console.log(`  payments.method still rejects an unknown method: ${rejects ? 'yes' : 'NO'}`)

    console.log('')
    console.log(a && b && settingsOk && paymentsOk && rejects ? '  ALL VERIFIED' : '  SOMETHING IS OFF — read the lines above')
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e.message)
  process.exitCode = 1
})
