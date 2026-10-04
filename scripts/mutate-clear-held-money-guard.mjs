/**
 * Mutation proof for the Held-for-review "Clear all" money guard (owner decision 2026-10-04).
 * Each mutation re-introduces one defect; the clear suite must go RED. Source restored every time,
 * including on failure. Single-line anchors (CRLF-safe), each asserted to match exactly once.
 *
 *   node scripts/mutate-clear-held-money-guard.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SRC = 'lib/orders/clear-held-for-review.ts'
const TEST = '__tests__/clear-held-for-review.test.ts'

const MUTATIONS = [
  {
    id: 'G1',
    what: 'the guard is removed -- money recorded no longer stops the cancel',
    from: '  if (moneyHeld === null || moneyHeld.has(orderId)) {',
    to: '  if (false) {',
  },
  {
    id: 'G2',
    what: 'an unreadable payment state is treated as "no money"',
    from: '  if (moneyHeld === null || moneyHeld.has(orderId)) {',
    to: '  if (moneyHeld !== null && moneyHeld.has(orderId)) {',
  },
  {
    id: 'G3',
    what: 'the guard asks about the wrong order (an empty id list)',
    from: '  const moneyHeld = await findOrdersWithMoney(supabase as never, [orderId])',
    to: '  const moneyHeld = await findOrdersWithMoney(supabase as never, [])',
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
