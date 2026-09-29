#!/usr/bin/env node
/**
 * MUTATION PROOF FOR THE RECONCILIATION FIXES (Sprint 2026-09-29, tasks 4 and 7).
 *
 *   node scripts/mutate-reconcile.mjs            # every mutation
 *   node scripts/mutate-reconcile.mjs R1 C1      # just these
 *
 * Same contract as scripts/mutate-payment-invariants.mjs: each mutation breaks ONE guard, asserts the
 * edit landed on exactly one intended code line (printed back), runs the suites, and requires a real
 * assertion failure -- a suite that fails to COMPILE is an instrument fault, not a kill. Files are
 * restored in `finally` and the unmutated suites must then be GREEN.
 *
 * The SQL half (payment_events.origin CHECKs) is proven by `run-db-tests.mjs --mutate=MO1` / `MO2`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ROUTE = 'app/api/payments/reconcile/route.ts'
const REF = 'lib/payments/reconcile-reference.ts'
const CRON = 'lib/payments/reconcile-orphan-payments.ts'
const SALE = 'app/api/terminal/payment-events/sale/route.ts'
const SUITES = [
  '__tests__/staff-reconcile-reference.test.ts',
  '__tests__/reconcile-orphan-payments-gateway-verified.test.ts',
  '__tests__/terminal-sale-event-origin.test.ts',
]

const MUTATIONS = {
  // ---- task 4: the staff route and the shared reference binder ---------------------------------
  R1: {
    what: 'a reference prepared for OTHER orders (or a subset/superset) is accepted',
    edits: [[REF, '  if (!sameSet(resolved.target.orderIds, requested)) {', '  if (false /* R1 */) {']],
  },
  R3: {
    what: "another venue's order reference is accepted",
    edits: [[REF, '    if (rows.some((r) => String(r.restaurant_id) !== params.restaurantId)) {', '    if (false /* R3 */) {']],
  },
  R4: {
    what: "another venue's intent is accepted",
    edits: [[REF, '    if (intent.restaurantId !== params.restaurantId) {', '    if (false /* R4 */) {']],
  },
  R5: {
    what: 'a reference nothing carries is not refused as unknown',
    edits: [[REF, '    if (rows.length === 0) {', '    if (false /* R5 */) {']],
  },
  R6: {
    what: 'a consumed reference (intent consumed / paid order / verified ledger row) is applied again',
    edits: [[ROUTE, '    if (consumedBefore.consumed) {', '    if (false /* R6 */) {']],
  },
  R7: {
    what: 'a server-verified ledger row no longer counts as consuming the reference',
    edits: [[REF, '  if (verified) {', '  if (false /* R7 */) {']],
  },
  R8: {
    what: "the gateway transaction already on another payment is applied again",
    edits: [[ROUTE, '    if (consumedAfter.consumed) {', '    if (false /* R8 */) {']],
  },
  R9: {
    what: 'a cancelled order is not refused up front',
    edits: [
      [
        ROUTE,
        "      (r) => String(r.status ?? '').toLowerCase() === 'cancelled' || !owesMoney(r.payment_status),",
        '      (r) => false && !owesMoney(r.payment_status),',
      ],
    ],
  },
  R10: {
    what: 'staff reconcile may revive an E04111-auto-cancelled order (both guards removed)',
    edits: [
      [
        ROUTE,
        "      (r) => String(r.status ?? '').toLowerCase() === 'cancelled' || !owesMoney(r.payment_status),",
        '      (r) => false && !owesMoney(r.payment_status),',
      ],
      [ROUTE, '      allowCancelledRecovery: false,', '      allowCancelledRecovery: true,'],
    ],
  },
  R11: {
    what: 'the amount is compared against orders.total, not the projection outstanding',
    edits: [
      [
        ROUTE,
        '      (sum, r) => sum + (loaded.byId.get(String(r.id))?.outstandingCents ?? 0),',
        '      (sum, r) => sum + Math.round(Number(r.total) * 100),',
      ],
    ],
  },
  R12: {
    what: 'any gateway amount is accepted (exact match removed)',
    edits: [
      [
        ROUTE,
        '    const amountVerified = gatewayCents !== null && gatewayCents === expectedCents',
        '    const amountVerified = gatewayCents !== null',
      ],
    ],
  },
  R13: {
    what: 'a second identical reconciliation is not an idempotent no-op',
    edits: [[ROUTE, '    if (paidCount === orderIds.length) {', '    if (false /* R13 */) {']],
  },
  R14: {
    what: 'an unauthorized caller is not refused',
    edits: [
      [ROUTE, '    if (isAuthError(auth)) return auth', '    // R14: auth refusal removed'],
      [
        ROUTE,
        '    const { supabase, restaurantId: callerRestaurantId, userId } = auth',
        '    const { supabase, restaurantId: callerRestaurantId, userId } = auth as any',
      ],
    ],
  },
  R15: {
    what: 'a caller naming another restaurant is not refused',
    edits: [[ROUTE, '    if (restaurantUuid !== callerRestaurantId) {', '    if (false /* R15 */) {']],
  },

  // ---- task 7: the cron and the device sale route ------------------------------------------------
  C1: {
    what: "the authoritative amount is replaced with the DEVICE's amount",
    edits: [
      [
        CRON,
        "      // THE GATEWAY'S FIGURE. Substituting `deviceAmount` here is the task-7 defect.\n      gatewayAmount: finatic.amount,",
        "      // C1\n      gatewayAmount: deviceAmount,",
      ],
    ],
  },
  C2: {
    what: 'gateway verification is skipped (a not-paid answer falls back to the device)',
    edits: [
      [CRON, '    if (!finatic.paid) {', '    if (false /* C2 */) {'],
      [
        CRON,
        "      // THE GATEWAY'S FIGURE. Substituting `deviceAmount` here is the task-7 defect.\n      gatewayAmount: finatic.amount,",
        "      // C2\n      gatewayAmount: finatic.paid ? finatic.amount : deviceAmount,",
      ],
    ],
  },
  C3: {
    what: 'an unavailable gateway is treated as confirming the device amount',
    edits: [
      [
        CRON,
        "        error: err instanceof Error ? err.message : String(err),\n      })\n      continue\n    }\n\n    if (!finatic.paid) {",
        "        error: err instanceof Error ? err.message : String(err),\n      })\n      finatic = { paid: true, statusRecognised: true, merchantOrderNo: merchantNo, status: 'assumed', transactionId: null, amount: deviceAmount, raw: {} }\n    }\n\n    if (!finatic.paid) {",
      ],
    ],
  },
  C4: {
    what: 'a reference already consumed by a verified payment is re-applied by the cron',
    edits: [[CRON, '    if (consumption.consumed) {', '    if (false /* C4 */) {']],
  },
  R16: {
    what: 'the verified order set is not pinned (a re-resolved, different set can be settled)',
    edits: [['lib/payments/settle-whole-order-payment.ts', '    if (!same) {', '    if (false /* R16 */) {']],
  },
  S3: {
    what: "the refund cap for a device row is the device's own reported amount",
    edits: [[SALE, '        saleAmount = saleIntent.amountCents / 100', '        saleAmount = Number(sale.amount)']],
  },
  S4: {
    what: 'a device mismatch row with no intent is refundable up to its reported amount',
    edits: [
      [
        SALE,
        "      } else if (sale.device_amount_check === 'matched_order_totals' || sale.device_amount_check === 'matched_intent') {",
        '      } else if (true /* S4 */) {',
      ],
    ],
  },
  S1: {
    what: "the device's sale row is no longer marked as the device's report",
    edits: [[SALE, "      origin: 'terminal_device' as const,\n", '']],
  },
  S2: {
    what: "another venue's intent becomes the device amount's comparison basis",
    edits: [[SALE, '    if (intent && intent.restaurantId !== terminal.restaurantId) {', '    if (false /* S2 */) {']],
  },
}

function runSuites() {
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/jest/bin/jest.js'), '--ci', ...SUITES], {
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
    killedBy: [...new Set([...out.matchAll(/^\s+● (.+ › .+|[^›\n]+)$/gm)].map((x) => x[1].trim()))]
      .filter((n) => !n.startsWith('Console')),
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
    // Print the mutated line back FROM DISK, so a mutation that landed on a comment is visible.
    // The first CODE line the replacement INTRODUCES -- not a comment (that would prove nothing) and
    // not a line the anchor already contained (that would print unchanged code).
    const fromLines = new Set(from.split('\n').map((l) => l.trim()))
    const probe = (
      to.split('\n').find((l) => l.trim() && !l.trim().startsWith('//') && !fromLines.has(l.trim())) ?? ''
    ).trim()
    const lines = readFileSync(path, 'utf8').split('\n')
    const hit = probe ? lines.findIndex((l) => l.includes(probe)) : -1
    console.log(`    ${file}:${hit >= 0 ? hit + 1 : '?'}: ${hit >= 0 ? lines[hit].trim() : '(line removed)'}`)
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
