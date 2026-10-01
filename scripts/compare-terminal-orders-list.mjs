/**
 * EQUIVALENCE CHECK: GET /api/terminal/orders with no parameters -- what every P5 in the field
 * polls -- must return byte-identical JSON before and after perf/latency-sprint.
 *
 * Puts the BASE commit's versions of the changed source files in place, runs the FNB-scale
 * "returns exactly..." test with LIST_DUMP set, restores the working versions, runs it again, and
 * compares the two bodies. The working files are restored whatever happens.
 *
 *   node scripts/compare-terminal-orders-list.mjs [base-ref]     # default 682a2b2e
 *
 * No main-module guard on purpose: on Windows the file:// comparison never matches and the script
 * would exit 0 having run nothing.
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js')
const BASE = process.argv[2] ?? '682a2b2e'
const SOURCES = [
  'app/api/terminal/orders/route.ts',
  'lib/payments/get-payment-projection.ts',
  'lib/supabase/fetch-all-rows.ts',
]

// Same exclusive lock as mutate-terminal-orders-list-latency.mjs: both rewrite these sources.
const LOCK = join(ROOT, '.source-mutation.lock')
try {
  writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
} catch {
  console.error(`refusing: ${LOCK} exists -- another mutation/compare run is rewriting sources`)
  process.exit(4)
}
process.on('exit', () => {
  try {
    rmSync(LOCK)
  } catch {}
})

const working = new Map(SOURCES.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
const restore = () => {
  for (const [f, text] of working) writeFileSync(join(ROOT, f), text)
}

function dump(tag) {
  const out = join(tmpdir(), `terminal-orders-list-${tag}-${process.pid}.json`)
  if (existsSync(out)) rmSync(out)
  const r = spawnSync(
    process.execPath,
    [JEST, '--forceExit', '__tests__/terminal-orders-list-latency.test.ts', '-t', 'returns exactly'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LIST_DUMP: out } },
  )
  const summary = (/Tests:\s+([^\n]+)/.exec(`${r.stdout}\n${r.stderr}`) ?? [, '(no Tests: line)'])[1]
  if (!existsSync(out)) throw new Error(`${tag}: no dump written (Tests: ${summary})`)
  const body = readFileSync(out, 'utf8')
  rmSync(out)
  return { body, summary }
}

let base
let head
try {
  for (const f of SOURCES) {
    writeFileSync(join(ROOT, f), execFileSync('git', ['show', `${BASE}:${f}`], { cwd: ROOT, encoding: 'utf8' }))
  }
  base = dump('base')
} finally {
  restore()
}
for (const [f, text] of working) {
  if (readFileSync(join(ROOT, f), 'utf8') !== text) {
    console.error(`RESTORE FAILED: ${f}`)
    process.exit(3)
  }
}
head = dump('head')

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const orders = (s) => JSON.parse(s).orders.length
console.log(`base ${BASE}: ${orders(base.body)} orders, ${base.body.length} bytes, sha256 ${sha(base.body)}  (Tests: ${base.summary})`)
console.log(`head        : ${orders(head.body)} orders, ${head.body.length} bytes, sha256 ${sha(head.body)}  (Tests: ${head.summary})`)
if (base.body !== head.body) {
  console.error('DIFFERENT: the legacy response changed')
  process.exit(1)
}
console.log('IDENTICAL')
