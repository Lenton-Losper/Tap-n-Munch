#!/usr/bin/env node
/**
 * `@ts-nocheck` HIDES A FILE FROM THE TYPECHECK GATE. THIS STOPS THE SET GROWING. (#172)
 *
 * ============================================================================================
 * WHY THIS MATTERS MORE THAN A NORMAL LINT GAP
 * ============================================================================================
 *
 * The production deploy gate runs `npx tsc --noEmit`, and #141's stated motivation for adding it
 * was a **TS2339 that reached production**. TS2339 is a property-access error — precisely the
 * class `@ts-nocheck` suppresses. The gate was built to catch that failure and is blind to it in
 * every file carrying the pragma.
 *
 * Demonstrated in #172 with a control: a file with the pragma containing
 * `totallyUndefinedSymbol.nope.alsoNope()` produced **no diagnostic at all**, while the same run
 * reported a TS2322 in an otherwise identical file without it.
 *
 * ============================================================================================
 * WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT
 * ============================================================================================
 *
 * It does NOT fix the nine files. Removing `@ts-nocheck` from
 * `components/orders-dashboard.tsx` alone is a substantial piece of typing work, and doing it
 * unattended across nine files — two of which render money — is how a "cleanup" becomes an
 * outage.
 *
 * It makes the set a RATCHET: the listed files are tolerated, a NEW one fails the build, and a
 * file that gets fixed is reported so the baseline shrinks. The number can only go down.
 *
 * Same shape as KNOWN_ABSENT in check-branch-drift.mjs and the baselined offenders in
 * check-migration-inline-check.ts. The baseline is a debt, not a licence.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const ROOT = process.cwd()
const SEARCH_DIRS = ['app', 'lib', 'components', 'workers']
const EXTS = ['.ts', '.tsx']

/**
 * The files carrying `@ts-nocheck`, down from #172's fourteen.
 *
 * Each entry is a file the typecheck CANNOT see. `my-orders` — the screen a customer actually
 * looks at — is still one of them, which is why a green `tsc` has never been evidence about it.
 *
 * REMOVE AN ENTRY WHEN YOU FIX THE FILE. The check tells you when one is ready to go.
 *
 * 2026-08-26: `components/orders-dashboard.tsx` came OFF the list. It was 22 errors, and 21 of
 * them were one root cause each rather than 22 problems: annotating `normalizedOrder` as `Order`
 * cleared 18 on its own (spreading a type with an index signature drops the index signature), and
 * three more were a deprecated field, an implicit `any` and a weak-type mismatch. The 22nd was a
 * real defect the pragma had been hiding — the `tabs` realtime handler dropped
 * `linked_unpaid_tab_id`, erasing the #211 unpaid-tab-elsewhere flag on every realtime update.
 * That ratio is the argument for working the remaining entries: they are not 4,000 errors.
 */
const BASELINE = new Set([
  'app/menu/[restaurantId]/my-orders/page.tsx',
  'app/menu/[restaurantId]/v2/page.tsx',
  'lib/table-session.ts',
  'components/menu-management-new.tsx',
  'components/menu-management-v2.tsx',
  'components/menu-management.tsx',
])

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (EXTS.some((e) => entry.endsWith(e))) out.push(full)
  }
  return out
}

/**
 * THE DECISION, over two sets rather than over the repo.
 *
 * Separated so the self-test below drives THIS function instead of a private copy of its logic. A
 * self-test with its own implementation proves only that the copy still works — the same rule the
 * #280 gate and the #324 fixture gate are built to, and the reason both can be trusted.
 */
export function classify(found, baseline) {
  return {
    added: [...found].filter((f) => !baseline.has(f)).sort(),
    fixed: [...baseline].filter((f) => !found.has(f)).sort(),
  }
}

/**
 * Prove the two arms still fire before reporting that neither did.
 *
 * The stale arm is the one this exists for: it exited 0 until 2026-08-27, and a ratchet that has
 * quietly stopped holding looks exactly like a clean tree.
 */
function selfTest() {
  const b = new Set(['kept.ts', 'wasFixed.ts'])
  const t = classify(new Set(['kept.ts', 'brandNew.ts']), b)
  if (t.added.length !== 1 || t.added[0] !== 'brandNew.ts') {
    console.error('SELF-TEST FAILED: a NEW @ts-nocheck file is no longer detected.')
    process.exit(2)
  }
  if (t.fixed.length !== 1 || t.fixed[0] !== 'wasFixed.ts') {
    console.error('SELF-TEST FAILED: a STALE baseline entry is no longer detected.')
    process.exit(2)
  }
  // FALSE-POSITIVE GUARD. A file that is baselined AND still carries the pragma is the normal,
  // healthy state of every entry on the list — it must produce neither arm. Without this the
  // "make stale entries fail" change could be satisfied by a rule that simply fails on any
  // baseline entry at all, which would be red on a correct tree forever.
  const steady = classify(new Set(['kept.ts', 'wasFixed.ts']), b)
  if (steady.added.length !== 0 || steady.fixed.length !== 0) {
    console.error('SELF-TEST FAILED: an unchanged baseline entry now fires an arm.')
    process.exit(2)
  }
}

selfTest()

const files = []
for (const d of SEARCH_DIRS) walk(join(ROOT, d), files)

const found = new Set()
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  // Only the real pragma. `// @ts-nocheck` must be a comment TypeScript honours, so matching the
  // bare word anywhere would flag this script's own docblock and every file discussing it.
  if (/^\s*\/\/\s*@ts-nocheck\b/m.test(src) || /^\s*\/\*\s*@ts-nocheck\b/m.test(src)) {
    found.add(relative(ROOT, file).split(sep).join('/'))
  }
}

const { added, fixed } = classify(found, BASELINE)

/**
 * A STALE BASELINE ENTRY IS A RE-ENTRY PERMIT, AND IT USED TO EXIT 0.
 *
 * Found 2026-08-27 by mutation. `added` is `found - BASELINE`, so a file NAMED IN BASELINE can
 * never be "new" — no matter when it acquired the pragma. On 2026-08-27 two entries were stale:
 * `components/ActiveOrderBanner.tsx` and `lib/supabase/menu.ts` had both been typed and no longer
 * carried it. Putting `// @ts-nocheck` back on the FIRST LINE of ActiveOrderBanner.tsx — a live
 * customer component, and the file whose bare literal started #334 — produced:
 *
 *     check-ts-nocheck-baseline: OK — 7 file(s) hidden from tsc, none new. (597 scanned)
 *
 * exit 0. The typecheck could no longer see the file and this gate, which exists for exactly that,
 * said "none new".
 *
 * The old behaviour PRINTED the staleness and passed. That is an advisory on a green run, which is
 * the one place nobody reads: a ratchet that only tightens when a human notices a line in passing
 * output and then goes and edits this script is not a ratchet. So it FAILS now, and the debt
 * shrinks monotonically — once a file leaves the list it cannot come back without tripping the
 * `added` arm above.
 *
 * The cost is real and is the right trade: fixing a file turns the build red until BASELINE is
 * edited in the same commit. That is one line, the message below says which, and it is the whole
 * reason the list can be trusted as a debt rather than a licence.
 */
if (fixed.length) {
  console.error('\ncheck-ts-nocheck-baseline: FAILED\n')
  console.error(
    'A BASELINE entry no longer carries @ts-nocheck. Remove it from BASELINE in this script,\n' +
      'in the same commit that fixed the file.\n\n' +
      'This is not bookkeeping. `added` is computed as `found - BASELINE`, so while a fixed file\n' +
      'is still listed here, re-adding the pragma to it is INVISIBLE to this gate — the ratchet\n' +
      'silently stops holding for that file. Deleting the line is what makes the fix permanent.\n',
  )
  for (const f of fixed) console.error(`      ${f}`)
  console.error('')
  process.exit(1)
}

if (added.length) {
  console.error('\ncheck-ts-nocheck-baseline: FAILED\n')
  console.error(
    'A NEW file carries @ts-nocheck. The typecheck gate cannot see it, and the gate exists\n' +
      'because a TS2339 reached production — exactly the class this pragma suppresses.\n\n' +
      'Type the file instead. If it genuinely cannot be typed now, add it to BASELINE in this\n' +
      'script WITH a reason in the commit — the list is a debt, not a licence.\n',
  )
  for (const f of added) console.error(`      ${f}`)
  console.error('')
  process.exit(1)
}

console.log(
  `check-ts-nocheck-baseline: OK — ${found.size} file(s) hidden from tsc, none new. ` +
    `(${files.length} scanned)`,
)
