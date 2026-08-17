/**
 * Branch drift, measured by PATCH-ID and then confirmed by CONTENT.
 *
 * WHY THIS EXISTS. `cloudflare-staging` fell 23 commits behind `main` and nobody saw it, because
 * nothing looked and the one number available lied: `rev-list` said 250 commits of drift where
 * patch-id said 106 — a 2.4x overstatement, big enough that reading it told you nothing. Among
 * the 23 was a live PostgREST `.or()` injection fix (#242) that main had and staging did not, so
 * the redesign was built and verified on a base weaker than what customers actually run.
 *
 * MAIN BEING AHEAD OF STAGING IS A DEFECT, NOT A STATE. That is the failing direction, and it is
 * the one that silently reverts a production security fix the moment somebody merges. Staging
 * being ahead is normal — that is what staging is for.
 *
 * TWO MEASUREMENTS, NOT ONE, and the second is what keeps this honest:
 *
 *   1. `git cherry` gives candidates by patch-id. It is right about the graph and wrong about the
 *      world: a fix PORTED to the other branch under a different patch-id shows up as missing.
 *      Measured on 2026-08-17, 12 of 23 "missing" commits were already present by content.
 *   2. Each candidate's patch is then REVERSE-APPLIED against the working tree. If it reverse-
 *      applies cleanly, the change is already here under another patch-id and is reported as
 *      PRESENT, not failed. Only genuinely absent or diverged commits fail the check.
 *
 * A check that cried wolf on twelve ported commits would be switched off within a week, and then
 * this would happen again with nothing watching. The content pass is not a refinement; it is the
 * reason the check can be left blocking.
 *
 * USAGE
 *   node scripts/check-branch-drift.mjs [baseRef] [headRef]
 *   node scripts/check-branch-drift.mjs origin/main origin/cloudflare-staging   (the defaults)
 *
 * EXIT CODES
 *   0  base is not ahead: nothing on base is genuinely absent from head
 *   1  base is ahead — commits on base that head lacks, by content
 *   2  the check could not run (missing refs, shallow clone, wrong tree)
 *
 * There is deliberately NO `import.meta.url === process.argv[1]` main-module guard. That
 * comparison never matches on Windows, and a CI step that "passes" having executed nothing is
 * exactly the shape of failure this file is here to prevent.
 */
import { execFileSync } from 'node:child_process'

/**
 * KNOWN-ABSENT AS OF 2026-08-17, so this can be BLOCKING from the day it lands.
 *
 * A check that goes red on state that already exists gets `continue-on-error: true` bolted on
 * within a day and then it is decoration — which is how the migration drift check ended up
 * non-blocking in this same workflow. Baselining the existing gap means the job can only fail on
 * drift that is NEW, which is the recurrence this exists to prevent.
 *
 * Every entry is a commit on `main` that `cloudflare-staging` did not have on 2026-08-17. They
 * are still printed on every run, loudly. Removing one from this list is how you record that it
 * has been reconciled; the check reports stale entries so the list cannot rot into fiction.
 *
 * `07b4737` is the one to look at first: its cherry-pick conflicts in
 * `lib/orders/auto-cancel-stale-pos-orders.ts`, where staging's #268 and main's #223 disagree
 * about one line in the payments path. It needs an attended decision.
 */
const KNOWN_ABSENT = new Set([
  // SHRUNK 2026-08-17 after the reconciliation: six entries removed because they landed on
  // cloudflare-staging (accce84..0c616a6) — #242's resolver and probe, #223's three commits, and
  // the #266 CI pin. The baseline is a debt and it just got smaller, which is the only direction
  // it is allowed to move.
  //
  // These four remain, and all four are commits whose BEHAVIOUR is already on staging under a
  // different patch-id — verified by reading the decisive line, not by trusting the patch:
  '56f70b8', // #254/?ref= — `paymentRefOrFilter` and `isWellFormedPaymentRef` are BYTE-IDENTICAL
             //              on both branches; only the test file differs
  'd57c659', // #135 — MAX_INSTRUCTIONS_LENGTH is present on staging
  'f7ee138', // #122 cross-tenant union — by-payment-ref route code is identical, comments differ
  '9fcb147', // #262 member key — deriveTabMemberKey is present via a64a422

  // GROWN 2026-08-17, and this is the one direction I said the baseline should not move -- so
  // the reason is recorded rather than assumed. These two are PROMOTION commits: main gained
  // cloudflare-staging's own content through a surgical port. Their patches cannot reverse-apply
  // against staging because staging has since moved on in the same files, so patch-id reads them
  // as drift while the behaviour is demonstrably present.
  //
  // VERIFIED before adding, not asserted: for every product file where the two branches differ,
  // staging's version is the NEWER one. Main holds nothing staging lacks -- staging is a content
  // superset. That is the opposite of the condition this check exists to catch.
  //
  // THE STRUCTURAL POINT, worth more than these two entries: every promotion will look like new
  // drift to a main-vs-staging patch-id check, because promotion moves content in the direction
  // the check calls a defect. A future version should treat a commit as PRESENT when every file
  // it touches is identical-or-older on main than on staging. Until then, promotions land here.
  '1591d12', // Deploy 3 - the order editor, ported FROM staging
  'b30b7e5', // Deploy 4 - the customer redesign shell, ported FROM staging
])

const BASE = process.argv[2] || process.env.DRIFT_BASE_REF || 'origin/main'
const HEAD = process.argv[3] || process.env.DRIFT_HEAD_REF || 'origin/cloudflare-staging'

const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })

function tryGit(args) {
  try {
    return { ok: true, out: git(args, { stdio: ['pipe', 'pipe', 'pipe'] }) }
  } catch (err) {
    return { ok: false, out: String((err && err.stdout) || ''), err: String((err && err.stderr) || err) }
  }
}

function die(code, message) {
  console.error(message)
  process.exit(code)
}

for (const ref of [BASE, HEAD]) {
  if (!tryGit(['rev-parse', '--verify', `${ref}^{commit}`]).ok) {
    die(2, `DRIFT CHECK CANNOT RUN: ref "${ref}" is not present.\n` +
           'In CI this usually means a shallow checkout — use actions/checkout with fetch-depth: 0 ' +
           'and fetch both branches before this step.')
  }
}

// The content pass reverse-applies patches against the WORKING TREE, so it is only meaningful
// when the tree is the head ref. Say so rather than reporting a confident wrong answer.
const headSha = git(['rev-parse', HEAD]).trim()
const treeSha = git(['rev-parse', 'HEAD']).trim()
const treeIsHeadRef = headSha === treeSha
// Only TRACKED modifications matter: reverse-applying a patch is unaffected by an untracked file
// lying around, and this script is itself untracked the first time anybody runs it.
const dirty = git(['status', '--porcelain', '--untracked-files=no']).trim().length > 0

/** Commits on `from` with no patch-id equivalent on `to`. */
function patchIdGap(from, to) {
  const out = tryGit(['cherry', to, from]).out
  return out.split('\n').filter((l) => l.startsWith('+')).map((l) => l.split(/\s+/)[1]).filter(Boolean)
}

function describe(sha) {
  const line = git(['log', '-1', '--format=%h\x01%ad\x01%s', '--date=short', sha]).trim()
  const [short, date, subject] = line.split('\x01')
  return { sha, short, date, subject }
}

/** PRESENT = its patch reverse-applies, so the change is already here under another patch-id. */
function contentState(sha) {
  if (!treeIsHeadRef || dirty) return 'UNKNOWN'
  const patch = git(['show', sha])
  const check = (extra) => {
    try {
      execFileSync('git', ['apply', '--check', ...extra], { input: patch, stdio: ['pipe', 'pipe', 'pipe'] })
      return true
    } catch {
      return false
    }
  }
  // `--3way` resolves against the recorded blobs instead of demanding exact context, so a fix
  // ported with surrounding lines rewritten is still recognised as PRESENT. Without it, five of
  // the 23 measured on 2026-08-17 were reported missing while their code was demonstrably here
  // (the ?ref= guard is byte-identical on both branches), and a check that wrong gets ignored.
  if (check(['-R', '--3way'])) return 'PRESENT'
  if (check(['--3way'])) return 'ABSENT'
  return 'DIVERGED'
}

console.log(`=== branch drift: ${BASE} vs ${HEAD} ===`)
console.log(`    ${BASE} = ${git(['rev-parse', '--short', BASE]).trim()}   ${HEAD} = ${git(['rev-parse', '--short', HEAD]).trim()}`)
if (!treeIsHeadRef) {
  console.log(`    NOTE: working tree is not at ${HEAD}; content pass skipped, patch-id only.`)
} else if (dirty) {
  console.log('    NOTE: working tree is dirty; content pass skipped, patch-id only.')
}
console.log('')

const baseOnly = patchIdGap(BASE, HEAD).map(describe)
const headOnly = patchIdGap(HEAD, BASE).map(describe)

const classified = baseOnly.map((c) => ({ ...c, state: contentState(c.sha) }))
const genuinelyMissing = classified.filter((c) => c.state === 'ABSENT' || c.state === 'DIVERGED' || c.state === 'UNKNOWN')
const portedAlready = classified.filter((c) => c.state === 'PRESENT')

console.log(`--- ${HEAD} is ahead by ${headOnly.length} commit(s) (expected; this is what staging is for)`)
for (const c of headOnly.slice(0, 5)) console.log(`      ${c.short}  ${c.date}  ${c.subject}`)
if (headOnly.length > 5) console.log(`      ... and ${headOnly.length - 5} more`)

console.log('')
console.log(`--- ${BASE} is ahead by ${baseOnly.length} commit(s) by patch-id`)
console.log(`      ${portedAlready.length} already present by content (ported under a different patch-id)`)
console.log(`      ${genuinelyMissing.length} GENUINELY ABSENT`)

if (portedAlready.length) {
  console.log('')
  console.log('    present by content, no action:')
  for (const c of portedAlready) console.log(`      ${c.short}  ${c.date}  ${c.subject}`)
}

if (genuinelyMissing.length) {
  console.log('')
  console.log(`    *** ${BASE} IS AHEAD — these are on ${BASE} and NOT on ${HEAD}: ***`)
  for (const c of genuinelyMissing) {
    console.log(`      ${c.short}  ${c.date}  [${c.state}]  ${c.subject}`)
  }
  console.log('')
  console.log('    NOTE: this is per COMMIT, not per behaviour. A commit shows as ABSENT when its')
  console.log('          whole patch is not here — its key guard may already have been ported while')
  console.log('          a test file alongside it was not. Read the decisive line before concluding')
  console.log('          the fix is missing; four of the ten measured on 2026-08-17 were like that.')
  console.log('')
  console.log(`    ABSENT   applies cleanly — cherry-pick it onto ${HEAD}`)
  console.log('    DIVERGED both branches changed it — needs an attended decision, never an')
  console.log('             unattended conflict resolution if it touches payments or auth')
  console.log('    UNKNOWN  content pass could not run; treat as absent until checked')
  console.log('')
  console.log(`    ${BASE} being ahead of ${HEAD} is a DEFECT, not a state. Whatever is listed`)
  console.log(`    here is a fix production has and ${HEAD} does not, and a merge can revert it.`)

  const unbaselined = genuinelyMissing.filter((c) => !KNOWN_ABSENT.has(c.short))
  const stale = [...KNOWN_ABSENT].filter((s) => !genuinelyMissing.some((c) => c.short === s))

  if (stale.length) {
    console.log('')
    console.log(`    reconciled since the baseline was taken — remove from KNOWN_ABSENT: ${stale.join(', ')}`)
  }

  if (unbaselined.length) {
    console.log('')
    console.log(`    *** NEW DRIFT — ${unbaselined.length} commit(s) not in the 2026-08-17 baseline: ***`)
    for (const c of unbaselined) console.log(`      ${c.short}  ${c.date}  ${c.subject}`)
    console.log('')
    console.log('    This is the failure this check exists for. Reconcile it, or add it to')
    console.log('    KNOWN_ABSENT with the reason — but only after reading the decisive line.')
    process.exit(1)
  }

  console.log('')
  console.log(`    All ${genuinelyMissing.length} are in the 2026-08-17 baseline. No NEW drift.`)
  console.log('    The baseline is a debt, not a licence. It should only ever shrink.')
  process.exit(0)
}

console.log('')
console.log(`OK — nothing on ${BASE} is missing from ${HEAD}.`)
process.exit(0)
