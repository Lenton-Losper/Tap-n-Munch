/**
 * BEFORE/AFTER for a latency suite (perf/latency-sprint, 2026-10-01).
 *
 * Puts the BASE commit's version of the named source files in place, runs the suite, restores the
 * working versions, runs it again, and prints every `[latency]` line from both runs side by side.
 * The working files are restored whatever happens, and the swap holds the same exclusive
 * .source-mutation.lock as the mutation runners, so two source-rewriting runs cannot interleave.
 *
 *   node scripts/perf/measure-at-base.mjs <suite> <source> [<source>...] [--base=682a2b2e]
 *
 * A test failing at base is expected (the latency bound is the AFTER figure); the [latency] line is
 * printed before the assertion. No main-module guard on purpose (Windows file:// mismatch).
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const JEST = join(ROOT, 'node_modules', 'jest', 'bin', 'jest.js')
const args = process.argv.slice(2)
const BASE = (args.find((a) => a.startsWith('--base=')) ?? '--base=682a2b2e').slice('--base='.length)
const [suite, ...sources] = args.filter((a) => !a.startsWith('--'))
if (!suite || sources.length === 0) {
  console.error('usage: measure-at-base.mjs <suite> <source> [<source>...] [--base=<ref>]')
  process.exit(2)
}

const LOCK = join(ROOT, '.source-mutation.lock')
try {
  writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' })
} catch {
  console.error(`refusing: ${LOCK} exists -- another run is rewriting sources`)
  process.exit(4)
}
process.on('exit', () => {
  try {
    rmSync(LOCK)
  } catch {}
})

const run = () => {
  const r = spawnSync(process.execPath, [JEST, '--forceExit', suite], { cwd: ROOT, encoding: 'utf8' })
  const out = `${r.stdout}\n${r.stderr}`
  return {
    lines: [...out.matchAll(/\[latency\][^\n]*/g)].map((m) => m[0]),
    summary: (/Tests:\s+([^\n]+)/.exec(out) ?? [, '(no Tests: line)'])[1],
  }
}

const working = new Map(sources.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]))
let before
try {
  for (const f of sources) {
    writeFileSync(join(ROOT, f), execFileSync('git', ['show', `${BASE}:${f}`], { cwd: ROOT, encoding: 'utf8' }))
  }
  before = run()
} finally {
  for (const [f, text] of working) writeFileSync(join(ROOT, f), text)
}
for (const [f, text] of working) {
  if (readFileSync(join(ROOT, f), 'utf8') !== text) {
    console.error(`RESTORE FAILED: ${f}`)
    process.exit(3)
  }
}
const after = run()
console.log(`BEFORE (${BASE})  Tests: ${before.summary}`)
for (const l of before.lines) console.log(`  ${l}`)
console.log(`AFTER (working)  Tests: ${after.summary}`)
for (const l of after.lines) console.log(`  ${l}`)
