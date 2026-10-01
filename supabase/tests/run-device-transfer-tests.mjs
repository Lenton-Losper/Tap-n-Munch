#!/usr/bin/env node
/**
 * DATABASE TESTS for transfer_terminal_device() (supabase/migrations/20260930200000).
 *
 *   node supabase/tests/run-device-transfer-tests.mjs              # suite + concurrency probe
 *   node supabase/tests/run-device-transfer-tests.mjs --mutate=all # every mutation must go RED
 *   node supabase/tests/run-device-transfer-tests.mjs --mutate=DT3
 *
 * Builds a throwaway database INSIDE a local container this script names (docker exec only -- there
 * is no connection string, so it cannot reach a real database), applies the fixture schema, the
 * production definition of restaurant_terminals, and the migration (optionally mutated), then runs
 * supabase/tests/device-transfer.test.sql and a two-session concurrency probe.
 *
 * A mutation reintroduces ONE defect. It must turn the suite RED through the assertions named in
 * `expect`; a mutation that leaves it green, or goes red for some other reason, fails the run.
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONTAINER = process.env.FT_TEST_CONTAINER || 'ft-harden-pg'
const DB = process.env.FT_TEST_DB || 'flashtap_device_transfer_test'
const REPO = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const MIGRATION = 'supabase/migrations/20260930200000_terminal_device_transfer.sql'
const MIN_ASSERTIONS = 40

function readRepo(rel) {
  // LF-normalised so a CRLF checkout cannot make a multi-line mutation anchor silently miss.
  return readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')
}

function docker(args, input) {
  return execFileSync('docker', args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
}
function psql(sql, db = DB) {
  return docker(['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q'], sql)
}
function psqlValue(sql) {
  return docker(['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-t', '-A', '-v', 'ON_ERROR_STOP=1'], sql).trim()
}

const MUTATIONS = {
  DT1: {
    what: 'transfer skips invalidating the old terminal session',
    expect: ['transfer/old_row_session_invalidated'],
    apply: (sql) => sql.replace(
      '           refresh_token_hash = NULL,\n           refresh_token_expires_at = NULL,\n           activation_code = NULL,',
      '           activation_code = NULL,'),
  },
  DT2: {
    what: 'transfer skips the restaurant-side approval (anonymous takeover with any valid code)',
    expect: ['refused/not_approved/raises_TRANSFER_NOT_APPROVED'],
    apply: (sql) => sql.replace(
      '  IF v_code.transfer_approved_at IS NULL\n     OR v_code.transfer_request_device_id IS DISTINCT FROM p_device_id THEN',
      '  IF false AND v_code.transfer_request_device_id IS DISTINCT FROM p_device_id THEN'),
  },
  DT3: {
    what: 'the approval is not bound to the device that asked',
    expect: ['refused/approved_for_another_device/raises_TRANSFER_NOT_APPROVED'],
    apply: (sql) => sql.replace(
      '     OR v_code.transfer_request_device_id IS DISTINCT FROM p_device_id THEN',
      '     OR false THEN'),
  },
  DT4: {
    what: 'an expired activation code is accepted',
    expect: ['refused/expired_code/raises_TRANSFER_CODE_INVALID'],
    apply: (sql) => sql.replace(
      '     OR v_code.activation_code_expires_at <= v_now THEN',
      '     OR false THEN'),
  },
  DT5: {
    what: 'a used (already active) code is accepted',
    expect: ['refused/used_code/raises_TRANSFER_CODE_INVALID'],
    apply: (sql) => sql.replace('     OR v_code.active IS DISTINCT FROM false\n', ''),
  },
  DT6: {
    what: 'the old terminal keeps its device identity (release skipped)',
    expect: ['transfer/old_row_identity_released'],
    apply: (sql) => sql.replace(
      "       SET device_id = NULL,\n           device_serial = 'ft-' || id::text,\n           sn = NULL,\n",
      '       SET '),
  },
  DT7: {
    what: 'the transfer-out audit event is omitted',
    expect: ['transfer/audit_out_in_old_restaurant'],
    apply: (sql) => sql.replace(
      "    VALUES (\n      v_holder.restaurant_id,\n      'terminal.device_transferred_out',",
      "    SELECT\n      v_holder.restaurant_id,\n      'terminal.device_transferred_out',").replace(
      "        'at', v_now\n      )\n    );\n\n    v_released",
      "        'at', v_now\n      )\n    WHERE false;\n\n    v_released"),
  },
  DT8: {
    what: 'a holder in the SAME restaurant is transferred instead of refused (cross-restaurant isolation of the rebind path lost)',
    expect: ['refused/same_restaurant_holder/raises_TRANSFER_SAME_RESTAURANT'],
    apply: (sql) => sql.replace(
      "      RAISE EXCEPTION 'TRANSFER_SAME_RESTAURANT' USING ERRCODE = 'P0001';",
      '      NULL;'),
  },
  DT9: {
    what: 'anon can execute the transfer function',
    expect: ['grants/anon_cannot_execute'],
    apply: (sql) => sql.replace(
      'REVOKE ALL ON FUNCTION public.transfer_terminal_device(uuid, text, text, text, text, timestamptz) FROM anon;\n', ''),
  },
  DT10: {
    what: 'duplicate device ownership allowed (identity not released AND the unique index dropped)',
    expect: ['transfer/exactly_one_holder'],
    apply: (sql) => sql.replace(
      "       SET device_id = NULL,\n           device_serial = 'ft-' || id::text,\n           sn = NULL,\n",
      '       SET '),
    sqlBeforeMigration:
      'ALTER TABLE public.restaurant_terminals DROP CONSTRAINT restaurant_terminals_device_id_unique;\n' +
      'ALTER TABLE public.restaurant_terminals DROP CONSTRAINT restaurant_terminals_device_serial_unique;\n',
  },
  DT11: {
    what: "the old till's payment history is re-attributed to the new terminal (history rewritten)",
    expect: ['transfer/order_and_payment_history_byte_identical'],
    apply: (sql) => sql.replace(
      '    v_released := v_released || v_holder.id;\n',
      '    UPDATE public.payment_events SET terminal_id = v_code.id::text WHERE terminal_id = v_holder.id::text;\n' +
        '    v_released := v_released || v_holder.id;\n'),
  },
}

function buildDatabase(mutation) {
  psql(`DROP DATABASE IF EXISTS ${DB};`, 'postgres')
  psql(`CREATE DATABASE ${DB};`, 'postgres')
  psql(readRepo('supabase/tests/fixture-schema.sql'))
  psql(readRepo('supabase/tests/restaurant-terminals-fixture.sql'))
  if (mutation?.sqlBeforeMigration) psql(mutation.sqlBeforeMigration)
  const original = readRepo(MIGRATION)
  const sql = mutation ? mutation.apply(original) : original
  if (mutation && sql === original) throw new Error(`mutation did not apply -- its anchor no longer matches`)
  psql(sql)
}

function runSuite() {
  psql(readRepo('supabase/tests/device-transfer.test.sql'))
  const total = Number(psqlValue('SELECT count(*) FROM public._test_results;'))
  const failedNames = psqlValue('SELECT string_agg(name, E\'\\n\' ORDER BY name) FROM public._test_results WHERE NOT passed;')
  return { total, failedNames: failedNames ? failedNames.split('\n') : [] }
}

/**
 * Q. TWO SESSIONS, the same device, two different restaurants' approved codes, run concurrently.
 * Session 1 holds its transaction open after transferring; session 2 starts meanwhile. Whatever the
 * interleaving -- session 2 blocking on session 1's row locks, or losing to the unique index --
 * exactly ONE row may hold the device afterwards.
 */
function psqlAsync(sql) {
  return new Promise((resolve) => {
    const p = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-q'])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
    p.stdin.end(sql)
  })
}

async function runConcurrencyProbe() {
  psql(`
    SELECT public._dt_seed();
    INSERT INTO public.restaurant_terminals
      (id, restaurant_id, status, active, activation_code, activation_code_expires_at,
       transfer_request_device_id, transfer_requested_at, transfer_approved_at)
    VALUES ('c1111111-0000-4000-8000-00000000001c', 'cccccccc-0000-4000-8000-000000000003', 'pending', false,
            'FT-RACE-CCCC', now() + interval '1 hour', 'dev-6799', now(), now());
  `)
  const s1 = psqlAsync(`BEGIN; SELECT public._dt_transfer('b0000000-0000-4000-8000-00000000000b'); SELECT pg_sleep(2); COMMIT;`)
  await new Promise((r) => setTimeout(r, 500))
  const s2 = psqlAsync(`SELECT public._dt_transfer('c1111111-0000-4000-8000-00000000001c');`)
  const [r1, r2] = await Promise.all([s1, s2])
  const holders = Number(psqlValue(`SELECT public._dt_holders();`))
  const succeeded = [r1.code === 0, r2.code === 0].filter(Boolean).length
  /**
   * WHY the loser lost, not only that it did (2026-10-01). "One holder" alone would also read OK if
   * session 2 died of anything at all -- a typo, a dropped connection. The loser must have been
   * stopped by the identity guard: the unique constraint (it scanned for holders before session 1
   * committed, so only the index can see session 1's new row) or a TRANSFER_* refusal.
   */
  const loser = r1.code === 0 ? r2 : r1
  const loserReason = /duplicate key value violates unique constraint "(restaurant_terminals_device_\w+_unique)"/.exec(loser.out)?.[1]
    ?? /TRANSFER_[A-Z_]+/.exec(loser.out)?.[0]
    ?? `UNEXPECTED: ${loser.out.trim().split('\n').pop()?.slice(0, 160)}`
  const ok = holders === 1 && succeeded === 1 && !loserReason.startsWith('UNEXPECTED')
  console.log(
    `  concurrency (B and C race for A's device): session1 exit ${r1.code}, session2 exit ${r2.code}, ` +
      `holders afterwards ${holders}, loser stopped by ${loserReason} -> ${ok ? 'OK' : 'FAIL'}`,
  )
  if (!ok) console.log(`    s1: ${r1.out.trim().slice(0, 300)}\n    s2: ${r2.out.trim().slice(0, 300)}`)
  return { ok, holders }
}

/**
 * DTQ (2026-10-01): the race mutation. The release logic stays INTACT; only the two unique identity
 * constraints are dropped. Session 2 cannot see session 1's newly bound row (its holder scan began
 * first), so without the index BOTH bind the device -- the probe must then find two owners. This
 * proves the index, not timing luck, is what decides the race.
 */
const RACE_MUTATION = {
  apply: (sql) => `${sql}\n-- DTQ: unique identity constraints dropped before this migration ran\n`,
  sqlBeforeMigration:
    'ALTER TABLE public.restaurant_terminals DROP CONSTRAINT restaurant_terminals_device_id_unique;\n' +
    'ALTER TABLE public.restaurant_terminals DROP CONSTRAINT restaurant_terminals_device_serial_unique;\n',
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--mutate='))
  const which = arg ? arg.split('=')[1] : null

  buildDatabase(null)
  const base = runSuite()
  console.log(`baseline: ${base.total} assertions, ${base.failedNames.length} failed`)
  let failures = 0
  if (base.total < MIN_ASSERTIONS) {
    console.error(`FAIL: only ${base.total} assertions discovered (floor ${MIN_ASSERTIONS}).`)
    failures++
  }
  if (base.failedNames.length) {
    console.error(`FAIL:\n  ${base.failedNames.join('\n  ')}`)
    failures++
  }
  if (!(await runConcurrencyProbe()).ok) failures++

  if (which === 'all' || which === 'DTQ') {
    buildDatabase(RACE_MUTATION)
    runSuite() // loads the _dt_* helpers the probe seeds with; its own verdict is not this check's
    const raced = await runConcurrencyProbe()
    const caught = raced.holders >= 2
    console.log(`  DTQ (unique identity constraints dropped; the race must then yield two owners): ${caught ? 'RED (caught)' : 'GREEN (NOT CAUGHT)'}  holders=${raced.holders}`)
    if (!caught) failures++
    buildDatabase(null)
  }

  if (which && which !== 'DTQ') {
    const names = which === 'all' ? Object.keys(MUTATIONS) : [which]
    for (const name of names) {
      const m = MUTATIONS[name]
      if (!m) { console.error(`no mutation ${name}`); failures++; continue }
      try {
        buildDatabase(m)
      } catch (e) {
        console.error(`  ${name}: INSTRUMENT FAULT -- ${e.message.split('\n')[0]}`)
        failures++
        continue
      }
      const run = runSuite()
      const caught = m.expect.every((n) => run.failedNames.includes(n))
      const red = run.failedNames.length > 0
      console.log(`  ${name} (${m.what}): ${red && caught ? 'RED (caught)' : red ? 'RED but NOT via the expected assertions' : 'GREEN (NOT CAUGHT)'}` +
        `  failed: ${run.failedNames.slice(0, 4).join(', ')}${run.failedNames.length > 4 ? ` +${run.failedNames.length - 4}` : ''}`)
      if (!(red && caught) || run.total < MIN_ASSERTIONS) failures++
    }
    // Leave the database unmutated.
    buildDatabase(null)
    const control = runSuite()
    console.log(`unmutated control: ${control.failedNames.length === 0 ? 'GREEN' : 'RED'} (${control.total} assertions)`)
    if (control.failedNames.length) failures++
  }
  console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

// Called unconditionally: a main-module guard never matches on Windows and exits 0 having run nothing.
main().catch((e) => { console.error(e); process.exit(1) })
