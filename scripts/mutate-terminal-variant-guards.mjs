#!/usr/bin/env node
/**
 * Sprint 2026-09-28 (C5/C6): proves the terminal variant tests are load-bearing.
 *
 * Each mutation breaks ONE guard by an exact-string replacement (which must match exactly once,
 * or the run aborts rather than reporting a mutation that never landed), prints the mutated line
 * back, runs the two suites, and restores the file. Every mutation must turn the suites RED.
 *
 *   node scripts/mutate-terminal-variant-guards.mjs            # all mutations
 *   node scripts/mutate-terminal-variant-guards.mjs M1 M3a     # a subset
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const SUITES = [
  '__tests__/terminal-variant-selection-pricing.test.ts',
  '__tests__/terminal-routes-variant-refusal.test.ts',
]

const MUTATIONS = [
  {
    id: 'M1',
    what: 'required-group check removed (missing required variant no longer refused)',
    file: 'lib/orders/calculate-order-pricing.ts',
    from: 'if (check.missingRequired.length > 0) {',
    to: 'if (false && check.missingRequired.length > 0) {',
  },
  {
    id: 'M2a',
    what: 'base-price fallback: the variant option price no longer replaces base_price',
    file: 'lib/orders/calculate-order-pricing.ts',
    from: 'unitPrice = matchedVariant.price',
    to: 'void matchedVariant.price',
  },
  {
    id: 'M2b',
    what: 'createOrder drops the terminal flag (terminal priced like QR: base fallback, no refusal)',
    file: 'lib/orders/create-order.ts',
    from: 'requireCompleteVariantSelection: params.requireCompleteVariantSelection === true,',
    to: 'requireCompleteVariantSelection: false,',
  },
  {
    id: 'M3a',
    what: '/api/terminal/orders pricing refusal reverted to 500',
    file: 'app/api/terminal/orders/route.ts',
    from: 'if (err instanceof UnmatchedMenuItemError) {',
    to: 'if (false && err instanceof UnmatchedMenuItemError) {',
  },
  {
    id: 'M3b',
    what: '/api/terminal/rounds pricing refusal reverted to 500',
    file: 'app/api/terminal/rounds/route.ts',
    from: 'if (err instanceof UnmatchedMenuItemError) {',
    to: 'if (false && err instanceof UnmatchedMenuItemError) {',
  },
  {
    id: 'M4a',
    what: 'protocol gate always OFF (a declaring terminal is never strict)',
    file: 'lib/orders/variant-protocol.ts',
    from: "=== '1'",
    to: "=== '1' && false",
  },
  {
    id: 'M4b',
    what: 'protocol gate always ON (a 2.39 P5 without the header is refused)',
    file: 'lib/orders/variant-protocol.ts',
    from: "=== '1'",
    to: "=== '1' || true",
  },
  {
    id: 'M4c',
    what: 'legacy-terminal gap audit not requested by the orders route',
    file: 'app/api/terminal/orders/route.ts',
    from: 'auditMissingRequiredVariants: !variantProtocol,',
    to: 'auditMissingRequiredVariants: false,',
  },
  {
    id: 'M4d',
    what: 'legacy-terminal gap audit not requested by the rounds route',
    file: 'app/api/terminal/rounds/route.ts',
    from: 'auditMissingRequiredVariants: !variantProtocol,',
    to: 'auditMissingRequiredVariants: false,',
  },
]

const wanted = process.argv.slice(2)
const selected = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS
let allRed = true

for (const m of selected) {
  const original = readFileSync(m.file, 'utf8')
  const count = original.split(m.from).length - 1
  if (count !== 1) {
    console.error(`${m.id}: pattern matched ${count} times in ${m.file}; aborting`)
    process.exit(2)
  }
  const mutated = original.replace(m.from, m.to)
  writeFileSync(m.file, mutated)
  try {
    const line = mutated.split('\n').find((l) => l.includes(m.to.trim()))
    console.log(`\n${m.id} (${m.what})\n  ${m.file}: ${line?.trim()}`)
    const run = spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', ...SUITES], {
      encoding: 'utf8',
    })
    const out = `${run.stdout}\n${run.stderr}`
    const summary = out.split('\n').find((l) => l.startsWith('Tests:')) ?? '(no summary)'
    const red = run.status !== 0 && /failed/.test(summary)
    if (!red) allRed = false
    console.log(`  ${red ? 'RED (caught)' : 'GREEN (NOT caught)'} -- ${summary}`)
  } finally {
    writeFileSync(m.file, original)
  }
}

process.exit(allRed ? 0 : 1)
