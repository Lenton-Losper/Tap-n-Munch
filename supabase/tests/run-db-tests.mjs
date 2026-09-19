#!/usr/bin/env node
/**
 * DATABASE / RPC TEST RUNNER.
 *
 * Builds a throwaway Postgres from the fixture schema, applies the sprint's migrations, runs
 * supabase/tests/settlement-rpc.test.sql, and reports. It can also apply a MUTATION first --
 * a deliberate reintroduction of a defect -- and assert that the suite goes RED, which is the
 * only thing that proves a test is load-bearing rather than merely green.
 *
 *   node supabase/tests/run-db-tests.mjs
 *   node supabase/tests/run-db-tests.mjs --mutate=M1
 *   node supabase/tests/run-db-tests.mjs --mutate=all
 *
 * SAFETY. Every statement runs through `docker exec` against a container this script starts and
 * names itself. There is no connection string, no host argument and no environment variable that
 * could point it at a real database -- reaching production would require editing this file.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CONTAINER = 'ft-harden-pg'
const DB = 'flashtap_test'
const REPO = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/**
 * Applied in order on top of the fixture. The FIRST is an existing, already-deployed migration,
 * included deliberately: `settle_order_line_allocations` is what the new function is modelled on
 * and what the security assertions compare against, so the suite must exercise the real one rather
 * than a stub that cannot fail.
 */
const MIGRATIONS = [
  'supabase/migrations/20260829170000_order_line_allocations.sql',
  'supabase/migrations/20260919090000_settle_order_payment_atomic.sql',
  'supabase/migrations/20260919091000_payment_integrity_constraints.sql',
]

/**
 * THE MUTATIONS. Each reintroduces one defect this sprint closed. A mutation that leaves the suite
 * GREEN means the corresponding test does not actually test what it claims to.
 */
const MUTATIONS = {
  M1: {
    what: 'multi-order settlement reverted to lead-order-only (the Riviera defect)',
    expect: ['riviera/both_orders_paid', 'riviera/order_154_paid'],
    /**
     * The write loop iterates only the LEAD order -- precisely what
     * `for (const row of orderRows)` did while the expectation was summed over `settlementRows`.
     *
     * OFFSET 1, not LIMIT 1: the target set is ordered by id, so LIMIT 1 keeps #154 and drops
     * #155, which is the defect pointing the wrong way. Production kept the lead order #155 and
     * dropped #154, and this reproduces THAT.
     */
    apply: (sql) =>
      sql.replace(
        'FOR v_row IN SELECT e FROM jsonb_array_elements(v_target) e LOOP',
        'FOR v_row IN SELECT e FROM jsonb_array_elements(v_target) e OFFSET 1 LOOP',
      ),
  },
  M2: {
    what: 'server-side ledger creation removed (payment_events written only by the device)',
    expect: ['riviera/ledger_row_written', 'riviera/ledger_amount_is_gateway_amount'],
    apply: (sql) =>
      sql.replace(
        'IF array_length(v_claimed, 1) IS NOT NULL THEN\n    INSERT INTO public.payment_events',
        'IF false THEN\n    INSERT INTO public.payment_events',
      ),
  },
  M3: {
    what: "payment method falls back to the row's own value -- (row.payment_method) || 'card'",
    expect: ['riviera/method_is_card'],
    /**
     * The bare column name on the right of an UPDATE ... SET is the row's OLD value, so this is
     * `(row.payment_method) || 'card'` expressed in SQL -- keep whatever the order already said,
     * and only fall back to the gateway's channel when it said nothing.
     *
     * An earlier version of this mutation read `v_row->>'payment_method'`, which the target set
     * does not carry; it was INERT and left the suite green. The harness reported that as an
     * uncaught mutation, which is what caught it.
     */
    apply: (sql) =>
      sql.replace(
        '           payment_method      = v_method,',
        '           payment_method      = COALESCE(payment_method, v_method),',
      ),
  },
  M4: {
    what: 'the expectation is summed from orders.total instead of the recorded charge',
    expect: ['tip/expectation_is_the_charge', 'tip/rpc_ok'],
    apply: (sql) =>
      sql.replace(
        "             COALESCE(NULLIF(o.pending_charge_cents, 0), round(o.total * 100)::integer)\n               AS charge_cents",
        '             round(o.total * 100)::integer AS charge_cents',
      ),
  },
  M5: {
    what: 'a stale payment intent is allowed to settle against changed financial state',
    /**
     * `stale/reason` is included deliberately. Removing the staleness check does not always let a
     * settlement through -- the gateway-amount comparison catches the common shape as well -- so a
     * mutation proof that only asserted "it was refused" would pass for the wrong reason. The test
     * is constructed so the gateway amount AGREES and only the staleness check can refuse; if that
     * construction ever stops holding, this assertion is what notices.
     */
    expect: ['stale/refused', 'stale/nothing_applied', 'stale/reason'],
    apply: (sql) =>
      sql.replace(
        '  IF p_expected_amount_cents IS NOT NULL AND v_recomputed <> p_expected_amount_cents THEN',
        '  IF false THEN',
      ),
  },
  M6: {
    what: 'the database uniqueness protections are dropped',
    expect: [
      'constraint/allocation_settled_twice_refused',
      'constraint/duplicate_transaction_id_refused',
    ],
    sqlAfterMigrations: `
      DROP INDEX IF EXISTS public.order_line_allocation_settlements_one_per_allocation;
      DROP INDEX IF EXISTS public.payment_events_restaurant_transaction_id_unique;
    `,
  },
  M7: {
    what: 'an illegal payment state transition is permitted',
    expect: ['illegal/refused', 'illegal/no_partial_application'],
    apply: (sql) =>
      sql.replace(
        "    IF v_status = 'cancelled' AND NOT (v_order_id = ANY (v_allow)) THEN",
        '    IF false THEN',
      ),
  },
}

function docker(args, input) {
  return execFileSync('docker', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function psql(sql, { db = DB, quiet = true } = {}) {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1']
  if (quiet) args.push('-q')
  return docker(args, sql)
}

function psqlValue(sql) {
  return docker(
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    sql,
  ).trim()
}

function readRepo(rel) {
  return readFileSync(join(REPO, rel), 'utf8')
}

function buildDatabase(mutation) {
  psql(`DROP DATABASE IF EXISTS ${DB};`, { db: 'postgres' })
  psql(`CREATE DATABASE ${DB};`, { db: 'postgres' })
  psql(readRepo('supabase/tests/fixture-schema.sql'))

  for (const rel of MIGRATIONS) {
    let sql = readRepo(rel)
    if (mutation?.apply) {
      const mutated = mutation.apply(sql)
      if (mutated !== sql) {
        // MUTATION LANDED. A regex that matched nothing would leave the code correct and the
        // suite green, which reads exactly like a test that does not work.
        mutation._landed = true
        sql = mutated
      }
    }
    psql(sql)
  }
  if (mutation?.sqlAfterMigrations) {
    psql(mutation.sqlAfterMigrations)
    mutation._landed = true
  }
}

function runSuite() {
  psql(readRepo('supabase/tests/settlement-rpc.test.sql'))
  const total = Number(psqlValue('SELECT count(*) FROM public._test_results;'))
  const failed = psqlValue(
    "SELECT string_agg(name || '  ::  ' || COALESCE(detail,''), E'\\n') " +
      'FROM public._test_results WHERE NOT passed;',
  )
  const failedNames = psqlValue(
    'SELECT COALESCE(string_agg(name, E\'\\n\'), \'\') FROM public._test_results WHERE NOT passed;',
  )
    .split('\n')
    .filter(Boolean)
  return { total, failed, failedNames }
}

const arg = process.argv.find((a) => a.startsWith('--mutate='))
const which = arg ? arg.split('=')[1] : null

// ---- baseline ------------------------------------------------------------------------------
console.log('=== BASELINE (no mutation) ===')
buildDatabase(null)
const base = runSuite()

/**
 * TEST DISCOVERY IS ASSERTED, not assumed. A suite that ran nothing exits 0 on every other check
 * in this file, and "0 tests passed" is the failure mode the brief singles out.
 */
const MIN_ASSERTIONS = 40
if (base.total < MIN_ASSERTIONS) {
  console.error(
    `FAIL: only ${base.total} assertions were discovered (expected at least ${MIN_ASSERTIONS}). ` +
      'A suite that discovers nothing is not a passing suite.',
  )
  process.exit(1)
}
console.log(`  assertions discovered: ${base.total}`)
if (base.failedNames.length > 0) {
  console.error(`  FAILED (${base.failedNames.length}):\n${base.failed}`)
  process.exit(1)
}
console.log(`  all ${base.total} assertions passed`)

if (!which) process.exit(0)

// ---- mutations -----------------------------------------------------------------------------
const names = which === 'all' ? Object.keys(MUTATIONS) : [which]
let bad = 0

for (const name of names) {
  const mutation = MUTATIONS[name]
  if (!mutation) {
    console.error(`unknown mutation ${name}`)
    process.exit(1)
  }
  mutation._landed = false
  console.log(`\n=== MUTATION ${name}: ${mutation.what} ===`)
  buildDatabase(mutation)

  if (!mutation._landed) {
    // The anchor moved. Reporting this as a pass would be the false green
    // [[mutation-must-land-on-the-intended-line]] is about.
    console.error(`  FAIL: mutation ${name} did not apply -- its anchor no longer matches.`)
    bad += 1
    continue
  }

  const run = runSuite()
  if (run.total < MIN_ASSERTIONS) {
    console.error(`  FAIL: mutation ${name} left only ${run.total} assertions discovered.`)
    bad += 1
    continue
  }

  const missed = mutation.expect.filter((e) => !run.failedNames.includes(e))
  if (run.failedNames.length === 0) {
    console.error(`  FAIL: the suite stayed GREEN under mutation ${name}. The tests do not catch it.`)
    bad += 1
  } else if (missed.length > 0) {
    console.error(
      `  FAIL: mutation ${name} turned the suite red, but not through the assertions that are ` +
        `supposed to catch it. Still green: ${missed.join(', ')}`,
    )
    bad += 1
  } else {
    console.log(
      `  RED as required (${run.failedNames.length}/${run.total} failed), including: ` +
        mutation.expect.join(', '),
    )
  }
}

if (bad > 0) {
  console.error(`\n${bad} mutation(s) were not caught.`)
  process.exit(1)
}
console.log('\nAll mutations produced the required failures.')
