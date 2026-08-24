/**
 * #330 — MUTATION-VERIFY THE SOURCE-TEXT SUITES. ONE-OFF.
 *
 * These 14 suites read source files with readFileSync and assert on the TEXT. Their subject is a
 * file, not a module, so the 2026-08-22 stub sweep could not touch them: remapping a suite's imports
 * to an empty stub does nothing to a suite that never imports its subject.
 *
 * The only way to decide them is to break what each one actually READS and see whether it notices.
 *
 * HOW THE MUTATION IS CHOSEN. Not at random. For each suite, the file it reads is mutated by
 * deleting the exact token the suite claims to protect — the guard, the copy constant, the call
 * site. A suite that survives that is asserting something other than what its name promises, which
 * is the finding.
 *
 * SAFETY: every mutated file is restored from git immediately after its run, and the script refuses
 * to start if the working tree has uncommitted changes to any file it intends to touch. A crash
 * mid-run leaves at most one file dirty, recoverable with `git checkout --`.
 *
 * Usage:  node scripts/mutate-source-text-suites.mjs [--only=suite-name]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7)

/**
 * suite            the test file, without __tests__/ and .test.ts
 * target           the source file it reads
 * mutation         [find, replaceWith] — the token the suite exists to protect
 * why              what a survival would mean
 */
const CASES = [
  {
    suite: 'already-saved-call-site',
    // It reads the guest EDIT route, not the dashboard.
    target: 'app/api/guest/orders/[orderId]/edit/route.ts',
    mutation: ["reason: 'already_saved'", "reason: 'nope'"],
    why: 'the suite pins a call site by name; renaming it must fail',
  },
  {
    suite: 'customer-screens-do-not-log-credentials',
    target: 'app/menu/[restaurantId]/v2/page.tsx',
    // Must name a key the suite actually watches. `sessionToken` is not one: the list is
    // flashtap_session_token / edit_lock_token / lockToken / tab_pin / flashtap_creator_tab_pin.
    // The first attempt logged a credential the suite was never asked to look for.
    mutation: [null, "\nconsole.log('dbg', localStorage.getItem('flashtap_session_token'))\n"],
    why: 'it exists to catch a credential reaching console; adding one must fail',
  },
  {
    suite: 'customer-screens-have-an-exit',
    // NOT session-ended. The suite asserts that screen has NO in-app exit, deliberately —
    // "the point is that the absence is chosen". Mutating it there proves nothing, which is
    // exactly why the first attempt survived.
    target: 'app/menu/[restaurantId]/cart/page.tsx',
    // hasExit accepts ANY of router.push( / <Link / router.back( / href=, so removing one leaves the
    // others and the suite rightly still passes. All four have to go for the screen to be a dead end.
    mutation: [
      ['router.push(', 'routerNoPush('],
      ['<Link', '<Lnk'],
      ['router.back(', 'routerNoBack('],
      ['href=', 'hrefX='],
    ],
    why: 'it asserts every dead-end screen offers a way out; removing the link must fail',
  },
  {
    suite: 'no-invented-order-number',
    target: 'lib/customer-copy/qr-redesign-copy.ts',
    mutation: ['tabOrderNotYetNumbered', 'tabOrderNotYetNumberedRENAMED'],
    why: 'it pins the one key that stands in for a missing order number',
  },
  {
    suite: 'order-alert-copy-signed-off',
    target: 'components/orders-dashboard.tsx',
    mutation: [null, "\nconst UNSIGNED = 'PENDING COPY - new order'\n"],
    why: 'it is a sign-off gate; introducing unsigned copy must fail',
  },
  {
    suite: 'report-unresolved-uses-owes-money',
    target: 'lib/reports/get-report-data.ts',
    mutation: ['owesMoney', 'owesMoneyRENAMED'],
    why: 'it pins the predicate the report must use',
  },
  {
    suite: 'session-eviction-sweep',
    target: 'hooks/useActiveOrders.ts',
    mutation: ['handleSessionExpired', 'handleSessionExpiredRENAMED'],
    why: 'it asserts which screens evict on a 410',
  },
  {
    suite: 'switcher-copy-signed-off',
    target: 'components/dashboard/restaurant-switcher.tsx',
    mutation: [null, "\nconst UNSIGNED = 'PENDING COPY - Location'\n"],
    why: 'this is the exact string that shipped to production; reintroducing it must fail',
  },
  {
    suite: 'tab-member-key',
    target: 'lib/tab-member-key.ts',
    mutation: ['member_key', 'session_id'],
    why: 'swapping the redacted key back to the credential it replaced must fail',
  },
  {
    suite: 'tab-page-uses-withdrawn-copy',
    target: 'app/menu/[restaurantId]/tab/page.tsx',
    mutation: ['paymentMethodWithdrawnCopy', 'paymentMethodWithdrawnCopyRENAMED'],
    why: 'it pins the #209 copy helper at its call site',
  },
  {
    suite: 'tab-poll-does-not-blank-the-screen',
    target: 'app/menu/[restaurantId]/tab/page.tsx',
    // What it actually asserts is that a REFRESH never re-enters the loading state:
    // `if (!isRefresh) setLoading(true)`. Dropping that guard IS the blank-screen defect.
    // setTabRecord is not what this suite watches, so the first attempt proved nothing.
    mutation: ['if (!isRefresh) setLoading(true)', 'setLoading(true)'],
    why: 'blanking the screen on a poll is the defect; reintroducing it must fail',
  },
  {
    suite: 'terminal-success-contract',
    target: 'app/api/terminal/orders/[orderId]/payment/route.ts',
    // The contract is about what `success` MEANS, not about the vendor constant. Flipping the
    // uncertain branch to success:true is the #868 defect exactly.
    mutation: ["outcome: 'left_pending_finatic_uncertain'", "outcome: 'corrected_to_paid'"],
    why: 'the whole contract is that RESULT_OK alone does not mean paid',
  },
  {
    suite: 'view-menu-keeps-the-tab',
    // Reads the LANDING (v2), not the tab page. The first attempt mutated a file this suite never
    // opens -- a fault in the harness, not evidence about the suite.
    target: 'app/menu/[restaurantId]/v2/page.tsx',
    mutation: ['router.push(browseBase)', 'router.push("/")'],
    why: 'it asserts the View Menu link carries the tab forward',
  },
  {
    suite: 'waiting-request-tells-the-customer',
    // Reads the banner, not the query layer.
    target: 'components/ActiveOrderBanner.tsx',
    // NOT a suffix rename: `waiting_reviewRENAMED` still CONTAINS `waiting_review`, so a toMatch
    // regex passes and the mutation proves nothing. A substring-preserving rename is not a mutation.
    mutation: ['waiting_review', 'pending_review'],
    why: 'it asserts a request in review is shown to the customer',
  },
]

const cases = ONLY ? CASES.filter((c) => c.suite === ONLY) : CASES

// Refuse to run against a dirty tree for any file we intend to mutate.
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
  .split('\n')
  .map((l) => l.slice(3).trim())
  .filter(Boolean)
for (const c of cases) {
  if (dirty.includes(c.target)) {
    console.error(`REFUSING: ${c.target} has uncommitted changes; commit or revert first.`)
    process.exit(1)
  }
}

// NOT `npx`. On Windows npx is npx.cmd and execFileSync cannot spawn it -- every suite came back
// ENOENT, which this script faithfully reported as "red at baseline" for all fourteen. A harness
// whose failure mode is indistinguishable from the thing it measures is worse than no harness, so
// the jest binary is invoked through node directly.
const JEST_BIN = 'node_modules/jest/bin/jest.js'

function runSuite(name) {
  try {
    execFileSync('node', [JEST_BIN, '--silent', `__tests__/${name}.test.ts`], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return 'PASS'
  } catch (e) {
    // A spawn failure is NOT a test failure. Saying so is the difference between "this suite is
    // red" and "I could not run this suite".
    if (e && e.code === 'ENOENT') throw new Error(`cannot run jest via ${JEST_BIN}: ${e.message}`)
    return 'FAIL'
  }
}

const results = []
for (const c of cases) {
  process.stdout.write(`\n### ${c.suite}\n`)

  let source
  try {
    source = readFileSync(c.target, 'utf8')
  } catch {
    results.push({ ...c, verdict: 'TARGET MISSING', detail: c.target })
    console.log(`  target missing: ${c.target}`)
    continue
  }

  const before = runSuite(c.suite)
  if (before !== 'PASS') {
    // A suite that is already red cannot demonstrate anything by going redder.
    results.push({ ...c, verdict: 'RED AT BASELINE', detail: 'cannot be mutation-tested until repaired' })
    console.log('  baseline: FAIL — cannot be decided until repaired (#331)')
    continue
  }

  // A case may carry several find/replace pairs, for a suite whose assertion is a disjunction:
  // removing one of four accepted exit controls leaves three, and the suite rightly still passes.
  if (Array.isArray(c.mutation[0])) {
    let mutatedAll = source
    let missing = null
    for (const [f, r] of c.mutation) {
      if (!mutatedAll.includes(f)) { missing = f; break }
      mutatedAll = mutatedAll.split(f).join(r)
    }
    if (missing) {
      results.push({ ...c, verdict: 'MUTATION NOT APPLICABLE', detail: `"${missing}" not present in ${c.target}` })
      console.log(`  cannot mutate: "${missing}" not found in ${c.target}`)
      continue
    }
    writeFileSync(c.target, mutatedAll)
    const afterMulti = runSuite(c.suite)
    execFileSync('git', ['checkout', '--', c.target])
    const verdictMulti = afterMulti === 'FAIL' ? 'CAUGHT' : 'SURVIVED'
    results.push({ ...c, verdict: verdictMulti, detail: `${c.mutation.length} substitutions` })
    console.log(`  baseline PASS, mutated ${afterMulti}  =>  ${verdictMulti}`)
    continue
  }

  const [find, replaceWith] = c.mutation
  let mutated
  if (find === null) {
    mutated = source + replaceWith
  } else {
    if (!source.includes(find)) {
      results.push({ ...c, verdict: 'MUTATION NOT APPLICABLE', detail: `"${find}" not present in ${c.target}` })
      console.log(`  cannot mutate: "${find}" not found in ${c.target}`)
      continue
    }
    mutated = source.split(find).join(replaceWith)
  }

  writeFileSync(c.target, mutated)
  const after = runSuite(c.suite)
  execFileSync('git', ['checkout', '--', c.target])

  const verdict = after === 'FAIL' ? 'CAUGHT' : 'SURVIVED'
  results.push({ ...c, verdict, detail: `${find ?? '<append>'} -> ${String(replaceWith).trim().slice(0, 40)}` })
  console.log(`  baseline PASS, mutated ${after}  =>  ${verdict}`)
}

console.log('\n' + '='.repeat(80))
for (const r of results) console.log(`  ${r.verdict.padEnd(22)} ${r.suite}`)
const caught = results.filter((r) => r.verdict === 'CAUGHT').length
const survived = results.filter((r) => r.verdict === 'SURVIVED')
console.log(`\n  ${caught}/${results.length} caught their mutation`)
if (survived.length) {
  console.log('\n  SURVIVED — these assert something other than what their name promises:')
  for (const r of survived) console.log(`    ${r.suite}: ${r.why}`)
}
