/**
 * #280 — every migration version prefix must map to exactly ONE filename.
 *
 * THIS FIRED FOR REAL ON 2026-08-26, between two unpushed branches, and would have passed every
 * gate we had. Two agents authored migrations the same evening from the same base:
 *
 *     20260826160000_order_requests_claimed_at.sql          (#215)
 *     20260826160000_restaurants_drop_payment_methods.sql   (#349)
 *
 * `check-migration-drift.mjs` identifies a migration by its numeric prefix alone. Both landing
 * would have recorded `20260826160000` in the ledger ONCE, shown green, and left one of the two
 * permanently unapplied with nothing reporting it. The consequences were asymmetric and both bad:
 * a skipped `claimed_at` means #215's reaper ships and reaps nothing (its whole premise is that a
 * reaper cannot exist until the claim records a time); a skipped drop means #349's dead column
 * survives the fix that claims to remove it.
 *
 * WHY THIS IS A DEFAULT RATHER THAN A FREAK. Parallel agents branching from the same base all draw
 * `<today>HHMMSS`, and everyone rounds to the hour. Collision is the expected outcome of the naming
 * convention under concurrency, not bad luck. The convention fix is in the operating contracts;
 * this is the backstop for when someone does not follow it.
 *
 * DE-DUPLICATED BY FILENAME, NOT BY PREFIX, and that is the whole subtlety. The same migration file
 * exists on every branch and worktree, so counting prefix occurrences reports ~140 "duplicates" on
 * a perfectly clean tree — which is exactly the noisy first scan this script exists to replace. A
 * collision is TWO DISTINCT FILENAMES sharing one version. One filename appearing five times is a
 * branch, not a defect.
 *
 * Usage:
 *   node scripts/check-migration-version-unique.mjs
 *   node scripts/check-migration-version-unique.mjs --root=<dir>   (for the test fixture)
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const rootArg = process.argv.find((a) => a.startsWith('--root='))
const ROOT = rootArg ? rootArg.slice('--root='.length) : 'supabase/migrations'

const VERSION = /^(\d{14})_/

/**
 * The detector, over a LIST OF NAMES rather than a directory.
 *
 * Separated so the self-test below can exercise THIS function rather than a private copy of its
 * logic. A self-test with its own implementation cannot catch a regression in the real one -- it
 * only proves the copy still works, which is worth nothing.
 *
 * Taking a list is also what makes the de-duplication rule testable at all: a directory cannot
 * physically hold the same filename twice, so `readdirSync` can never produce the repeated-name
 * input the Set exists to collapse. That input arrives when names are gathered ACROSS branches or
 * worktrees, which is exactly the shape that produced ~140 false "duplicates" on a clean tree.
 */
export function collisionsIn(names) {
  const byVersion = new Map()
  for (const name of names) {
    if (!name.endsWith('.sql')) continue
    const m = name.match(VERSION)
    if (!m) continue
    const version = m[1]
    if (!byVersion.has(version)) byVersion.set(version, new Set())
    byVersion.get(version).add(name)
  }
  const bad = []
  for (const [version, names2] of byVersion) {
    if (names2.size > 1) bad.push({ version, names: [...names2].sort() })
  }
  return bad.sort((a, b) => a.version.localeCompare(b.version))
}

function collisions(dir) {
  if (!existsSync(dir)) {
    throw new Error(`migration directory not found: ${dir}`)
  }
  return collisionsIn(readdirSync(dir))
}

/**
 * Self-test the detector before trusting its verdict on the repo.
 *
 * A checker that silently stopped detecting would exit 0 and be indistinguishable from a clean
 * tree — the same class of false negative as the drift guard this backstops.
 */
function selfTest() {
  const known = collisionsIn([
    '20260826160000_a.sql',
    '20260826160000_b.sql',
    '20260826170000_c.sql',
    '20260826170000_c.sql', // the SAME name twice -- must collapse, not count as a collision
    'README.md',
  ])
  if (known.length !== 1 || known[0].version !== '20260826160000') {
    console.error('SELF-TEST FAILED: the detector no longer detects a known collision.')
    process.exit(2)
  }
  if (collisionsIn(['20260826170000_c.sql', '20260826170000_c.sql']).length !== 0) {
    console.error('SELF-TEST FAILED: one filename repeated was counted as a collision.')
    process.exit(2)
  }
}

selfTest()

const found = collisions(ROOT)
if (found.length === 0) {
  const total = readdirSync(ROOT).filter((n) => n.endsWith('.sql')).length
  console.log(`MIGRATION VERSION CHECK: OK — ${total} migration(s), every version maps to one filename.`)
  process.exit(0)
}

console.error('MIGRATION VERSION CHECK: FAILED — a version prefix maps to more than one file.\n')
for (const { version, names } of found) {
  console.error(`  ${version}`)
  for (const n of names) console.error(`      ${n}`)
}
console.error(
  '\nThe drift guard identifies a migration by prefix alone, so these silence each other:',
  '\nthe ledger records the version once, the guard goes green, and one migration is never',
  '\napplied with nothing reporting it. Renumber the one that has not been applied anywhere',
  '\n(bump the HHMMSS), and never renumber one that has already run against a database.',
)
process.exit(1)
