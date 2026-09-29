#!/usr/bin/env node
/**
 * MUTATION PROOF FOR TASK 5 -- GUEST EDIT / STAFF VOID DURING A CARD CHARGE (Sprint 2026-09-29).
 *
 *   node scripts/mutate-charge-edit-race.mjs            # every mutation
 *   node scripts/mutate-charge-edit-race.mjs E1 P2      # just these
 *
 * Same contract as scripts/mutate-payment-invariants.mjs (whose runner this copies): each mutation
 * breaks ONE application-side guard, prints the mutated line back from disk, runs the suites, and
 * requires a real assertion failure. Files are restored in `finally`; the unmutated suites must then
 * be GREEN.
 *
 * The DATABASE half -- the FTINF edit lock, the FTCHG read-basis and paid guards, settle block 6d,
 * amend's payment_in_flight -- is proven by `run-db-tests.mjs --mutate=MR1 ... MR6`, including two
 * real Postgres sessions (charge-edit-race.test.sh) for the r-variants.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const EDIT_LOCK = 'lib/orders/edit-lock.ts'
const EDIT_ROUTE = 'app/api/guest/orders/[orderId]/edit/route.ts'
const PREPARE = 'app/api/terminal/orders/[orderId]/prepare-payment/route.ts'
const MARK_PAID = 'lib/payments/mark-order-paid-confirmed.ts'
const SUITES = [
  '__tests__/guest-edit-refused-during-card-charge.test.ts',
  '__tests__/prepare-payment-refuses-a-moved-order.test.ts',
  '__tests__/mark-paid-holds-an-order-changed-mid-charge.test.ts',
]

const MUTATIONS = {
  E1: {
    what: 'the editor ignores a card charge in flight (read-side gate removed)',
    edits: [[EDIT_LOCK, '  if (isChargeInFlight(row, params.nowMs)) {', '  if (false /* E1 */) {']],
  },
  E2: {
    what: 'the in-flight window never ends (an abandoned charge locks the order forever)',
    edits: [[EDIT_LOCK, '  return nowMs - at < PAYMENT_IN_FLIGHT_WINDOW_MS', '  return true /* E2 */']],
  },
  E3: {
    what: "the database's FTINF refusal becomes a 500 instead of payment_in_flight",
    edits: [[EDIT_ROUTE, "    if (writeError && String((writeError as { code?: unknown }).code ?? '') === 'FTINF') {", '    if (false /* E3 */) {']],
  },
  E4: {
    what: "the database's FTLIN refusal (lined order) becomes a 500 instead of not_editable_status",
    edits: [[EDIT_ROUTE, "    if (writeError && String((writeError as { code?: unknown }).code ?? '') === 'FTLIN') {", '    if (false /* E4 */) {']],
  },
  P1: {
    what: 'prepare-payment stops handing the database the basis it read',
    edits: [[PREPARE, "            ...(typeof readBasis === 'string' && readBasis ? { pending_charge_read_basis: readBasis } : {}),", '            /* P1 */']],
  },
  P2: {
    what: 'a refused preparation leaves the already-written expectations behind',
    edits: [[PREPARE, '        if (written.length > 0) {', '        if (false /* P2 */) {']],
  },
  M1: {
    what: 'markOrderPaidConfirmed throws on FTCHG instead of holding and recording',
    edits: [[MARK_PAID, "  if (updateError && String((updateError as { code?: unknown }).code ?? '') === 'FTCHG') {", '  if (false /* M1 */) {']],
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
