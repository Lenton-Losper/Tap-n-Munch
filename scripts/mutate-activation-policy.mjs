/**
 * MUTATION CHECK for the F19 removal (2026-10-03): "a valid activation code is sufficient".
 *
 * Each mutation re-introduces ONE piece of the old policy (or removes one piece of the new
 * invariant), prints the mutated line back from disk, runs the suites that must catch it, and
 * requires them RED with a real test count (a compile/load fault is an instrument fault, never a
 * pass). Every file is restored whatever happens, then the suites run unmutated and must be GREEN.
 *
 *   node scripts/mutate-activation-policy.mjs          # all
 *   node scripts/mutate-activation-policy.mjs AP-3     # one
 *
 * The SQL function's BEHAVIOUR is mutation-tested against real Postgres separately
 * (supabase/tests/mutate-activate-terminal-by-code.mjs); this file covers the route and the
 * source-level guards on the migration.
 *
 * No main-module guard on purpose: on Windows the file:// comparison never matches and the script
 * would exit 0 having run nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js')

const ROUTE = 'app/api/terminals/activate/route.ts'
const MIGRATION = 'supabase/migrations/20261003100000_activate_terminal_by_code.sql'
const T_ROUTE = '__tests__/terminals-activate-reactivation.test.ts'
const T_GUARD = '__tests__/activation-no-cross-restaurant-policy.test.ts'

const MUTATIONS = [
  {
    id: 'AP-1',
    what: 'the identity path stops using the transactional function (back to a blind write)',
    file: ROUTE,
    from: '    if (presentsIdentity) {\n',
    to: '    if (false && presentsIdentity) {\n',
    suites: [T_ROUTE, T_GUARD],
  },
  {
    id: 'AP-2',
    what: 'a unique-index / deadlock loss is no longer a retryable 409 (becomes a 503)',
    file: ROUTE,
    from: "        if (pgCode === '23505' || pgCode === '40P01' || pgCode === '40001') {\n",
    to: "        if (pgCode === 'NEVER') {\n",
    suites: [T_ROUTE],
  },
  {
    id: 'AP-3',
    what: 'a consumed/expired code is no longer the ordinary invalid-code 400',
    file: ROUTE,
    from: "        if (message.includes('ACTIVATION_CODE_INVALID')) {\n",
    to: "        if (message.includes('NEVER')) {\n",
    suites: [T_ROUTE],
  },
  {
    id: 'AP-4',
    what: 'the cross-restaurant refusal code comes back in the route',
    file: ROUTE,
    from: "code: 'ACTIVATION_CONFLICT' },\n            { status: 409 },",
    to: "code: 'DEVICE_REGISTERED_ELSEWHERE' },\n            { status: 409 },",
    suites: [T_ROUTE, T_GUARD],
  },
  {
    id: 'AP-5',
    what: 'the route stops passing the device identity to the function (nothing is released)',
    file: ROUTE,
    from: '        p_device_id: deviceId,\n',
    to: '        p_device_id: null,\n',
    suites: [T_ROUTE],
  },
  {
    id: 'AP-6',
    what: 'SQL: the release no longer frees the physical identity (device_id stays on the old row)',
    file: MIGRATION,
    from: "       SET device_id = NULL,\n           device_serial = 'ft-' || id::text,\n",
    to: "       SET device_serial = 'ft-' || id::text,\n",
    suites: [T_GUARD],
  },
  {
    id: 'AP-7',
    what: "SQL: the release no longer clears the old restaurant's refresh token",
    file: MIGRATION,
    from: '           refresh_token_hash = NULL,\n',
    to: '',
    suites: [T_GUARD],
  },
  {
    id: 'AP-8',
    what: 'SQL: a cross-restaurant refusal is added inside the holder loop',
    file: MIGRATION,
    from: '      v_all := v_all || v_holder.id;\n',
    to: "      IF v_holder.restaurant_id <> v_code.restaurant_id THEN RAISE EXCEPTION 'DEVICE_REGISTERED_ELSEWHERE' USING ERRCODE = 'P0001'; END IF;\n      v_all := v_all || v_holder.id;\n",
    suites: [T_GUARD],
  },
  {
    id: 'AP-9',
    what: 'SQL: EXECUTE is granted to anon instead of service_role',
    file: MIGRATION,
    from: 'TO service_role;',
    to: 'TO anon;',
    suites: [T_GUARD],
  },
  {
    id: 'AP-10',
    what: 'SQL: the code is no longer re-validated for expiry under the lock',
    file: MIGRATION,
    from: '     OR v_code.activation_code_expires_at <= v_now THEN',
    to: '     OR false THEN',
    suites: [T_GUARD],
  },
  {
    id: 'AP-11',
    what: 'SQL: a terminal row is DELETED instead of released (history/FKs lost)',
    file: MIGRATION,
    from: "    v_released := v_released + 1;\n",
    to: "    DELETE FROM public.restaurant_terminals WHERE id = v_release.id;\n    v_released := v_released + 1;\n",
    suites: [T_GUARD],
  },
]

function runJest(suites) {
  const r = spawnSync(process.execPath, [JEST, '--forceExit', '--maxWorkers=2', ...suites], { cwd: ROOT, encoding: 'utf8' })
  const out = `${r.stdout}\n${r.stderr}`
  const tests = /Tests:\s+([^\n]+)/.exec(out)
  const firstRed = /●\s+([^\n]+›[^\n]+)/.exec(out)
  return {
    status: r.status,
    summary: tests ? tests[1].trim() : '(no Tests: line)',
    firstRed: firstRed ? firstRed[1].trim() : null,
    compileFault: /Test suite failed to run/.test(out),
  }
}

const only = process.argv[2]
const chosen = MUTATIONS.filter((m) => !only || m.id === only)
if (chosen.length === 0) {
  console.error(`no mutation named ${only}`)
  process.exit(2)
}

let failures = 0
for (const m of chosen) {
  const path = join(ROOT, m.file)
  const original = readFileSync(path, 'utf8')
  const crlf = original.includes('\r\n')
  const lf = crlf ? original.replace(/\r\n/g, '\n') : original
  const hits = lf.split(m.from).length - 1
  if (hits !== 1) {
    console.error(`${m.id}: expected exactly one match in ${m.file}, found ${hits}`)
    failures += 1
    continue
  }
  const mutatedLf = lf.replace(m.from, () => m.to)
  const mutated = crlf ? mutatedLf.replace(/\n/g, '\r\n') : mutatedLf
  console.log(`\n${m.id}: ${m.what}`)
  try {
    writeFileSync(path, mutated)
    const onDisk = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    const landed = m.to === '' ? !onDisk.includes(m.from) : onDisk.includes(m.to)
    console.log(`  ${m.file} now: ${m.to === '' ? '(line removed)' : m.to.trim().split('\n').pop()}`)
    if (!landed) {
      console.log('  INSTRUMENT FAULT: the mutation is not on disk as intended')
      failures += 1
      continue
    }
    const r = runJest(m.suites)
    if (r.compileFault) {
      console.log(`  INSTRUMENT FAULT: a suite failed to LOAD -- not a RED. ${r.summary}`)
      failures += 1
    } else if (r.status !== 0 && /failed/.test(r.summary)) {
      console.log(`  -> RED (caught)  Tests: ${r.summary}`)
      if (r.firstRed) console.log(`     first RED: ${r.firstRed.slice(0, 150)}`)
    } else {
      console.log(`  -> GREEN, NOT CAUGHT  Tests: ${r.summary}   <-- SURVIVOR: the tests do not guard this`)
      failures += 1
    }
  } finally {
    writeFileSync(path, original)
  }
}

const suites = [...new Set(chosen.flatMap((m) => m.suites))]
const control = runJest(suites)
console.log(`\nunmutated control: ${control.status === 0 ? 'GREEN' : 'RED (!)'}  Tests: ${control.summary}`)
if (control.status !== 0) failures += 1
console.log(failures === 0 ? `\nALL ${chosen.length} MUTATIONS RED, CONTROL GREEN` : `\n${failures} PROBLEM(S)`)
process.exit(failures === 0 ? 0 : 1)
