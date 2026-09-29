#!/usr/bin/env node
/**
 * Sprint 2026-09-29 (Phases 3-5): proves the end-to-end chain suites are load-bearing.
 *
 *   __tests__/e2e-riviera-modena-chain.test.ts   (Phase 3: Riviera #160 / Modena)
 *   __tests__/e2e-variant-chain.test.ts          (Phase 4: variants, menu -> invoice)
 *   __tests__/e2e-invoice-delivery-chain.test.ts (Phase 5: the emailed invoice PDF)
 *
 * Each mutation re-introduces ONE defect by exact-string replacement. Every edit must match exactly
 * the number of times it declares (default once) or the run aborts -- a mutation that did not land
 * reads exactly like a test that works. The mutated line is printed back FROM DISK, the named
 * suite is run, and the run must go RED *through the named tests* (a RED for some other reason,
 * such as a type error from the edit itself, is reported as not caught). The file is restored in
 * `finally`; `--verify-green` re-runs every suite unmutated at the end.
 *
 *   node scripts/mutate-e2e-chain.mjs                 # all
 *   node scripts/mutate-e2e-chain.mjs MV1 MM2         # a subset
 *   node scripts/mutate-e2e-chain.mjs --verify-green  # all, then the unmutated suites
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MODENA = '__tests__/e2e-riviera-modena-chain.test.ts'
const VARIANT = '__tests__/e2e-variant-chain.test.ts'
const INVOICE = '__tests__/e2e-invoice-delivery-chain.test.ts'
const PRICING = 'lib/orders/calculate-order-pricing.ts'
const AMEND = 'app/api/terminal/tabs/[tabId]/amend/route.ts'
const SETTLE = 'app/api/terminal/tabs/[tabId]/settle/route.ts'

const MUTATIONS = [
  // ---- Phase 4: variants ------------------------------------------------------------------
  {
    id: 'MV1',
    what: 'accept a missing required variant (the terminal complete-selection check removed)',
    suite: VARIANT,
    expectRed: ['3. required variant missing', 'a text-group-only miss is refused too'],
    edits: [[PRICING, 'if (check.missingRequired.length > 0) {', 'if (false && check.missingRequired.length > 0) {']],
  },
  {
    id: 'MV2',
    what: 'fall back to base price (the chosen option no longer replaces base_price)',
    suite: VARIANT,
    expectRed: ['1+7. a valid variant on a base_price-0 item', '8+9. one round, two variants of the SAME product'],
    edits: [[PRICING, 'unitPrice = matchedVariant.price', 'void matchedVariant.price']],
  },
  {
    id: 'MV3',
    what: "trust the client's price (a line's `price` overrides the catalog)",
    suite: VARIANT,
    expectRed: ['6. a STALE client price is ignored', '6b. a client price that is simply WRONG'],
    edits: [[
      PRICING,
      '  const rate = resolveTaxRate(menuItem.tax_rate_id, ratesById, fallbackDefault)\n',
      '  if (Number(item.price) > 0) unitPrice = Number(item.price)\n  const rate = resolveTaxRate(menuItem.tax_rate_id, ratesById, fallbackDefault)\n',
    ]],
  },
  {
    id: 'MV4',
    what: 'drop the variant from the persisted line (catalog name, no canonical selection)',
    suite: VARIANT,
    expectRed: ['1+7. a valid variant on a base_price-0 item', '8+9. one round, two variants', '11. the invoice bills each variant line'],
    edits: [[
      PRICING,
      '        selectedVariants: check.canonical,\n        name: displayName,\n        displayName,\n',
      '        selectedVariants: undefined,\n        name: catalogName,\n        displayName: catalogName,\n',
    ]],
  },
  // ---- Phase 3: Riviera #160 / Modena ------------------------------------------------------
  {
    id: 'MM1',
    what: 'the amend route reports what was REQUESTED as applied (the #160 fabrication)',
    suite: MODENA,
    expectRed: ['the route says refused, window_closed, changed false'],
    edits: [[
      AMEND,
      '      applied: (Array.isArray(raw.applied) ? raw.applied : []) as AppliedLine[],',
      "      applied: amendments.map((a) => ({ line_id: a.line_id, action: 'voided' as const })),",
    ]],
  },
  {
    id: 'MM2',
    what: "the P5 lines route bills from the stale tabs.total instead of the projection's live value",
    suite: MODENA,
    expectRed: ['the P5 bill: N$965', 'no void event, Modena still cooked and on the bill'],
    edits: [['app/api/terminal/tabs/[tabId]/lines/route.ts', '        total: centsToMajor(tabFinancials.liveCents),', '        total: Number(tab.total),']],
  },
  {
    id: 'MM3',
    what: 'prepare-payment charges orders.total (voided lines and replacements both charged)',
    suite: MODENA,
    expectRed: ['the card charge: prepare-payment asks for N$965'],
    edits: [[
      'app/api/terminal/orders/[orderId]/prepare-payment/route.ts',
      '        financials.get(String(row.id))?.outstandingCents ?? 0\n',
      '        Math.round(Number((row as Record<string, unknown>).total) * 100)\n',
    ]],
  },
  {
    id: 'MM4',
    what: "the cash settle route expects Σ orders.total, so the live N$965 is refused",
    suite: MODENA,
    expectRed: ['the cash settlement: N$1,205 is refused'],
    edits: [[SETTLE, 'sum + outstandingCentsOf(o.id), 0)', 'sum + Math.round(Number(o.total) * 100), 0)']],
  },
  {
    id: 'MM5',
    what: 'VOIDED_LINE never matches (the projection counts voided lines as live)',
    suite: MODENA,
    expectRed: ['each reduction is authorised', 'the P5 bill: N$965', 'the floor view, the order history'],
    edits: [['lib/orders/order-financials.ts', "  return owned.length > 0 && owned.every((s) => s === 'voided')\n", "  return owned.length < 0 && owned.every((s) => s === 'voided')\n"]],
  },
  {
    id: 'MM6',
    what: 'the void reason is not written onto the void event',
    suite: MODENA,
    expectRed: ['the rows: kitchen voided, one attributed void event WITH its reason'],
    edits: [[AMEND, '    if (voidReason && voidedLineIds.length > 0) {', '    if (voidReason && voidedLineIds.length < 0) {']],
  },
  {
    id: 'MM7',
    what: 'the amendment outcome is not recorded on the spent PIN (refused == never sent again)',
    suite: MODENA,
    expectRed: ['the authorization: the PIN token is spent', 'the refusal is still RECORDED'],
    edits: [[AMEND, '  if (!params.tokenId) return\n', '  if (params.tokenId || !params.tokenId) return\n']],
  },
  {
    id: 'MM8',
    what: 'an EDITED re-send under the same key is replayed as the original round (C4 removed, both checks)',
    suite: MODENA,
    expectRed: ['EDITED re-send (Modena removed, same key)'],
    edits: [['app/api/terminal/rounds/route.ts', '!isSameRound(', 'false && !isSameRound(', 2]],
  },
  {
    id: 'MM9',
    what: 'order-history revenue uses the refund-aware projection, subtracting refunds twice',
    suite: MODENA,
    expectRed: ['the refund is subtracted ONCE'],
    // Single-line anchor: the refund-aware figure is added and the gross one multiplied away.
    edits: [[
      'app/api/orders/history/route.ts',
      'grossPaidCents += computeOrderFinancials(',
      'grossPaidCents += projectOrderWithInputs(order as FinancialOrderInput, inputs).paidCents + 0 * computeOrderFinancials(',
    ]],
  },
  // ---- Phase 5: the emailed invoice ---------------------------------------------------------
  {
    id: 'MI1',
    what: 'the emailed PDF is rendered without the recorded payments',
    suite: INVOICE,
    expectRed: ['total = live = N$965; paid = ledger', 'paid N$80, outstanding = total'],
    edits: [[
      'lib/documents/sendDocumentEmail.ts',
      'toBusinessDocumentRow(row, undefined, { payments: options.payments })',
      'toBusinessDocumentRow(row, undefined, { payments: [] })',
    ]],
  },
  {
    id: 'MI2',
    what: 'the invoice bills voided lines (Modena and the reduced originals charged)',
    suite: INVOICE,
    expectRed: ['total = live = N$965; paid = ledger'],
    edits: [['lib/documents/invoice-projection.ts', '      if (f.cancelled || line.voided) {', '      if (f.cancelled) {']],
  },
  {
    id: 'MI3',
    what: 'a cash gratuity is recorded inside the payment (the ledger row is food + tip)',
    suite: INVOICE,
    expectRed: ['CASH through the tab settle route with a N$50 tip'],
    edits: [[
      SETTLE,
      "        amount: expectedAmount,\n        method,\n        status: 'completed',",
      "        amount: expectedAmount + tipCents / 100,\n        method,\n        status: 'completed',",
    ]],
  },
]

function runSuite(suite) {
  const run = spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', suite, '--ci'], { encoding: 'utf8' })
  const out = `${run.stdout}\n${run.stderr}`
  const summary = out.split('\n').find((l) => l.startsWith('Tests:')) ?? '(no summary)'
  const failed = out
    .split('\n')
    .filter((l) => /^\s+(×|✕)\s/.test(l))
    .map((l) => l.replace(/^\s+(×|✕)\s+/, '').replace(/\s+\(\d+ ms\)$/, ''))
  const compileError = /Test suite failed to run/.test(out)
  return { status: run.status, summary, failed, compileError }
}

const args = process.argv.slice(2)
const verifyGreen = args.includes('--verify-green')
const wanted = args.filter((a) => !a.startsWith('--'))
const selected = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS
let allRed = true

for (const m of selected) {
  const originals = new Map()
  try {
    for (const [file, from, to, count = 1] of m.edits) {
      const original = originals.get(file) ?? readFileSync(file, 'utf8')
      if (!originals.has(file)) originals.set(file, original)
      const crlf = original.includes('\r\n')
      const f = crlf ? from.replace(/\n/g, '\r\n') : from
      const t = crlf ? to.replace(/\n/g, '\r\n') : to
      const current = readFileSync(file, 'utf8')
      const n = current.split(f).length - 1
      if (n !== count) {
        console.error(`${m.id}: anchor matched ${n} times in ${file} (expected ${count}); aborting`)
        process.exit(2)
      }
      writeFileSync(file, current.split(f).join(t))
    }
    console.log(`\n${m.id} (${m.what})`)
    for (const [file, , to] of m.edits) {
      const firstLine = to.split('\n').find((l) => l.trim()) ?? to
      const onDisk = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.includes(firstLine.trim()))
      console.log(`  ${file}: ${onDisk?.trim() ?? '(MUTATED LINE NOT FOUND ON DISK)'}`)
      if (!onDisk) allRed = false
    }
    const r = runSuite(m.suite)
    const missed = m.expectRed.filter((name) => !r.failed.some((f) => f.includes(name)))
    const red = r.status !== 0 && !r.compileError && missed.length === 0
    if (!red) allRed = false
    console.log(
      `  ${red ? 'RED (caught)' : 'NOT CAUGHT'} -- ${r.summary}` +
        (r.compileError ? ' -- the suite did not compile: the mutation is invalid, not caught' : '') +
        (missed.length ? ` -- still green: ${missed.join(' | ')}` : ''),
    )
    if (r.failed.length) console.log(`  first RED: ${r.failed[0]}`)
  } finally {
    for (const [file, original] of originals) writeFileSync(file, original)
  }
}

if (verifyGreen) {
  for (const suite of [MODENA, VARIANT, INVOICE]) {
    const r = runSuite(suite)
    const green = r.status === 0
    if (!green) allRed = false
    console.log(`\nUNMUTATED ${suite}: ${green ? 'GREEN' : 'RED'} -- ${r.summary}`)
  }
}

process.exit(allRed ? 0 : 1)
