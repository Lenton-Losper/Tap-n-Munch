#!/usr/bin/env node
/**
 * MUTATION PROOF FOR THE PROJECTION-DERIVED INVOICE (Sprint 2026-09-28).
 *
 *   node scripts/mutate-invoice-projection.mjs            # every mutation
 *   node scripts/mutate-invoice-projection.mjs M2 M3      # just these
 *
 * Each mutation breaks ONE guard in the source, asserts the edit landed on the intended code line
 * (exactly one match, printed back), runs the invoice suites, and requires them to go RED with a
 * real assertion failure -- a suite that fails to COMPILE is reported as an instrument fault, not a
 * kill, because ts-jest turns a broken file into "Test suite failed to run" and that proves nothing
 * about the guard. The file is restored in `finally`, and the unmutated suites must then be GREEN.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PROJECTION = 'lib/documents/invoice-projection.ts'
const ENGINE = 'lib/documents/create-invoice-from-order.ts'
const SUITES = ['__tests__/invoice-from-projection.test.ts', '__tests__/invoice-from-order.test.ts']

const MUTATIONS = {
  M1: {
    what: 'the OLD engine: bill voided lines AND take the total from orders.total (original)',
    edits: [
      [PROJECTION, '      if (f.cancelled || line.voided) {', '      if (f.cancelled) {'],
      [PROJECTION, "  const liveCents = sum('liveCents')", '  const liveCents = perOrder.reduce((s, f) => s + f.originalCents, 0)'],
    ],
  },
  M2: {
    what: 'drop the voided-line exclusion (voided lines billed)',
    edits: [[PROJECTION, '      if (f.cancelled || line.voided) {', '      if (f.cancelled) {']],
  },
  M3: {
    what: 'balance = total for a paid tab (no payments recorded, balance check off)',
    edits: [
      [ENGINE, '  if (payments.length > 0) {', '  if (false && payments.length > 0) {'],
      [ENGINE, '  if (Math.round(recomputed.balance * 100) !== plan.outstandingCents) {', '  if (false /* M3 */) {'],
    ],
  },
  M4: {
    what: 'ignore the amend window (an unstarted item no longer blocks the invoice)',
    edits: [[PROJECTION, '  const open = own.filter(isAmendableLine).length', '  const open = 0']],
  },
  M5: {
    what: 'drop the OVERPAID refusal',
    edits: [[PROJECTION, '  if (overpaidCents > 0) {', '  if (false /* M5 */) {']],
  },
  M6: {
    what: 'uniqueness ignores order_ids (an order already on a tab invoice can be invoiced again)',
    edits: [[ENGINE, 'docOrderIds.some((id) => covered.has(id))', 'false /* M6 */']],
  },
  M7: {
    what: 'payment rows not sized from the projection (inflated wherever a sale event exists)',
    edits: [[PROJECTION, '        wholeOrderCents,\n        event?.created_at', '        wholeOrderCents * (events.length > 0 ? 2 : 1),\n        event?.created_at']],
  },
}

function runSuites() {
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/jest/bin/jest.js'), ...SUITES], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const out = `${r.stdout}\n${r.stderr}`
  const failed = /Tests:\s+(\d+) failed/.exec(out)
  return {
    status: r.status,
    failedCount: failed ? Number(failed[1]) : 0,
    compileFault: /Test suite failed to run/.test(out),
    summary: (/Tests:.*$/m.exec(out) ?? ['(no summary)'])[0],
    // The failure headers name exactly which assertions caught the mutation.
    killedBy: [...new Set([...out.matchAll(/^\s+● (.+ › .+)$/gm)].map((x) => x[1].trim()))],
  }
}

function apply(edits) {
  const originals = new Map()
  for (const [file, from, to] of edits) {
    const path = join(ROOT, file)
    const src = originals.get(path) ?? readFileSync(path, 'utf8')
    if (!originals.has(path)) originals.set(path, src)
    const current = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    const count = current.split(from).length - 1
    if (count !== 1) throw new Error(`${file}: expected exactly 1 match for ${JSON.stringify(from)}, found ${count}`)
    writeFileSync(path, current.replace(from, to))
    const line = readFileSync(path, 'utf8').split('\n').find((l) => l.includes(to.split('\n')[0].trim()))
    console.log(`    ${file}: ${line?.trim()}`)
  }
  return () => {
    for (const [path, src] of originals) writeFileSync(path, src)
  }
}

const wanted = process.argv.slice(2)
const ids = wanted.length ? wanted : Object.keys(MUTATIONS)
let bad = 0
for (const id of ids) {
  const m = MUTATIONS[id]
  if (!m) throw new Error(`unknown mutation ${id}`)
  console.log(`${id}: ${m.what}`)
  const restore = apply(m.edits)
  try {
    const r = runSuites()
    if (r.compileFault) {
      console.log(`  INSTRUMENT FAULT (suite failed to compile) -- ${r.summary}`)
      bad += 1
    } else if (r.failedCount > 0) {
      console.log(`  RED (killed) -- ${r.summary}`)
      for (const name of r.killedBy) console.log(`      x ${name}`)
    } else {
      console.log(`  SURVIVED -- ${r.summary}`)
      bad += 1
    }
  } finally {
    restore()
  }
}

const clean = runSuites()
console.log(`unmutated: ${clean.failedCount === 0 && clean.status === 0 ? 'GREEN' : 'NOT GREEN'} -- ${clean.summary}`)
if (bad > 0 || clean.status !== 0) process.exit(1)
