/**
 * MUTATION CHECK for device management (Settings -> Devices, 2026-09-30).
 *
 * Each mutation reintroduces ONE defect in a protection the sprint relies on, prints the mutated
 * lines back from disk, runs the suites that must catch it, and requires them RED with a real test
 * count (a compile/load fault is an instrument fault, never a pass). Every file is restored whatever
 * happens, and the suites then run unmutated and must be GREEN.
 *
 * The database half (transfer_terminal_device: locks, release, session invalidation, audit, grants,
 * duplicate ownership) has its own runner: supabase/tests/run-device-transfer-tests.mjs --mutate=all.
 *
 *   node scripts/mutate-device-management.mjs          # all
 *   node scripts/mutate-device-management.mjs DM-4     # one
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

const ROUTES = '__tests__/admin-devices-routes.test.ts'
const ACTIVATE = '__tests__/device-transfer-activation.test.ts'
const REACT = '__tests__/terminals-activate-reactivation.test.ts'
const STATE = '__tests__/device-state.test.ts'
const UI = '__tests__/devices-console.test.tsx'

const LIFECYCLE = 'lib/devices/device-lifecycle.ts'
const DEVICE_ROUTE = 'app/api/admin/devices/[deviceId]/route.ts'
const LIST_ROUTE = 'app/api/admin/devices/route.ts'
const ACTIVATE_ROUTE = 'app/api/terminals/activate/route.ts'
const STATE_LIB = 'lib/devices/device-state.ts'

const MUTATIONS = [
  {
    id: 'DM-1',
    what: 'restaurant isolation removed from the device lookup (a UUID of Restaurant B resolves)',
    file: LIFECYCLE,
    from: "    .eq('id', deviceId)\n    .eq('restaurant_id', restaurantId)\n    .maybeSingle()\n",
    to: "    .eq('id', deviceId)\n    .maybeSingle()\n",
    suites: [ROUTES],
  },
  {
    id: 'DM-2',
    what: 'cross-restaurant mutation: lifecycle UPDATE no longer scoped to the caller’s restaurant',
    file: LIFECYCLE,
    from: "    .update(patch)\n    .eq('id', ctx.deviceId)\n    .eq('restaurant_id', ctx.restaurantId)\n",
    to: "    .update(patch)\n    .eq('id', ctx.deviceId)\n",
    // Isolation is layered: the lookup refuses first. Break BOTH layers to prove the write-side
    // scope is itself load-bearing? No -- this mutation proves the lookup alone does not hide a
    // missing write scope from the suite, so pair it with DM-1's removal.
    alsoFrom: "    .eq('id', deviceId)\n    .eq('restaurant_id', restaurantId)\n    .maybeSingle()\n",
    alsoTo: "    .eq('id', deviceId)\n    .maybeSingle()\n",
    suites: [ROUTES],
  },
  {
    id: 'DM-3',
    what: 'permission check skipped (a screens-only manager can act on a payment terminal)',
    file: DEVICE_ROUTE,
    from: '  if (!caller.canManage[kind]) return forbiddenForKind(kind)\n',
    to: '',
    marker: '  return { caller, row, ctx:',
    suites: [ROUTES],
  },
  {
    id: 'DM-4',
    what: 'revoke/deactivate the WRONG terminal: the lifecycle UPDATE ignores the device id',
    file: LIFECYCLE,
    from: "    .update(patch)\n    .eq('id', ctx.deviceId)\n",
    to: "    .update(patch)\n",
    suites: [ROUTES],
  },
  {
    id: 'DM-5',
    what: 'remove the WRONG terminal: the DELETE ignores the device id',
    file: LIFECYCLE,
    from: "    .delete()\n    .eq('id', ctx.deviceId)\n",
    to: "    .delete()\n",
    suites: [ROUTES],
  },
  {
    id: 'DM-6',
    what: 'remove fails to release identity and session (soft-marks the row instead of deleting it)',
    file: LIFECYCLE,
    from: "  const { data, error } = await ctx.supabase\n    .from('restaurant_terminals')\n    .delete()\n",
    to: "  const { data, error } = await ctx.supabase\n    .from('restaurant_terminals')\n    .update({ status: 'revoked', active: false })\n",
    suites: [ROUTES],
  },
  {
    id: 'DM-7',
    what: 'deactivate incorrectly releases the device identity',
    file: LIFECYCLE,
    from: "  const updated = await updateScoped(ctx, { status: 'inactive' })\n",
    to: "  const updated = await updateScoped(ctx, { status: 'inactive', device_id: null, device_serial: null })\n",
    suites: [ROUTES],
  },
  {
    id: 'DM-8',
    what: 'audit event omitted from every lifecycle action',
    file: LIFECYCLE,
    from: "  const { error } = await supabase.from('audit_logs').insert({\n",
    to: "  const { error } = { error: null }\n  if (false) await supabase.from('audit_logs').insert({\n",
    suites: [ROUTES],
  },
  {
    id: 'DM-9',
    what: 'F19 skipped: a device registered elsewhere activates on any valid code',
    file: ACTIVATE_ROUTE,
    from: "    if (decision.kind === 'reject_cross_restaurant') {\n      const others",
    to: "    if (false && decision.kind === 'reject_cross_restaurant') {\n      const others",
    suites: [ACTIVATE, REACT],
  },
  {
    id: 'DM-10',
    what: 'transfer skips the restaurant’s approval (anonymous takeover with a valid code)',
    file: ACTIVATE_ROUTE,
    from: '        Boolean(deviceId) &&\n        Boolean(data.transfer_approved_at) &&\n',
    to: '        Boolean(deviceId) &&\n',
    suites: [ACTIVATE],
  },
  {
    id: 'DM-11',
    what: 'the approval is not bound to the device that asked',
    file: ACTIVATE_ROUTE,
    from: "        Boolean(data.transfer_approved_at) &&\n        String(data.transfer_request_device_id ?? '') === deviceId\n",
    to: '        Boolean(data.transfer_approved_at)\n',
    suites: [ACTIVATE],
  },
  {
    id: 'DM-12',
    what: 'an EXPIRED activation code is accepted',
    file: ACTIVATE_ROUTE,
    from: "      .gt('activation_code_expires_at', nowIso)\n",
    to: '',
    marker: "      .eq('active', false)\n      .maybeSingle()",
    suites: [ACTIVATE, REACT],
  },
  {
    id: 'DM-13',
    what: 'an invalid (unknown) activation code is accepted: the code filter is dropped',
    file: ACTIVATE_ROUTE,
    from: "      .eq('activation_code', code)\n",
    to: '',
    marker: "      .eq('active', false)\n      .maybeSingle()",
    suites: [ACTIVATE],
  },
  {
    id: 'DM-14',
    what: 'the refusal writes the OTHER restaurant’s registration (request recorded on the holder)',
    file: ACTIVATE_ROUTE,
    from: "            .eq('id', codeTerminalId)\n            .eq('restaurant_id', codeRestaurantId)\n            .eq('active', false)\n",
    to: "            .eq('id', others[0].id)\n",
    suites: [ACTIVATE, REACT],
  },
  {
    id: 'DM-15',
    what: 'the device list leaks another restaurant’s devices',
    file: LIST_ROUTE,
    from: "      .select(DEVICE_ROW_COLUMNS)\n      .eq('restaurant_id', caller.restaurantId)\n",
    to: '      .select(DEVICE_ROW_COLUMNS)\n',
    suites: [ROUTES],
  },
  {
    id: 'DM-16',
    what: 'a revoked screen is offered Remove-only: its allowed actions stop gating (deactivate offered on a revoked device)',
    file: STATE_LIB,
    from: "  else if (lifecycle !== 'revoked' && lifecycle !== 'never_activated') actions.push('deactivate')\n",
    to: "  else actions.push('deactivate')\n",
    suites: [STATE, ROUTES],
  },
  {
    id: 'DM-17',
    what: 'stale is never shown: an expired session still reads as online/offline',
    file: STATE_LIB,
    from: '  if (!sessionUsable) return \'stale\'\n',
    to: '',
    marker: '  const lastSeen = ms(row.last_seen_at)',
    suites: [STATE],
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
    failures++
    continue
  }
  try {
    let mutated = lf.replace(m.from, m.to)
    if (m.alsoFrom) {
      if (mutated.split(m.alsoFrom).length - 1 !== 1) throw new Error(`${m.id}: second anchor not unique`)
      mutated = mutated.replace(m.alsoFrom, m.alsoTo)
    }
    writeFileSync(path, crlf ? mutated.replace(/\n/g, '\r\n') : mutated)
    const onDisk = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    if (onDisk === lf) throw new Error(`${m.id}: mutation did not land`)
    // Where a mutation DELETES a line, show the line that now follows the gap.
    const shown = m.to || m.marker || ''
    const at = shown ? onDisk.slice(0, onDisk.indexOf(shown)).split('\n').length : '?'
    console.log(`\n${m.id}: ${m.what}\n  ${m.file}:${at} now reads:\n    ${(shown || '(line removed)').trimEnd().split('\n').join('\n    ')}`)
    const r = runJest(m.suites)
    const red = r.status !== 0 && !r.compileFault && /failed/.test(r.summary)
    console.log(`  -> ${red ? 'RED (caught)' : r.compileFault ? 'INSTRUMENT FAULT (compile)' : 'GREEN (NOT CAUGHT)'}  Tests: ${r.summary}`)
    if (r.firstRed) console.log(`     first RED: ${r.firstRed}`)
    if (!red) failures++
  } finally {
    writeFileSync(path, original)
  }
  if (readFileSync(path, 'utf8') !== original) {
    console.error(`RESTORE FAILED: ${m.file}`)
    process.exit(3)
  }
}

const control = runJest([ROUTES, ACTIVATE, REACT, STATE, UI])
console.log(`\nunmutated control: ${control.status === 0 ? 'GREEN' : 'RED'}  Tests: ${control.summary}`)
if (control.status !== 0) failures++

process.exit(failures === 0 ? 0 : 1)
