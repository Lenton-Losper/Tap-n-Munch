#!/usr/bin/env node
/**
 * PRODUCTION: the 2026-09-28/29 sprint migrations — direct Postgres, owner-approved 2026-09-29.
 *
 *   node scripts/prod/apply-sprint-2026-09-29.mjs --check                        read-only report
 *   node scripts/prod/apply-sprint-2026-09-29.mjs --only=20260929150000 --confirm  one version
 *   node scripts/prod/apply-sprint-2026-09-29.mjs --confirm                        every pending PLAN entry
 *
 * Identity from the DATABASE: the staging-only ledger versions 20260705210000/220000 must be ABSENT
 * and current_database()'s pooler user must name the production ref. One transaction per file with
 * its supabase_migrations row. Applies the COMMITTED bytes (git show HEAD:) and refuses if the working
 * copy differs or git does not track the file. Refuses a plan that would leave 20260913100100
 * without 20260928140100. The password is read from the file, never argv/env, never printed.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire('file:///D:/dev/pgclient/')
const { Client } = require('pg')

const PROD_REF = 'ihlmmpmolnpchzgwyhgh'
const ENV_FILE = 'C:/Users/223125318/Desktop/mvp/restaurant-menu-screen/.env.local'
const REPO = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const CHECK = process.argv.includes('--check')
const CONFIRM = process.argv.includes('--confirm')
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7) || null
const MUST_BE_ABSENT = ['20260705210000', '20260705220000']

/** Exact dependency order. 150000 is a pure REVOKE and is safe first, on its own. */
const PLAN = [
  '20260913100000_business_documents_order_id.sql',
  '20260913100100_correct_invoice_carries_order_id.sql',
  '20260928135000_orders_settled_charge_cents.sql',
  '20260928140000_business_documents_tab_invoice.sql',
  '20260928140100_correct_invoice_carries_tab_scope.sql',
  '20260928150000_amend_order_lines_refuse_paid.sql',
  '20260928160000_settle_refuses_order_paid_elsewhere.sql',
  '20260929100000_non_gateway_payment_events.sql',
  '20260929110000_payment_events_origin.sql',
  '20260929120000_order_charge_basis.sql',
  '20260929120100_settle_holds_order_changed_since_charge.sql',
  '20260929120200_amend_refuses_payment_in_flight.sql',
  '20260929120300_allocation_settle_locks_orders.sql',
  '20260929120400_order_items_have_lines.sql',
  '20260929130000_settle_promotes_device_sale_row.sql',
  '20260929130100_refund_cap_is_verified_amount.sql',
  '20260929140000_manual_payment_releases_stale_card_attempt.sql',
  '20260929150000_revoke_anon_authenticated_line_rpcs.sql',
]

function secret(name) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, '')
  }
  throw new Error(`${name} not found`)
}
function committed(rel) {
  execFileSync('git', ['-C', REPO, 'ls-files', '--error-unmatch', rel], { stdio: 'pipe' })
  const sql = execFileSync('git', ['-C', REPO, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
  if (readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n') !== sql.replace(/\r\n/g, '\n')) {
    throw new Error(`REFUSING: ${rel} on disk differs from HEAD`)
  }
  return sql
}

const client = new Client({
  host: 'aws-0-eu-west-1.pooler.supabase.com', port: 5432, user: `postgres.${PROD_REF}`,
  password: secret('SUPABASE_DB_PASSWORD_PROD'), database: 'postgres',
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000,
})
await client.connect()
try {
  const ledger = new Set((await client.query('select version from supabase_migrations.schema_migrations')).rows.map((r) => String(r.version)))
  for (const v of MUST_BE_ABSENT) if (ledger.has(v)) throw new Error(`REFUSING: ${v} present — this is not production`)
  console.log(`PRODUCTION identified (ledger ${ledger.size} rows; staging-only versions absent)`)

  // Read-only facts the rollout depends on.
  const fns = await client.query(`select p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') auth, has_function_privilege('service_role', p.oid, 'EXECUTE') svc,
      position('user_has_permission' in pg_get_functiondef(p.oid)) > 0 perm
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('amend_order_lines','settle_order_line_allocations','order_is_fully_paid_by_allocations','correct_invoice')
    order by 1`)
  for (const r of fns.rows) console.log(`  ${r.proname.padEnd(36)} anon=${r.anon} authenticated=${r.auth} service_role=${r.svc}${r.proname === 'correct_invoice' ? ` perm_check=${r.perm}` : ''}`)

  const pending = []
  for (const f of PLAN) {
    const v = f.slice(0, 14)
    console.log(`  ${ledger.has(v) ? 'applied ' : 'PENDING '} ${f}`)
    if (!ledger.has(v)) pending.push(f)
  }
  if (CHECK || !CONFIRM) {
    console.log(`\n${pending.length} pending. ${CHECK ? 'CHECK' : 'DRY RUN'} — nothing written.`)
    process.exit(0)
  }
  const todo = ONLY ? pending.filter((f) => f.startsWith(ONLY)) : pending
  if (ONLY && todo.length !== 1) throw new Error(`REFUSING: --only=${ONLY} matches ${todo.length} pending files`)
  if (todo.includes('20260913100100_correct_invoice_carries_order_id.sql') && !todo.includes('20260928140100_correct_invoice_carries_tab_scope.sql')) {
    throw new Error('REFUSING: 20260913100100 without 20260928140100')
  }
  for (const f of todo) {
    const rel = `supabase/migrations/${f}`
    const sql = committed(rel)
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query('insert into supabase_migrations.schema_migrations (version, name, statements) values ($1,$2,$3)', [f.slice(0, 14), f.slice(15).replace(/\.sql$/, ''), [sql]])
      await client.query('COMMIT')
      console.log(`  APPLIED ${f}`)
    } catch (e) {
      await client.query('ROLLBACK')
      console.error(`  FAILED  ${f}: ${e.message}`)
      process.exit(1)
    }
  }
  console.log(`\n${todo.length} migration(s) applied to PRODUCTION.`)
} finally {
  await client.end()
}
