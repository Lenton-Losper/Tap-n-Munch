/**
 * Mutation proof for the stale-POS sweep fixes of 2026-10-04 (throttle-read error, E04111 logging,
 * and the sweep's own cancel guard). Each mutation re-introduces one defect, the targeted suite is
 * run, and the mutation must turn it RED. The source is restored after every mutation, including
 * on failure.
 *
 * Anchors are single lines so a CRLF checkout cannot make a multi-line anchor silently miss; every
 * mutation asserts it matched EXACTLY once and prints the mutated line back.
 *
 *   node scripts/mutate-stale-sweep-throttle.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SRC = 'lib/orders/auto-cancel-stale-pos-orders.ts'
const LOGGING_TEST = '__tests__/stale-pos-throttle-read-and-e04111-logging.test.ts'
const RACE_TEST = '__tests__/stale-sweep-never-overwrites-a-settled-order.test.ts'

const MUTATIONS = [
  {
    id: 'M1',
    what: 'throttle read discards its error again',
    from: '    if (priorSkipsError) throw priorSkipsError',
    to: '    void priorSkipsError',
    test: LOGGING_TEST,
  },
  {
    id: 'M2',
    what: 'catch logs the bare object again (cause lost as [object Object])',
    from: '      `[autoCancelStalePosOrders] could not read prior skip audit rows; probing every candidate: ${cause}`,',
    to: "      '[autoCancelStalePosOrders] could not read prior skip audit rows; probing every candidate:', probeReadErr as never,",
    test: LOGGING_TEST,
  },
  {
    id: 'M3',
    what: 'E04111 logged as "Finatic check failed" at error again',
    from: '      if (e04111) {',
    to: '      if (false) {',
    test: LOGGING_TEST,
  },
  {
    id: 'M4',
    what: 'every gateway failure reclassified as E04111 (real failures silenced to warn)',
    from: '      if (e04111) {',
    to: '      if (true) {',
    test: LOGGING_TEST,
  },
  {
    id: 'M5',
    what: "the sweep's cancel loses its still-pending re-assertion",
    from: "    .eq('payment_status', 'pending') // re-assert: a concurrent terminal callback wins the race",
    to: '    // (guard removed by mutation)',
    test: RACE_TEST,
  },
]

const original = readFileSync(SRC, 'utf8')
const jest = (file) =>
  spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', file, '--silent'], { encoding: 'utf8' })

let failures = 0
try {
  // Control: the unmutated source is GREEN on both suites, or a RED below proves nothing.
  for (const t of [LOGGING_TEST, RACE_TEST]) {
    const r = jest(t)
    const line = (r.stderr + r.stdout).match(/Tests:.*$/m)?.[0] ?? '(no summary)'
    console.log(`CONTROL ${t}: ${r.status === 0 ? 'GREEN' : 'RED'}  ${line}`)
    if (r.status !== 0) failures++
  }
  for (const m of MUTATIONS) {
    const count = original.split(m.from).length - 1
    if (count !== 1) {
      console.log(`${m.id} ANCHOR MATCHED ${count} TIMES -- mutation not applied: ${m.what}`)
      failures++
      continue
    }
    const mutated = original.replace(m.from, m.to)
    writeFileSync(SRC, mutated)
    const landed = mutated.split(/\r?\n/).find((l) => l === m.to.split('\n')[0])
    const r = jest(m.test)
    const summary = (r.stderr + r.stdout).match(/Tests:.*$/m)?.[0] ?? '(no summary)'
    const red = r.status !== 0 && /failed/.test(summary)
    console.log(`${m.id} ${red ? 'RED (caught)' : 'GREEN (MISSED)'}  ${summary}  -- ${m.what}`)
    console.log(`     mutated line: ${landed?.trim()}`)
    if (!red) failures++
    writeFileSync(SRC, original)
  }
} finally {
  writeFileSync(SRC, original)
}
console.log(failures === 0 ? 'ALL MUTATIONS CAUGHT, CONTROLS GREEN' : `${failures} PROBLEM(S)`)
process.exit(failures === 0 ? 0 : 1)
