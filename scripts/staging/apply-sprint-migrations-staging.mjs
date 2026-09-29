#!/usr/bin/env node
/**
 * APPLY THE 2026-09-28/29 SPRINT MIGRATIONS TO STAGING — direct Postgres, never production.
 *
 * Why direct Postgres: CI has no credential that can apply DDL, and `supabase db query` runs SQL
 * without writing the ledger row, which makes the next drift check fail. Each file here runs in ITS
 * OWN TRANSACTION together with its `supabase_migrations.schema_migrations` row, so a failure leaves
 * neither a half-applied schema nor a ledger claiming something that did not land. Stops on the
 * first error.
 *
 * Identity is proven by the DATABASE, not by DNS: connectStaging() (supabase/tests/staging-db.mjs)
 * refuses unless the 'staging test' venue exists, and this script additionally refuses if the
 * ledger lacks 20260705210000 / 20260705220000 -- applied on staging and deliberately absent from
 * production, so a mistyped target is caught by the database disagreeing.
 *
 * Refuses any file git does not track (an untracked .sql must never reach a database).
 *
 *   node scripts/staging/apply-sprint-migrations-staging.mjs            # dry run: shows the plan
 *   node scripts/staging/apply-sprint-migrations-staging.mjs --confirm  # applies, in order
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { connectStaging } from '../../supabase/tests/staging-db.mjs'

const REPO = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const CONFIRM = process.argv.includes('--confirm')

/**
 * EXACT DEPENDENCY ORDER (= version order; every redefinition copies the body of the one before
 * it). 20260913100100 re-grants correct_invoice to authenticated and drops its permission check --
 * it MUST NOT be applied without 20260928140100 immediately after it in the same run.
 */
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
/** Applied on staging, deliberately absent from production. Their presence identifies staging. */
const STAGING_ONLY = ['20260705210000', '20260705220000']

function tracked(rel) {
  try {
    execFileSync('git', ['-C', REPO, 'ls-files', '--error-unmatch', rel], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const client = await connectStaging()
try {
  const ledger = new Set(
    (await client.query('select version from supabase_migrations.schema_migrations')).rows.map((r) => r.version),
  )
  for (const v of STAGING_ONLY) {
    if (!ledger.has(v)) throw new Error(`REFUSING: ledger lacks ${v}; this does not look like staging`)
  }
  const versions = PLAN.map((f) => f.slice(0, 14))
  if (new Set(versions).size !== versions.length) throw new Error('REFUSING: duplicate version in PLAN')
  if ([...versions].sort().join() !== versions.join()) throw new Error('REFUSING: PLAN is not in version order')

  const todo = []
  for (const file of PLAN) {
    const rel = `supabase/migrations/${file}`
    if (!tracked(rel)) throw new Error(`REFUSING: ${rel} is not tracked by git`)
    const v = file.slice(0, 14)
    console.log(`  ${ledger.has(v) ? 'applied ' : 'PENDING '} ${file}`)
    if (!ledger.has(v)) todo.push(file)
  }
  // 100100 without 140100 opens correct_invoice; refuse a plan that would leave that state.
  if (todo.includes('20260913100100_correct_invoice_carries_order_id.sql') &&
      !todo.includes('20260928140100_correct_invoice_carries_tab_scope.sql')) {
    throw new Error('REFUSING: 20260913100100 pending without 20260928140100')
  }
  console.log(`\n${todo.length} pending. Mode: ${CONFIRM ? 'APPLY' : 'DRY RUN (nothing written)'}`)
  if (!CONFIRM) process.exit(0)

  for (const file of todo) {
    /**
     * THE COMMITTED BYTES, never the working copy. Mutation harnesses edit migrations on disk and
     * restore them; reading the working tree could push a deliberately broken function to staging.
     * The working copy must also match, so a local edit is refused rather than silently ignored.
     */
    const rel = `supabase/migrations/${file}`
    const sql = execFileSync('git', ['-C', REPO, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const onDisk = readFileSync(join(REPO, rel), 'utf8')
    if (onDisk.replace(/\r\n/g, '\n') !== sql.replace(/\r\n/g, '\n')) {
      throw new Error(`REFUSING: ${rel} on disk differs from HEAD (a local or mutation edit)`)
    }
    const version = file.slice(0, 14)
    const name = file.slice(15).replace(/\.sql$/, '')
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query(
        'insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)',
        [version, name, [sql]],
      )
      await client.query('COMMIT')
      console.log(`  APPLIED ${file}`)
    } catch (e) {
      await client.query('ROLLBACK')
      console.error(`  FAILED  ${file}: ${e.message}`)
      process.exit(1)
    }
  }
  console.log('\nAll pending sprint migrations applied to STAGING.')
} finally {
  await client.end()
}
