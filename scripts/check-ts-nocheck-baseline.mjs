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
 * The nine files carrying `@ts-nocheck` as of 2026-08-19, down from #172's fourteen.
 *
 * Each entry is a file the typecheck CANNOT see. Two of them — my-orders and orders-dashboard —
 * are the screens a customer and a staff member actually look at, which is why a green `tsc` has
 * never been evidence about them.
 *
 * REMOVE AN ENTRY WHEN YOU FIX THE FILE. The check tells you when one is ready to go.
 */
const BASELINE = new Set([
  'app/menu/[restaurantId]/my-orders/page.tsx',
  'app/menu/[restaurantId]/v2/page.tsx',
  'lib/supabase/menu.ts',
  'lib/table-session.ts',
  'components/ActiveOrderBanner.tsx',
  'components/menu-management-new.tsx',
  'components/menu-management-v2.tsx',
  'components/menu-management.tsx',
  'components/orders-dashboard.tsx',
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

const added = [...found].filter((f) => !BASELINE.has(f)).sort()
const fixed = [...BASELINE].filter((f) => !found.has(f)).sort()

if (fixed.length) {
  console.log('')
  console.log(`  ${fixed.length} file(s) no longer carry @ts-nocheck — REMOVE from BASELINE:`)
  for (const f of fixed) console.log(`      ${f}`)
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
