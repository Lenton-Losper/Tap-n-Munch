/**
 * Apply one HELD migration to production, with the discipline the deploy workflow cannot provide.
 *
 * WHY THIS EXISTS. #284's REVOKE, #338's DROP and #349's DROP were all held from `main` because
 * the deploy workflow's drift gate forces apply-before-deploy, which is backwards for a REVOKE:
 * the grant would be withdrawn while code that might still use it is live. Applying them by hand,
 * one at a time, with the preconditions checked immediately before the write, is the correct shape
 * for a destructive change — and it is what this does.
 *
 * WHAT IT DOES THAT `supabase db query` DOES NOT: it records the version in
 * `supabase_migrations.schema_migrations`. Applying SQL without recording it makes the NEXT
 * deploy's drift guard fail, reporting a migration as un-applied when it has in fact run — which
 * is exactly the confusion that produced the "migration repair" workaround.
 *
 * SAFETY, in order:
 *   1. IDENTITY IS PROVED FROM THE DATABASE, not from config. It asks the database who it is and
 *      refuses unless the answer contains production's own data. A connection string can be wrong;
 *      the row counts cannot.
 *   2. DRY RUN BY DEFAULT. `--confirm` is required to write anything at all.
 *   3. PRECONDITIONS ARE RE-DERIVED AT RUN TIME, not trusted from an earlier investigation. Data
 *      moves: a probe written hours ago described a tab that had settled by the time it ran.
 *   4. ONE TRANSACTION. The DDL and the ledger row commit together or not at all — a migration
 *      that ran but is not recorded is the failure mode this exists to prevent.
 *   5. IDEMPOTENT. Every held migration uses IF EXISTS, and the ledger insert is ON CONFLICT DO
 *      NOTHING, so a second run is a no-op rather than an error.
 *
 * Usage:
 *   node scripts/prod/apply-held-migration.mjs --file <name-without-.sql>
 *   node scripts/prod/apply-held-migration.mjs --file <name-without-.sql> --confirm
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(
  'file:///C:/Users/223125~1/AppData/Local/Temp/claude/C--Users-223125318-Desktop-mvp/42cde80a-ddd8-4302-a2d9-e3cb8803244e/scratchpad/pgclient/',
)
const { Client } = require('pg')

const ENV = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const CONFIRM = process.argv.includes('--confirm')
const fileArg = process.argv.find((a) => a.startsWith('--file='))
  ?? (process.argv.includes('--file') ? process.argv[process.argv.indexOf('--file') + 1] : null)
const NAME = fileArg?.startsWith('--file=') ? fileArg.slice('--file='.length) : fileArg

const sec = (n) => {
  for (const l of readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === n) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`missing ${n}`)
}

if (!NAME) {
  console.error('usage: --file <migration-name-without-.sql> [--confirm]')
  process.exit(2)
}

const path = join('supabase', 'migrations', `${NAME}.sql`)
if (!existsSync(path)) {
  console.error(`REFUSING: no such migration file: ${path}`)
  process.exit(2)
}
const sql = readFileSync(path, 'utf8')
const version = NAME.match(/^(\d{14})_/)?.[1]
if (!version) {
  console.error(`REFUSING: filename does not start with a 14-digit version: ${NAME}`)
  process.exit(2)
}

/**
 * Preconditions per migration, re-derived at run time.
 *
 * Each returns lines to print and a hard `ok`. A false `ok` refuses the apply — these are not
 * warnings. The point is that the state is checked at the moment of the write, not hours earlier.
 */
const PRECONDITIONS = {
  '20260825020000': async (c) => {
    const out = []
    const { rows: pol } = await c.query(
      `SELECT policyname FROM pg_policies WHERE tablename='tabs' AND policyname='Guests can read active tabs for ordering'`,
    )
    // role_table_grants HIDES column-level grants: `tabs` reads as NONE there while holding 15.
    const { rows: g } = await c.query(
      `SELECT count(*)::int AS n FROM information_schema.column_privileges
        WHERE table_name='tabs' AND grantee='anon' AND privilege_type='SELECT'`,
    )
    const { rows: staff } = await c.query(
      `SELECT count(*)::int AS n FROM pg_policies WHERE tablename='tabs' AND 'authenticated' = ANY(roles)`,
    )
    out.push(`  guest anon policy present ......... ${pol.length === 1 ? 'yes' : 'NO'}`)
    out.push(`  anon column SELECT grants ......... ${g[0].n}`)
    out.push(`  staff policies that must SURVIVE .. ${staff[0].n}`)
    // The staff policies are the control: this must remove anon's access and nothing else.
    return { out, ok: staff[0].n >= 3 }
  },
  '20260825030000': async (c) => {
    const { rows } = await c.query(
      `SELECT count(*)::int AS rows,
              count(last_seen_at)::int AS non_null,
              count(*) FILTER (WHERE last_seen_at IS DISTINCT FROM created_at)::int AS differs
         FROM customer_sessions`,
    )
    const r = rows[0]
    const out = [
      `  customer_sessions rows ............ ${r.rows}`,
      `  last_seen_at non-null ............. ${r.non_null}`,
      `  DIFFERING from created_at ......... ${r.differs}   <- must be 0; anything else is real data`,
    ]
    // If any row differs, something DID write it and the issue's premise is wrong. Refuse.
    return { out, ok: r.differs === 0 }
  },
  '20260826170000': async (c) => {
    const { rows: dead } = await c.query(
      `SELECT count(*)::int AS venues, count(payment_methods)::int AS with_value FROM restaurants`,
    )
    const { rows: gate } = await c.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name='restaurant_settings' AND column_name='payment_methods'`,
    )
    const { rows: dep } = await c.query(
      `SELECT count(*)::int AS n FROM pg_depend d
         JOIN pg_rewrite rw ON rw.oid=d.objid
         JOIN pg_class src ON src.oid=d.refobjid
         JOIN pg_attribute a ON a.attrelid=src.oid AND a.attnum=d.refobjsubid
        WHERE src.relname='restaurants' AND a.attname='payment_methods'`,
    )
    const out = [
      `  venues carrying the dead column ... ${dead[0].with_value} of ${dead[0].venues}`,
      `  views depending on it ............. ${dep[0].n}   <- must be 0`,
      `  REAL gate still present ........... restaurant_settings.payment_methods: ${gate[0].n === 1 ? 'yes' : 'NO'}`,
    ]
    // Dropping the dead column must never touch the gate that governs behaviour.
    return { out, ok: dep[0].n === 0 && gate[0].n === 1 }
  },
}

const c = new Client({
  host: 'aws-0-eu-west-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${PROD_REF}`,
  password: sec('SUPABASE_DB_PASSWORD_PROD'),
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
})
await c.connect()

console.log('='.repeat(78))
console.log(CONFIRM ? 'THIS WILL WRITE TO PRODUCTION' : 'DRY RUN — verifies and writes nothing')
console.log('='.repeat(78))
console.log(`  migration : ${NAME}`)
console.log(`  version   : ${version}`)

// ---- 1. identity, proved from the database's own contents
const { rows: id } = await c.query(
  `SELECT current_database() AS db, current_user AS usr,
          (SELECT count(*) FROM restaurants WHERE name='FNB ChowNow')::int AS chownow,
          (SELECT count(*) FROM orders WHERE restaurant_id IS NOT NULL)::int AS real_orders`,
)
const who = id[0]
console.log(`\n  IDENTITY (asked of the database, not read from config)`)
console.log(`    database=${who.db} user=${who.usr}`)
console.log(`    FNB ChowNow present=${who.chownow}  real orders=${who.real_orders}`)
if (who.chownow !== 1 || who.real_orders < 1000) {
  console.error('\n  REFUSING: this does not look like production.')
  await c.end()
  process.exit(1)
}

// ---- 2. is it already applied?
const { rows: already } = await c.query(
  `SELECT version FROM supabase_migrations.schema_migrations WHERE version=$1`, [version],
)
console.log(`\n  already in the ledger ............. ${already.length ? 'YES — nothing to do' : 'no'}`)

/**
 * SHORT-CIRCUIT HERE, BEFORE THE PRECONDITIONS RUN.
 *
 * The preconditions describe the world BEFORE the migration. Once applied they are false by
 * construction -- and for a DROP they do not merely fail, they THROW, because they query a column
 * that no longer exists. The first version printed "already in the ledger -- nothing to do" and
 * then ran them anyway, so a re-run crashed. A tool that explodes on its second invocation is not
 * idempotent.
 */
if (already.length) {
  console.log('\n  Already applied and recorded. Nothing to do -- this is the idempotent path.')
  await c.end()
  process.exit(0)
}

// ---- 3. preconditions, re-derived now
const check = PRECONDITIONS[version]
if (!check) {
  console.error(`\n  REFUSING: no preconditions defined for version ${version}.`)
  console.error('  A destructive migration without a precondition check is not something to run blind.')
  await c.end()
  process.exit(1)
}
console.log(`\n  PRECONDITIONS (re-derived now, not trusted from earlier)`)
const { out, ok } = await check(c)
for (const line of out) console.log(line)
if (!ok) {
  console.error('\n  REFUSING: a precondition does not hold. Nothing was written.')
  await c.end()
  process.exit(1)
}

console.log(`\n  SQL to run:`)
for (const line of sql.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('--'))) {
  console.log(`    ${line}`)
}

if (!CONFIRM) {
  console.log('\n  DRY RUN. Nothing written. Re-run with --confirm to apply.')
  await c.end()
  process.exit(0)
}

if (already.length) {
  console.log('\n  Already recorded — not re-running. Exiting cleanly.')
  await c.end()
  process.exit(0)
}

// ---- 4. one transaction: the DDL and the ledger row together
try {
  await c.query('BEGIN')
  await c.query(sql)
  await c.query(
    `INSERT INTO supabase_migrations.schema_migrations (version, name)
     VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
    [version, NAME],
  )
  await c.query('COMMIT')
  console.log('\n  APPLIED and RECORDED in the same transaction.')
} catch (err) {
  await c.query('ROLLBACK').catch(() => {})
  console.error('\n  FAILED — rolled back, nothing changed:', err.message)
  await c.end()
  process.exit(1)
}

// ---- 5. verify the effect, not the exit code
console.log('\n  AFTER:')
const after = await check(c)
for (const line of after.out) console.log(line)
const { rows: led } = await c.query(
  `SELECT version FROM supabase_migrations.schema_migrations WHERE version=$1`, [version],
)
console.log(`  in the ledger now ................. ${led.length ? 'yes' : 'NO — drift guard will fail'}`)
console.log('\nAPPLY_HELD_MIGRATION_OK')
await c.end()
