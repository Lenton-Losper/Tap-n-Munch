#!/usr/bin/env node
/**
 * MUTATION PROOF FOR THE SPRINT 2026-09-29 F-MANUAL GUARDS: the non-gateway ledger, the paid-order
 * cancel refusal, and the tab-settle ledger tip.
 *
 *   node scripts/mutate-manual-ledger.mjs            # every mutation
 *   node scripts/mutate-manual-ledger.mjs FM1 FM4    # just these
 *
 * Same contract as scripts/mutate-payment-invariants.mjs: each mutation breaks ONE guard, asserts
 * every edit landed on exactly one intended code line (printed back), runs the suites, and requires
 * a real assertion failure -- a suite that fails to COMPILE is an instrument fault, not a kill.
 * Every mutation is written to stay type-correct for exactly that reason. Files are restored in
 * `finally` and the unmutated suites must then be GREEN.
 *
 * The SQL half -- the ledger write inside record_manual_order_payment, its restaurant scoping, the
 * idempotency key, the immutability triggers and the grants -- is proven against real Postgres by
 * `FT_TEST_DB=<db> node supabase/tests/run-db-tests.mjs --mutate=ML1` .. `ML6`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const STATUS_ROUTE = 'app/api/orders/[orderId]/status/route.ts'
const TERMINAL_STATUS = 'app/api/terminal/orders/[orderId]/status/route.ts'
const MANUAL = 'lib/payments/mark-order-paid-manually.ts'
const GUARD = 'lib/orders/paid-order-cancellation.ts'
const TRAIL = 'lib/orders/cancel-order-with-trail.ts'
const TAB_SETTLE = 'app/api/terminal/tabs/[tabId]/settle/route.ts'
const ALLOC_SETTLE = 'app/api/terminal/tabs/[tabId]/settle-allocations/route.ts'
const ORDER_PAYMENT = 'app/api/terminal/orders/[orderId]/payment/route.ts'
const AUTO_CANCEL = 'lib/orders/auto-cancel-stale-pos-orders.ts'
const EXPIRE_HOSTED = 'lib/orders/expire-hosted-pending-orders.ts'
const PAYMENT_FAILED = 'lib/payments/handle-terminal-payment-failed.ts'
const FINANCIALS = 'lib/orders/order-financials.ts'
const SUITES = [
  '__tests__/orders-status-payment-invariants.test.ts',
  '__tests__/orders-status-paid-cancel.test.ts',
  '__tests__/tab-settle-ledger-tip.test.ts',
  '__tests__/tab-settle-allocations-route.test.ts',
  '__tests__/terminal-order-payment-non-gateway-ledger.test.ts',
  '__tests__/auto-cancel-never-over-money.test.ts',
  '__tests__/order-financials-refunds.test.ts',
]

const MUTATIONS = {
  FM1: {
    what: 'Mark-as-Paid records the CLIENT body amount instead of the server outstanding figure',
    edits: [
      [
        STATUS_ROUTE,
        '        currentPaymentStatus: existingOrder.payment_status,\n      })',
        '        currentPaymentStatus: existingOrder.payment_status,\n        clientAmount: body?.amount,\n      } as never)',
      ],
      [
        MANUAL,
        '      p_amount_cents: amountCents,',
        '      p_amount_cents: Math.round(Number((params as unknown as { clientAmount?: unknown }).clientAmount ?? 0) * 100) || amountCents,',
      ],
    ],
  },
  FM2: {
    what: 'the staff status route no longer consults the permission check (any caller, any venue)',
    edits: [
      [
        STATUS_ROUTE,
        '  const auth = await requireStaffPermission(\n',
        "  const auth = await ((..._a: unknown[]) => Promise.resolve({ userId: '55555555-5555-4555-8555-555555555555', restaurantId: '' } as unknown as Awaited<ReturnType<typeof requireStaffPermission>>))(\n",
      ],
    ],
  },
  FM3: {
    what: 'the dashboard cancel skips the paid-order check (a paid order is cancelled over its payment)',
    edits: [
      [
        STATUS_ROUTE,
        "  if (status === 'cancelled') {\n    const moneyCheck",
        "  if (status === 'cancelled' && (false as boolean)) {\n    const moneyCheck",
      ],
    ],
  },
  FM3b: {
    what: 'the guard itself reads no money: paid, part-paid and card-sale branches all removed',
    edits: [
      [GUARD, '  if (sale) {', '  if (sale && (false as boolean)) {'],
      [GUARD, '  if (paid) {', '  if (paid && (false as boolean)) {'],
      [GUARD, '  if (settledAllocations > 0 || nonGatewayRows > 0) {', '  if (false as boolean) {'],
    ],
  },
  FM4: {
    what: "a refunded order's cancel overwrites payment_status with 'cancelled' (payment history erased)",
    edits: [
      [STATUS_ROUTE, "      if (!preservePaymentStatus) patch.payment_status = 'cancelled'", "      patch.payment_status = 'cancelled'"],
    ],
  },
  FM5: {
    what: 'the terminal cancel does not tell the guard the order is paid',
    edits: [[TERMINAL_STATUS, '        paymentStatus: order.payment_status,\n', "        paymentStatus: 'pending',\n"]],
  },
  FM6: {
    what: "cancelOrderWithTrail guard 'none' matches a paid order again (no race backstop)",
    edits: [[TRAIL, "  if (params.guard === 'none' && !params.preservePaymentStatus) {", '  if (false as boolean) {']],
  },
  FM7: {
    what: 'a cash / PayToday tab settlement writes no ledger row',
    edits: [
      [
        TAB_SETTLE,
        '    if (!usesGateway) {\n      const ledger = await recordNonGatewayPaymentEvent(',
        '    if (false as boolean) {\n      const ledger = await recordNonGatewayPaymentEvent(',
      ],
    ],
  },
  FM8: {
    what: 'a failed tab-settle ledger write leaves the orders paid (no ledger, still settled)',
    edits: [
      [
        TAB_SETTLE,
        '        for (const id of claimedIds) {\n          const prior = priorById.get(id) as Record<string, unknown> | undefined\n          const { data: undone',
        '        for (const id of [] as string[]) {\n          const prior = priorById.get(id) as Record<string, unknown> | undefined\n          const { data: undone',
      ],
    ],
  },
  FM9: {
    what: 'the tab-settle ledger row takes the CLIENT amount',
    edits: [[TAB_SETTLE, '        billCents: expectedCents,', '        billCents: Math.round(amount * 100),']],
  },
  FM10: {
    what: 'task 3 reverted: the card sale row records the bill without the gratuity',
    edits: [
      [
        TAB_SETTLE,
        '        amount: roundToCents(centsToMajor(expectedCents + tipCents)),',
        '        amount: expectedAmount,',
      ],
    ],
  },
  FM11: {
    what: 'a cash item-split settlement writes no event-level ledger row',
    edits: [
      [
        ALLOC_SETTLE,
        "    if (method === 'cash') {\n      const ledger = await recordNonGatewayPaymentEvent(",
        '    if (false as boolean) {\n      const ledger = await recordNonGatewayPaymentEvent(',
      ],
    ],
  },
  FM12: {
    what: 'a cash success on the single-order terminal callback writes no ledger row',
    edits: [[ORDER_PAYMENT, '      if (!methodUsesGateway(paymentMethod)) {', '      if (false as boolean) {']],
  },
  FM13: {
    what: 'the stale-POS sweep cancels orders with money on them again',
    edits: [[AUTO_CANCEL, '  const cancellableIds = ids.filter((id) => !moneyHeld.has(String(id)))', '  const cancellableIds = ids']],
  },
  FM14: {
    what: 'the hosted-checkout expiry cancels orders with money on them again',
    edits: [[EXPIRE_HOSTED, '  const cancellableIds = candidateIds.filter((id) => !moneyHeld.has(id))', '  const cancellableIds = candidateIds']],
  },
  FM15: {
    what: 'the terminal payment-failed path cancels an order with money on it again',
    edits: [[PAYMENT_FAILED, '  if (moneyHeld === null || moneyHeld.has(params.orderId)) {', '  if (false as boolean) {']],
  },
  FM16: {
    what: 'the money check FAILS OPEN: an unreadable ledger reads as "no money"',
    edits: [[GUARD, '    return null\n  }\n  return withMoney', '    return new Set<string>()\n  }\n  return withMoney']],
  },
  FM17: {
    what: 'the financial projection ignores refunds again (refund-then-cancel reads as overpaid)',
    edits: [[FINANCIALS, '  const refundedCents = Math.min(paidCents, Math.round(paidCents * fraction))', '  const refundedCents = Math.min(0, fraction)']],
  },
  FM18: {
    what: 'a cash / PayToday tab settle no longer asks about card attempts before claiming',
    edits: [[TAB_SETTLE, '    if (!usesGateway && (tabOrders ?? []).some(', '    if ((false as boolean) && (tabOrders ?? []).some(']],
  },
  FM19: {
    what: "the tab settle ignores the release's in-flight refusal",
    edits: [[TAB_SETTLE, '      if (released.ok !== true) {', '      if (false as boolean) {']],
  },
  FM20: {
    what: 'a card tab settle refused FTCHG is a 500 again (orders not held)',
    edits: [[TAB_SETTLE, "    if (ordersError && String((ordersError as { code?: unknown }).code ?? '') === 'FTCHG') {", '    if (false as boolean) {']],
  },
  FM21: {
    what: 'Mark-as-Paid no longer reports a card attempt in flight as PAYMENT_IN_FLIGHT',
    edits: [[MANUAL, "      case 'payment_in_flight':", "      case 'payment_in_flight_disabled':"]],
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
    // PRINT THE MUTATED LINE BACK FROM DISK, so a mutation that landed on a comment is visible.
    const probe = to.split('\n').map((l) => l.trim()).find((l) => l && !from.split('\n').map((x) => x.trim()).includes(l))
      ?? to.split('\n')[0].trim()
    const lines = readFileSync(path, 'utf8').split('\n')
    const line = lines.find((l) => l.trim() === probe) ?? lines.find((l) => l.includes(probe))
    console.log(`    ${file}: ${line?.trim() ?? '(NOT FOUND ON DISK)'}`)
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
