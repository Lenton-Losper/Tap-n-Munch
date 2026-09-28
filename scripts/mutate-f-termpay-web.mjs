#!/usr/bin/env node
/**
 * MUTATION PROOF FOR F-TERMPAY'S WEB HALF (Sprint 2026-09-29).
 *
 *   node scripts/mutate-f-termpay-web.mjs          # every mutation
 *   node scripts/mutate-f-termpay-web.mjs W1 W3    # just these
 *
 * Task 3: prepare-payment's SETTLEMENT_SET_NOT_CLAIMABLE names a typed reason per refused order.
 * Task 8: GET /api/terminal/orders carries each order's C1 projection, batched and fail-soft.
 *
 * Runner copied from scripts/mutate-payment-invariants.mjs: each mutation breaks ONE guard, prints
 * the edited line back from disk, requires a real assertion failure (a compile failure is an
 * instrument fault), restores in `finally`, and the unmutated suites must then be GREEN.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const PREPARE = 'app/api/terminal/orders/[orderId]/prepare-payment/route.ts'
const LIST = 'app/api/terminal/orders/route.ts'
const SUITES = [
  '__tests__/prepare-payment-not-claimable-reasons.test.ts',
  '__tests__/terminal-orders-list-financials.test.ts',
]

const MUTATIONS = {
  W1: {
    what: 'a held order is reported to the terminal as paid',
    edits: [[PREPARE, "        if (isHeldForReviewPaymentStatus(ps)) return 'held'", "        if (isHeldForReviewPaymentStatus(ps)) return 'paid'"]],
  },
  W2: {
    what: 'an order cancelled by status (payment still pending) is no longer refused',
    edits: [[PREPARE, "        if (ps === 'cancelled' || st === 'cancelled') return 'cancelled'", "        if (ps === 'cancelled') return 'cancelled'"]],
  },
  W3: {
    what: 'the order list stops carrying financials (the card falls back to the stored total)',
    edits: [[LIST, '        ...(money ? { financials: money } : {}),', '        ...({}),']],
  },
  W4: {
    what: 'a financials read failure fails the whole list (not fail-soft)',
    edits: [
      [
        LIST,
        "    } catch (e) {\n      console.error('[terminal/orders] financials unreadable",
        "    } catch (e) {\n      if (e) throw e\n      console.error('[terminal/orders] financials unreadable",
      ],
    ],
  },
  W5: {
    what: 'the projection is read once per order (N+1)',
    edits: [[LIST, 'const FINANCIALS_BATCH = 200', 'const FINANCIALS_BATCH = 1']],
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
    killedBy: [...new Set([...out.matchAll(/^\s+● (.+ › .+)$/gm)].map((x) => x[1].trim()))],
  }
}

function apply(edits) {
  const originals = new Map()
  for (const [file, from, to] of edits) {
    const path = join(ROOT, file)
    if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'))
    const current = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    const count = current.split(from).length - 1
    if (count !== 1) throw new Error(`${file}: expected exactly 1 match for ${JSON.stringify(from)}, found ${count}`)
    writeFileSync(path, current.replace(from, to))
    const probe = (to.split('\n')[0] || from.split('\n')[1] || '').trim()
    const lines = readFileSync(path, 'utf8').split('\n')
    const line = probe
      ? (lines.find((l) => l.trim() === probe) ?? lines.find((l) => l.includes(probe)))
      : null
    console.log(`    ${file}: ${line?.trim() ?? '(removed)'}`)
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
