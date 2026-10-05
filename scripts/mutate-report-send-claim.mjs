/**
 * Mutation proof for the send-scheduled-reports claim (2026-10-05). Each mutation re-introduces one
 * defect; the claim suite must go RED. Source restored every time, including on failure.
 * Single-line anchors (CRLF-safe), each asserted to match exactly once.
 *
 *   node scripts/mutate-report-send-claim.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SRC = 'app/api/cron/send-scheduled-reports/route.ts'
const TEST = '__tests__/send-scheduled-reports-claim.test.ts'

const MUTATIONS = [
  {
    id: 'C1',
    what: 'a failed or conflicting claim is ignored and the email is sent anyway',
    from: '    if (claimError || !claim?.id) {',
    to: '    if (false) {',
  },
  {
    id: 'C2',
    what: 'a failed send does not release its claim, so the period is never retried',
    from: "        .update({ status: 'failed', error: message, duration_ms: duration })",
    to: "        .update({ error: message, duration_ms: duration })",
  },
  {
    id: 'C3',
    what: 'a claim that could not be released is no longer surfaced',
    from: '          claimReleaseFailed: Boolean(logInsertError),',
    to: '          claimReleaseFailed: false,',
  },
]

const original = readFileSync(SRC, 'utf8')
const jest = () => spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', TEST, '--silent'], { encoding: 'utf8' })
const summary = (r) => (r.stderr + r.stdout).match(/Tests:.*$/m)?.[0] ?? '(no summary)'

let failures = 0
try {
  const c = jest()
  console.log(`CONTROL ${TEST}: ${c.status === 0 ? 'GREEN' : 'RED'}  ${summary(c)}`)
  if (c.status !== 0) failures++
  for (const m of MUTATIONS) {
    const count = original.split(m.from).length - 1
    if (count !== 1) {
      console.log(`${m.id} ANCHOR MATCHED ${count} TIMES -- not applied: ${m.what}`)
      failures++
      continue
    }
    writeFileSync(SRC, original.replace(m.from, m.to))
    const r = jest()
    const red = r.status !== 0 && /failed/.test(summary(r))
    console.log(`${m.id} ${red ? 'RED (caught)' : 'GREEN (MISSED)'}  ${summary(r)}  -- ${m.what}`)
    console.log(`     mutated line: ${m.to.trim()}`)
    if (!red) failures++
    writeFileSync(SRC, original)
  }
} finally {
  writeFileSync(SRC, original)
}
console.log(failures === 0 ? 'ALL MUTATIONS CAUGHT, CONTROL GREEN' : `${failures} PROBLEM(S)`)
process.exit(failures === 0 ? 0 : 1)
