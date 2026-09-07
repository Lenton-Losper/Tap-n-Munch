/**
 * WHAT IS ACTUALLY IN THE PAYMENT-METHOD COLUMNS ON PRODUCTION. READ ONLY.
 *
 * Run before adding a CHECK to payments.method. A constraint added blind either fails to apply --
 * because a row already violates it -- or applies and makes some existing row un-updatable
 * forever. Neither is discoverable from the schema; both are discoverable from the data.
 *
 * FOUR COLUMNS, not one, because they disagree about who constrains them:
 *
 *   payments.method                            NO constraint. text, DEFAULT 'card'.
 *   orders.payment_method                      NO constraint. This is what every REPORT groups by.
 *   order_line_allocation_settlements.method   CHECK (method IN ('cash','card'))
 *   payment_tips.method                        CHECK (method IN ('cash','card'))
 *
 * The two constrained ones are audited anyway. A CHECK proves what can be written from now on; it
 * does not prove what was written before it existed, and neither of these was added at table
 * creation on a table that already had rows.
 *
 * Identity is verified from the database, three ways, exactly as the apply script does. Local DNS
 * answers every hostname with the router address, so a name lookup proves nothing.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/8c74c58f-c231-44c3-982b-5acb1968c530/scratchpad/pgclient/',
)
const { Client } = require('pg')

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const MUST_BE_ABSENT = ['20260705210000', '20260705220000']
const EXPECTED_RESTAURANTS = 11

function readSecret(name) {
  const text = readFileSync(ENV_FILE, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`${name} not found in ${ENV_FILE}`)
}

/**
 * `when` differs per table and is resolved from information_schema rather than assumed -- `orders`
 * has no created_at, and guessing produced a mid-audit failure that reported nothing for the three
 * tables after it. A partial audit that stops early is the same shape as an audit that finds
 * nothing: both end without having looked.
 */
const TARGETS = [
  { table: 'payments', column: 'method', constrained: false, when: ['created_at', 'paid_at'] },
  { table: 'orders', column: 'payment_method', constrained: false, when: ['placed_at', 'paid_at', 'created_at'] },
  { table: 'order_line_allocation_settlements', column: 'method', constrained: true, when: ['settled_at', 'created_at'] },
  { table: 'payment_tips', column: 'method', constrained: true, when: ['created_at', 'captured_at'] },
]

async function firstExistingColumn(client, table, candidates) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name = ANY($2)`,
    [table, candidates],
  )
  const found = new Set(rows.map((r) => r.column_name))
  return candidates.find((c) => found.has(c)) ?? null
}

const ALLOWED = new Set(['cash', 'card'])

/** Dates print as YYYY-MM-DD; the driver hands back a Date and its default toString is unreadable. */
const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '?')

async function main() {
  console.log('='.repeat(78))
  console.log('PAYMENT-METHOD VALUE AUDIT — PRODUCTION, READ ONLY')
  console.log('='.repeat(78))

  const password = readSecret('SUPABASE_DB_PASSWORD_PROD')
  const client = new Client({
    host: 'aws-0-eu-west-1.pooler.supabase.com',
    port: 5432,
    user: `postgres.${PROD_REF}`,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  })
  await client.connect()

  try {
    // ------------------------------------------------------------- identity
    const { rows: ledger } = await client.query(
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
    )
    const applied = new Set(ledger.map((r) => String(r.version)))
    const { rows: rc } = await client.query('SELECT count(*)::int AS n FROM public.restaurants')

    const failures = []
    for (const v of MUST_BE_ABSENT) {
      if (applied.has(v)) failures.push(`${v} IS applied — this looks like STAGING`)
    }
    if (rc[0].n !== EXPECTED_RESTAURANTS) {
      failures.push(`restaurant count ${rc[0].n}, not production's ${EXPECTED_RESTAURANTS}`)
    }
    console.log(`  ledger rows: ${applied.size}   restaurants: ${rc[0].n}   staging markers absent: ${
      MUST_BE_ABSENT.every((v) => !applied.has(v)) ? 'yes' : 'NO'
    }`)
    if (failures.length) {
      console.log('\nREFUSING — identity checks did not hold:')
      for (const f of failures) console.log('  - ' + f)
      process.exitCode = 2
      return
    }
    console.log('')

    // ------------------------------------------------------------- values
    let anyOffender = false
    for (const t of TARGETS) {
      const { rows: exists } = await client.query(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`public.${t.table}`],
      )
      console.log('-'.repeat(78))
      console.log(`${t.table}.${t.column}   ${t.constrained ? '[CHECK cash|card]' : '[NO CONSTRAINT]'}`)
      if (!exists[0].present) {
        console.log('  table does not exist here')
        continue
      }

      const when = await firstExistingColumn(client, t.table, t.when)
      const dateSelect = when
        ? `min(${when})::date AS first_seen, max(${when})::date AS last_seen`
        : `NULL::date AS first_seen, NULL::date AS last_seen`
      const { rows } = await client.query(
        `SELECT
           COALESCE(${t.column}, '<NULL>') AS value,
           count(*)::int AS n,
           ${dateSelect}
         FROM public.${t.table}
         GROUP BY 1
         ORDER BY n DESC`,
      )
      if (!when) console.log('  (no timestamp column found; dates omitted)')
      if (rows.length === 0) {
        console.log('  (no rows)')
        continue
      }
      for (const r of rows) {
        const raw = String(r.value)
        /**
         * AN OFFENDER IS ONLY WHAT A CHECK WOULD ACTUALLY REJECT, AND NULL IS NOT ONE.
         *
         * A CHECK passes unless it evaluates to FALSE, and `method IN ('cash','card')` evaluates
         * to NULL -- unknown -- for a null row. So nulls are ALLOWED by such a constraint.
         *
         * This flagged them as "WOULD BE REJECTED" on its first run, which is exactly the kind of
         * confidently-wrong instrument reading that turns a clean audit into a fictional blocker.
         * Nulls are still reported, separately and by name, because they matter for a different
         * reason -- whether the column should be NOT NULL -- just not for this one.
         */
        const isNull = raw === '<NULL>'
        const offender = !isNull && !ALLOWED.has(raw)
        if (offender) anyOffender = true
        const flag = offender
          ? '  <-- WOULD BE REJECTED by CHECK (method IN (...))'
          : isNull
            ? '  <-- null: ALLOWED by a plain CHECK; see the NOT NULL note below'
            : ''
        console.log(
          `  ${JSON.stringify(raw).padEnd(18)} ${String(r.n).padStart(7)} rows   ${fmt(r.first_seen)} .. ${fmt(r.last_seen)}${flag}`,
        )
      }
    }

    console.log('')
    console.log('='.repeat(78))
    console.log(
      anyOffender
        ? '  OFFENDING VALUES EXIST. A CHECK cannot be added without deciding what happens to them.'
        : '  No value would be rejected. A CHECK (method IN (...)) would apply cleanly.',
    )

    // A NULL in payments.method deserves its own line: the column is nullable with a DEFAULT, so a
    // CHECK written without an explicit NULL policy silently ALLOWS null (a CHECK is satisfied by
    // unknown). Saying so here stops that being discovered later.
    const { rows: nulls } = await client.query(
      `SELECT count(*)::int AS n FROM public.payments WHERE method IS NULL`,
    )
    console.log(`  payments.method IS NULL: ${nulls[0].n} rows`)
    console.log(
      '  NOTE: CHECK (method IN (...)) is satisfied by NULL. Constraining nulls needs it spelled out.',
    )
  } finally {
    await client.end().catch(() => {})
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e.message)
  process.exitCode = 1
})
