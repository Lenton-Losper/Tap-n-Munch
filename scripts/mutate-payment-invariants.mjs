#!/usr/bin/env node
/**
 * MUTATION PROOF FOR THE PAYMENT-INVARIANT FIXES N1-N3 (Sprint 2026-09-28).
 *
 *   node scripts/mutate-payment-invariants.mjs            # every mutation
 *   node scripts/mutate-payment-invariants.mjs N1a N2a    # just these
 *
 * Same contract as scripts/mutate-invoice-projection.mjs: each mutation breaks ONE guard, asserts the
 * edit landed on exactly one intended code line (printed back), runs the suites, and requires a real
 * assertion failure -- a suite that fails to COMPILE is an instrument fault, not a kill. Files are
 * restored in `finally` and the unmutated suites must then be GREEN.
 *
 * The SQL half of N3 (settle_order_payment block 6c) is proven by `run-db-tests.mjs --mutate=MP1`
 * and `--mutate=MP2`, not here.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const STATUS_ROUTE = 'app/api/orders/[orderId]/status/route.ts'
const MANUAL = 'lib/payments/mark-order-paid-manually.ts'
const TAB_SETTLE = 'app/api/terminal/tabs/[tabId]/settle/route.ts'
const PREPARE = 'app/api/terminal/orders/[orderId]/prepare-payment/route.ts'
const ELSEWHERE = 'lib/payments/paid-by-another-payment.ts'
const SETTLE_HELPER = 'lib/payments/settle-whole-order-payment.ts'
const WEBHOOK = 'app/api/webhooks/paycloud/route.ts'
const SUITES = [
  '__tests__/orders-status-payment-invariants.test.ts',
  '__tests__/tab-settle-claim-all-or-nothing.test.ts',
  '__tests__/paid-by-another-payment.test.ts',
]

const MUTATIONS = {
  N1a: {
    what: 'the status route writes any payment_status again (paid -> pending allowed)',
    edits: [[STATUS_ROUTE, "    if (nextPayment !== 'cancelled') {", '    if (false /* N1a */) {']],
  },
  N1b: {
    what: 'a manual payment is kept when its audit row could not be written (no trail)',
    edits: [[MANUAL, '  if (!auditWritten) {', '  if (false /* N1b */) {']],
  },
  N1c: {
    what: 'a cancelled order can be marked paid by hand',
    edits: [
      [MANUAL, "  if (from === 'cancelled') {", '  if (false /* N1c */) {'],
      [MANUAL, "  if (!isCashSettleablePaymentStatus(from) || !canTransition(from, 'paid').ok) {", '  if (false /* N1c */) {'],
    ],
  },
  N1d: {
    what: 'the payment method defaults to cash instead of being required',
    edits: [
      [
        MANUAL,
        '  const method = normalizeSettlementPaymentMethod(params.method)',
        "  const method = normalizeSettlementPaymentMethod(params.method) ?? ('cash' as const)",
      ],
    ],
  },
  N1e: {
    what: 'the manual amount is orders.total, not the live outstanding figure',
    edits: [[MANUAL, '    amountCents = financials.outstandingCents', '    amountCents = financials.originalCents']],
  },
  N1f: {
    what: 'a held-for-review or in-flight order can be marked paid by hand',
    edits: [
      [MANUAL, '  if (isHeldForReviewPaymentStatus(from)) {', '  if (false /* N1f */) {'],
      [MANUAL, '  if (isMidFlightCardPayment(from)) {', '  if (false /* N1f */) {'],
      [MANUAL, "  if (!isCashSettleablePaymentStatus(from) || !canTransition(from, 'paid').ok) {", '  if (false /* N1f */) {'],
    ],
  },
  N2a: {
    what: 'a partial tab-settle claim is left paid (the pre-fix 409)',
    edits: [
      [
        TAB_SETTLE,
        '      for (const id of claimedIds) {\n        const prior = priorById.get(id)',
        '      for (const id of [] as string[]) {\n        const prior = priorById.get(id)',
      ],
    ],
  },
  N2b: {
    what: 'the claim conflict (card charged, nothing settled) is not written down',
    edits: [[TAB_SETTLE, "        action: 'payment.settle_claim_conflict',", "        action: 'payment.n2b_mutated',"]],
  },
  N3a: {
    what: 'prepare-payment checks only the lead order again',
    edits: [[PREPARE, '      if (notClaimable.length > 0) {', '      if (false /* N3a */) {']],
  },
  N3b: {
    what: 'cash taken elsewhere is read as this charge (method clause removed)',
    edits: [[ELSEWHERE, '      (rowMethod !== null && rowMethod !== method) ||', '      false ||']],
  },
  N3c: {
    what: "the RPC's hold is reported as a retryable intent conflict (webhook would retry forever)",
    edits: [
      [
        SETTLE_HELPER,
        "            : result.reason === 'order_paid_by_other_payment'\n              ? 'paid_elsewhere'\n",
        '',
      ],
    ],
  },
  N3d: {
    what: 'the webhook stops treating paid_elsewhere as permanent',
    edits: [[WEBHOOK, "    settled.reason === 'paid_elsewhere'", '    false']],
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
