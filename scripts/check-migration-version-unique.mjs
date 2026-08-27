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

/**
 * `.sql` FILES THIS DETECTOR CANNOT READ A VERSION FROM — reported rather than skipped.
 *
 * Found 2026-08-27 by mutation. `VERSION` demands exactly fourteen digits;
 * `check-migration-drift.mjs:85` reads the same filename with `/^(\d+)_/`, ANY number of digits.
 * So the two gates disagree about what a migration's version is, and the disagreement is silent.
 *
 * Dropping `2026082616000_probe_a.sql` and `2026082616000_probe_b.sql` — thirteen digits, one
 * fat-fingered keystroke, the collision #280 exists to catch — into the real migrations directory
 * produced:
 *
 *     MIGRATION VERSION CHECK: OK — 153 migration(s), every version maps to one filename.
 *
 * Both halves of that sentence are false, and the COUNT is the worse half: `total` was computed
 * from every `.sql` in the directory while the detector had examined only the parseable ones, so
 * the number vouched for two files it never looked at. An all-clear carrying a tally reads as
 * "I checked 153 things", and here it meant "I checked 151 and counted 153".
 *
 * A version this gate cannot read is a defect on its own terms — Supabase's own naming requires
 * the timestamp — so this fails rather than warns. Widening `VERSION` to `\d+` to match the drift
 * guard would be the wrong repair: it would make the pair above parse, and quietly bless a
 * malformed migration name instead of reporting it.
 *
 * SCOPED TO `.sql` DELIBERATELY, and the self-test pins it: `README.md`, `.gitkeep` and any
 * subdirectory must never fire this. A gate that fails on the directory's own README is one
 * somebody switches off.
 */
export function unparsableIn(names) {
  return names.filter((n) => n.endsWith('.sql') && !VERSION.test(n)).sort()
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
  // The unreadable-version arm, driven through the REAL function for the same reason as above.
  const unreadable = unparsableIn([
    '2026082616000_probe_a.sql', // thirteen digits -- the mutation that got past this gate
    '20260826160000_fine.sql',
    'README.md', // FALSE-POSITIVE GUARD: not a migration, must never fire
    '.gitkeep', // FALSE-POSITIVE GUARD: same
  ])
  if (unreadable.length !== 1 || unreadable[0] !== '2026082616000_probe_a.sql') {
    console.error('SELF-TEST FAILED: the detector no longer reports a .sql file it cannot read a version from.')
    process.exit(2)
  }
}

selfTest()

const entries = existsSync(ROOT) ? readdirSync(ROOT) : []
const unreadable = unparsableIn(entries)
if (unreadable.length > 0) {
  console.error('MIGRATION VERSION CHECK: FAILED — a .sql file whose version this gate cannot read.\n')
  for (const n of unreadable) console.error(`      ${n}`)
  console.error(
    '\nA version prefix is fourteen digits followed by an underscore. These do not match, so this',
    '\ngate SKIPS them -- while check-migration-drift.mjs reads the same names with /^(\\d+)_/ and',
    '\naccepts any digit count. The two gates would disagree about what these migrations are',
    '\nversioned as, and a collision between them would be invisible here. Rename to the fourteen-',
    '\ndigit form, and never renumber one that has already run against a database.',
  )
  process.exit(1)
}

const found = collisions(ROOT)
if (found.length === 0) {
  // Counted from what the DETECTOR read, never from the raw directory listing. The two differed
  // before 2026-08-27, and the difference was the whole defect: an all-clear that tallies files it
  // never examined is worse than one that gives no number at all, because the number is what makes
  // it believed.
  const checked = entries.filter((n) => n.endsWith('.sql') && VERSION.test(n)).length
  console.log(`MIGRATION VERSION CHECK: OK — ${checked} migration(s) read, every version maps to one filename.`)
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
