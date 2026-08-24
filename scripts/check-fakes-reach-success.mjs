/**
 * SUPERSEDED — kept as the record of a detector that did not work. See
 * docs/mutation-testing-notes.md.
 *
 * The table-poisoning approach below produced two suspects and BOTH were false positives, and six
 * of the nineteen suites came back "could not locate a from() to poison" -- which is NOT TESTED,
 * not clean, and is exactly the distinction a summary line invites you to lose.
 *
 * What actually decided the question was far cheaper: ask whether a suite asserts the response
 * status at all. A suite that checks res.status cannot be green over a 500. That reduced 19 suites
 * to 3 worth reading, and the last of those was settled by poisoning createServerSupabaseClient so
 * the route could not reach the database -- 5 of 5 failed, so it genuinely exercises its success
 * path.
 *
 * Result: all 19 reach their success path.
 */
/**
 * ARE THESE SUITES GREEN, OR GREEN OVER AN ERROR?
 *
 * push-to-terminal-race-and-trim and push-to-terminal-merchant-order were green on 9 of their 11
 * assertions for three weeks while EVERY request they made returned 500. Their fakes threw on any
 * table but `orders`; the route had started writing audit_logs; the throw reached the outer catch.
 * Only the three assertions that checked res.status noticed. The rest read as coverage of the
 * terminal push path and were exercising the error handler.
 *
 * That is not a property of those two files. Any suite whose hand-rolled fake is narrower than what
 * its subject actually calls has the same shape, and a suite cannot report it because from inside
 * the test a 500 and a 200 are both "a response".
 *
 * SO THIS DOES NOT READ THE TESTS. It makes the failure loud and re-runs them:
 *
 *   1. INSTRUMENT — wrap console.error/warn so anything a route logs on its failure path is
 *      captured, then run the suite unmodified. A suite that is quietly failing usually says so in
 *      a log nobody reads.
 *   2. MUTATE THE FAKE — make `from()` throw for one table the suite does NOT already handle. If
 *      the suite still passes, nothing it asserts depends on that call succeeding. That is the
 *      push-to-terminal shape exactly, and it is the reliable detector: a suite that genuinely
 *      exercises its success path notices when the path breaks.
 *
 * A suite that survives step 2 is not necessarily wrong -- it may legitimately not touch that
 * table -- so the output is a RANKED SUSPECT LIST for reading, not a verdict. Stating that is the
 * point: the harness faults during #330 all came from a tool reporting a verdict it had not earned.
 *
 * Usage: node scripts/check-fakes-reach-success.mjs [--only=suite]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7)
const JEST_BIN = 'node_modules/jest/bin/jest.js'

/** The 19 suites whose fakes hand-roll a PostgREST builder over a read their subject paginates. */
const SUITES = [
  '287-partial-settle-keeps-ready-to-pay',
  'accept-rollback-failure-is-not-silent',
  'create-order-reprices-terminal-leg',
  'e04111-recovery-webhook-route',
  'gateway-amount-exact-match',
  'guest-orders-declined-visibility',
  'order-accept-preserves-reviewed-total',
  'order-edit-route',
  'platform-admin-login-destination',
  'staff-cancel-reason-and-audit',
  'table-close-payment-safety',
  'tab-reopen-after-terminal-payment',
  'terminal-cancel-bypass-end-to-end',
  'terminal-cancel-payload-reaches-handler',
  'terminal-payment-cent-tolerance-routes',
  'webhook-amount-mismatch-refused',
  'webhook-sig-fallback-route',
  'e04111-recovery',
  'resolve-order-by-merchant-order-injection',
]

const suites = ONLY ? SUITES.filter((s) => s === ONLY) : SUITES

function run(name) {
  try {
    const out = execFileSync('node', [JEST_BIN, `__tests__/${name}.test.ts`], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { pass: true, out }
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error(`cannot run jest: ${e.message}`)
    return { pass: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

/** Log lines a route emits only when something went wrong. */
const DISTRESS = [
  /\[PUSH-TO-TERMINAL\] .*fail/i,
  /unexpected table/i,
  /is not a function/i,
  /\bReferenceError\b/,
  /\bTypeError\b/,
  /Unhandled|UnhandledPromiseRejection/,
  /\[[A-Z-]+\] .*(failed|error|threw)/,
]

const results = []

for (const suite of suites) {
  const file = `__tests__/${suite}.test.ts`
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch {
    results.push({ suite, verdict: 'MISSING' })
    continue
  }

  const baseline = run(suite)
  if (!baseline.pass) {
    results.push({ suite, verdict: 'RED (out of scope here)' })
    console.log(`### ${suite}\n  red at baseline — skipped`)
    continue
  }

  const distress = DISTRESS.filter((re) => re.test(baseline.out)).map((re) => String(re))

  // Which tables does this fake already name? Anything else is a candidate to break.
  const named = new Set([...source.matchAll(/['"`]([a-z_]{3,40})['"`]/g)].map((m) => m[1]))
  const candidates = ['audit_logs', 'payment_events', 'orders', 'order_items', 'tabs', 'receipts'].filter(
    (t) => named.has(t),
  )

  // Break the FIRST table the fake names, in the fake only, and see whether the suite notices.
  let mutationVerdict = 'no table literal found to break'
  if (candidates.length > 0) {
    const target = candidates[0]
    // Insert a poison line at the top of every `from(` implementation in the fake.
    const mutated = source.replace(
      /from\s*\(\s*(?:table|t|name)?\s*:?\s*(?:string)?\s*\)?\s*\{/g,
      (m) => `${m}\n      if (arguments[0] === '${target}') throw new Error('POISON ${target}')`,
    )
    if (mutated === source) {
      mutationVerdict = 'could not locate a from() to poison'
    } else {
      writeFileSync(file, mutated)
      const after = run(suite)
      execFileSync('git', ['checkout', '--', file])
      mutationVerdict = after.pass
        ? `SURVIVED poisoning '${target}' — nothing asserted depends on that read`
        : `caught poisoning '${target}'`
    }
  }

  results.push({ suite, verdict: 'GREEN', distress, mutationVerdict })
  console.log(`### ${suite}`)
  if (distress.length) console.log(`  DISTRESS IN OUTPUT: ${distress.join(' ')}`)
  console.log(`  ${mutationVerdict}`)
}

console.log('\n' + '='.repeat(80))
const suspects = results.filter((r) => r.distress?.length || /SURVIVED/.test(r.mutationVerdict ?? ''))
console.log(`  ${results.length} scanned, ${suspects.length} worth reading:\n`)
for (const r of suspects) {
  console.log(`  ${r.suite}`)
  if (r.distress?.length) console.log(`      distress: ${r.distress.join(' ')}`)
  if (/SURVIVED/.test(r.mutationVerdict ?? '')) console.log(`      ${r.mutationVerdict}`)
}
console.log('\n  SUSPECTS, NOT VERDICTS. A suite may legitimately never touch the poisoned table.')
