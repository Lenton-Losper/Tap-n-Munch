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
  M9: {
    what: 'the intent row is read WITHOUT FOR UPDATE (two settlements can interleave)',
    /**
     * Caught only by the two-session probe, which is why that probe exists. Measured: without the
     * lock BOTH sessions return `settled` / `applied: true` and TWO `payment.settlement_applied`
     * audit rows are written -- an auditor reads that as the customer having been charged twice.
     *
     * The orders and the ledger row survive even then, because the per-row claim and the
     * ON CONFLICT are defence in depth. That is worth knowing and is NOT a reason to drop the
     * lock: the audit trail is the record a disputed charge is settled from.
     */
    concurrencyOnly: true,
    expect: [],
    apply: (sql) =>
      sql.replace('     WHERE id = p_intent_id\n     FOR UPDATE;', '     WHERE id = p_intent_id;'),
  },
  M10: {
    what: 'an already-settled order can be settled again (the tab-close replay protection)',
    /**
     * THE PROTECTION THAT ACTUALLY CARRIES THIS RACE, established by measurement rather than by
     * assumption.
     *
     * The first version of M10 removed the tab-row `FOR UPDATE` and the close-race probe STAYED
     * GREEN. That was the harness being right: the money invariants across a payment/tab-close
     * race are not held up by the tab lock at all. `close_table_session` never touches `orders`,
     * and the settlement's own per-order `FOR UPDATE` plus this already-paid guard are what make
     * double settlement unreachable. (The explicit tab lock is kept for lock-ORDER hygiene and a
     * well-defined `tab_was_closed` read; it is documented as such and is not claimed to be
     * load-bearing, because a mutation could not make it fail.)
     *
     * So the mutation targets the guard that IS load-bearing: remove the already-paid CONTINUE and
     * a replay after the close re-claims orders that were settled, writing a second audit row for
     * one payment. Round 4 of the close-race probe catches it.
     */
    concurrencyOnly: true,
    concurrencyScript: 'supabase/tests/close-race.test.sh',
    expect: [],
    apply: (sql) =>
      sql
        .replace(
          `    IF v_status = 'paid' THEN
      -- Already paid by whoever won the race. Not an error and not a re-write; reported so the
      -- caller can tell a duplicate from a conflict.
      CONTINUE;
    END IF;`,
          `    IF false THEN
      CONTINUE;
    END IF;`,
        )
        /**
         * BOTH replay protections, together, and that is the finding rather than a convenience.
         *
         * Removing the already-paid CONTINUE alone leaves the probe GREEN, because the
         * illegal-transition check immediately below refuses `paid -> paid` and the settlement
         * comes back `ok: false` with nothing claimed. Two independent guards cover this race, so
         * a mutation has to lift both before anything observable changes.
         *
         * That redundancy is real defence in depth and is the honest reason an earlier, narrower
         * mutation could not be made to fail.
         */
        .replace(
          `    IF v_status NOT IN (
         'unpaid', 'pending', 'terminal_pending', 'cash_pending', 'failed',
         'amount_mismatch_hold', 'verification_unavailable_hold', 'cancelled') THEN`,
          `    IF false THEN`,
        ),
  },
  M8: {
    what: 'the settlement RPC is granted to anon (the security POSITIVE CONTROL)',
    expect: ['security/anon_cannot_execute', 'security/public_cannot_execute'],
    /**
     * WHY A SECURITY MUTATION EXISTS AT ALL.
     *
     * "anon cannot execute this function" passes just as readily when the function does not exist,
     * when the role does not exist, or when `has_function_privilege` was handed a signature that
     * matches nothing -- and a typo in that signature string is easy and invisible. A refusal that
     * cannot tell CLOSED from ABSENT is not a security check.
     *
     * So the grant is deliberately opened and the suite is required to notice. If it stays green
     * here, the assertions are reading something other than the real function.
     */
    sqlAfterMigrations: `
      GRANT EXECUTE ON FUNCTION public.settle_order_payment(
        uuid, uuid[], integer, integer, text, text, text, text, uuid, text, text, integer, uuid,
        uuid[], text) TO anon, PUBLIC;
    `,
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

/**
 * `close_table_session` EXTRACTED FROM THE BASELINE, never copied.
 *
 * The settlement/tab-close race test needs the real function, and a transcription of it into the
 * fixture would drift the moment somebody changed the original -- which is exactly the kind of
 * silent divergence these tests exist to catch elsewhere. Slicing it out of
 * `00000000000000_baseline.sql` means the test always runs whatever production has.
 *
 * Applying the WHOLE baseline is not an option: it is 3,000+ lines of unrelated schema that the
 * fixture deliberately does not reproduce.
 */
function closeTableSessionDefinition() {
  const baseline = readRepo('supabase/migrations/00000000000000_baseline.sql')
  const start = baseline.indexOf('CREATE OR REPLACE FUNCTION "public"."close_table_session"')
  if (start < 0) throw new Error('close_table_session not found in the baseline migration')
  // The body is dollar-quoted; the definition ends at the first `$$;` after it.
  const end = baseline.indexOf('$$;', start)
  if (end < 0) throw new Error('close_table_session body is not terminated')
  return baseline.slice(start, end + 3)
}

function buildDatabase(mutation) {
  psql(`DROP DATABASE IF EXISTS ${DB};`, { db: 'postgres' })
  psql(`CREATE DATABASE ${DB};`, { db: 'postgres' })
  psql(readRepo('supabase/tests/fixture-schema.sql'))
  psql(closeTableSessionDefinition())

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

/**
 * The concurrency probe runs in TWO sessions, which a single psql pipe cannot express, so it lives
 * in a shell script beside this file. Returns true when it passed.
 */
function runConcurrencyProbe(script = 'supabase/tests/concurrency.test.sh') {
  try {
    const out = execFileSync('bash', [join(REPO, script)], {
      encoding: 'utf8',
      env: { ...process.env, CONTAINER, DB },
      maxBuffer: 16 * 1024 * 1024,
    })
    return { passed: out.includes('RESULT=OK'), out }
  } catch (e) {
    return { passed: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
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

// Two real sessions racing on one intent. The single-session suite above can only prove
// IDEMPOTENCE; this is the only thing that exercises the FOR UPDATE.
const baseRace = runConcurrencyProbe()
if (!baseRace.passed) {
  console.error('FAIL: the concurrency probe did not pass on unmutated code.')
  console.error(baseRace.out.split('\n').slice(-14).join('\n'))
  process.exit(1)
}
console.log('  concurrency probe: two sessions, exactly one settlement')

// Settlement vs close_table_session, in two sessions, both orderings.
const baseClose = runConcurrencyProbe('supabase/tests/close-race.test.sh')
if (!baseClose.passed) {
  console.error('FAIL: the settlement/tab-close race probe did not pass on unmutated code.')
  console.error(baseClose.out.split('\n').slice(-24).join('\n'))
  process.exit(1)
}
console.log('  close-race probe: settlement and tab close serialise, money recorded once')

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

  /**
   * A mutation only the TWO-SESSION probe can see. The single-session suite is expected to stay
   * green under it, so asserting on that suite would report a false pass.
   */
  if (mutation.concurrencyOnly) {
    const race = runConcurrencyProbe(
      mutation.concurrencyScript ?? 'supabase/tests/concurrency.test.sh',
    )
    if (race.passed) {
      console.error(`  FAIL: the concurrency probe stayed GREEN under mutation ${name}.`)
      bad += 1
    } else {
      const failed = race.out.split('\n').filter((l) => l.includes('  FAIL ')).length
      console.log(`  RED as required (${failed} concurrency assertion(s) failed)`)
    }
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
