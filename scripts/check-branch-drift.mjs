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
 * HAND-WRITTEN EXEMPTIONS. Currently NONE, and it should stay that way.
 *
 * This began as a 2026-08-17 baseline so the check could go BLOCKING on day one without going red
 * on a gap that already existed — a check that fires on pre-existing state gets `continue-on-error`
 * bolted on within a day, which is exactly how the migration drift check in this same workflow
 * ended up decoration.
 *
 * It is empty as of 2026-08-25. Every entry had been reconciled, the check said so itself through
 * its own stale-entry reporting, and the two mechanical classifiers below now cover both cases that
 * used to need a hand-written line:
 *
 *   PROMOTED    main holds content HEAD gave it. Every promotion used to create an entry here,
 *               because a cherry-pick necessarily has a different patch-id.
 *   NO CONTENT  empty commits, which cannot be drift by construction.
 *
 * Entries are still printed loudly on every run, and the check reports stale ones so this cannot
 * rot into fiction. If you are about to add one: a commit that needs a hand-written exemption is a
 * commit somebody should read first. That friction is the feature.
 */
const KNOWN_ABSENT = new Set([
  // EMPTIED 2026-08-25, and that is the direction this list is only ever allowed to move.
  //
  // The check reported all seven as reconciled ("remove from KNOWN_ABSENT: 56f70b8, f7ee138,
  // b30b7e5, 77dbf76, 71fe6a3, 908516b, 865aa17") -- its own stale-entry mechanism working, which
  // is what stops this list rotting into fiction. Every one of them is now present on
  // cloudflare-staging by content, so an exemption for it would be an assertion that is no longer
  // true.
  //
  // The 2026-08-17 baseline existed so the check could go BLOCKING on day one without going red on
  // a gap that already existed. That debt is paid. An empty list means the check now fails on any
  // genuine drift at all, which is the state it was always meant to reach.
  //
  // If you are about to add an entry here: the two classifiers above (PROMOTED and NO CONTENT)
  // handle the two cases that used to need one. A commit that needs a hand-written exemption is a
  // commit somebody should read first -- that is the point of the friction.
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

/**
 * EMPTY COMMITS — the generated marker commits that can never be reconciled.
 *
 * The `probe-302-305-production` workflow re-runs the redaction verifier after each production
 * deploy and records the run with `git commit --allow-empty`. It commits to `main`, and `main` is
 * the only branch it ever lands on, so every one of them reads as drift against staging FOREVER:
 * you cannot cherry-pick your way out, because the next deploy writes another.
 *
 * Eighteen had accumulated by 2026-08-25, in a list of twenty. That is how a blocking check dies —
 * not by being switched off, but by its output becoming something nobody reads. The two survivors
 * were both false alarms for their own reasons (6db8a26 is empty too and carries no marker;
 * 382389b tripped the `blobAt` bug below), which is the point: nobody was going to find that out
 * while eighteen lines of noise sat on top of them.
 *
 * THE TEST IS "CHANGES NO FILE", NOT "MATCHES THE MARKER TEXT".
 *
 * A subject-line exclusion is the obvious fix and it is the wrong one: it would swallow a real
 * commit that happened to carry the marker in its message, which is precisely the commit you would
 * most want to hear about. This asks the question that actually decides it — does the commit change
 * any file at all — and a commit that changes nothing cannot be content `main` has and staging
 * lacks, BY CONSTRUCTION.
 *
 * So the exclusion cannot swallow a real commit even in principle: "touches a runtime file" and
 * "touches no files" are mutually exclusive. `__tests__/branch-drift-empty-commit-rule.test.ts`
 * pins that in both directions, including a marker-subject commit WITH a file in it, which must
 * still be reported.
 *
 * `GENERATED_MARKER` is used for REPORTING ONLY — to say how many of the empty ones came from that
 * workflow — and takes no part in the decision. Note also that 6db8a26, the tax-rate refusal probe,
 * is empty too and carries NO marker: excluding by subject would have missed it and left the check
 * red, which is the same bug from the other side.
 */
const GENERATED_MARKER = /\[probe-302-305-production\]/

/** The files a commit touches. An empty array means an empty commit. */
function touchedFiles(sha) {
  return git(['show', '--name-only', '--format=', sha])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
}

/**
 * True only for a commit that changes NO file. Deliberately independent of the subject line, so a
 * marker commit carrying any file falls straight through to the normal classification below.
 */
function isEmptyCommit(sha) {
  return touchedFiles(sha).length === 0
}

/**
 * The blob sha for `file` at `ref`, or null if the ref does not have that path.
 *
 * THE SEVENTH LYING INSTRUMENT, found 2026-08-25. `promotedState` used
 * `tryGit(['rev-parse', `${ref}:${file}`]).ok` to mean "the ref has this file", and it does not:
 *
 *     $ git rev-parse 'origin/main:app/table/[tableNumber]/page.tsx'   # deleted on main
 *     origin/main:app/table/[tableNumber]/page.tsx
 *     $ echo $?
 *     0
 *
 * It EXITS ZERO and echoes the unresolved string back. So `.ok` was always true, the branch
 * commented "not on BASE (a deletion); nothing of main's to lack" had NEVER ONCE EXECUTED, and the
 * blob comparison below was comparing a path string against a real sha — so it always read
 * "differing" and fell through to the expensive history walk.
 *
 * The visible cost: any commit that DELETES a file could never classify PROMOTED. 382389b (#118,
 * which deletes the dead /table page) was reported as drift for that reason alone, while all three
 * of its files are demonstrably reconciled on staging — the page absent on both refs, the test and
 * middleware.ts byte-identical.
 *
 * Validated by SHAPE rather than by exit code, because the exit code is the thing that lied.
 */
function blobAt(ref, file) {
  const r = tryGit(['rev-parse', `${ref}:${file}`])
  if (!r.ok) return null
  const out = r.out.trim()
  return /^[0-9a-f]{40}$/.test(out) ? out : null
}

/** PRESENT = its patch reverse-applies, so the change is already here under another patch-id. */
/**
 * PROMOTED (#310) — main holds content that HEAD gave it, which is not drift.
 *
 * A promotion moves content from `cloudflare-staging` onto `main`. That is the same direction this
 * check calls a defect, so every promotion read as NEW DRIFT and the only way to clear the build
 * was to GROW the baseline — the one direction the baseline must never move. It fired on the first
 * two promotions after the check went live.
 *
 * THE INVARIANT, stated properly: **main being ahead is a defect only when main holds content
 * HEAD LACKS.** A promotion is main holding content HEAD supplied. The patch check answers "is
 * this patch present", and a promotion's patch is not reproducible against a HEAD that has since
 * moved on in the same files — same content, different context. So this asks the question that
 * actually matters, per file.
 *
 * For every file the commit touches:
 *   - blobs identical                      -> HEAD is level. Fine.
 *   - HEAD contains main's last commit for
 *     that path (it is an ancestor of HEAD) -> HEAD has main's version and moved past it. Fine.
 *   - otherwise                             -> main holds something HEAD does not. NOT promoted.
 *
 * That last branch is the `?ref=` / #242 class and it MUST stay loud: a genuinely-newer-on-main
 * file is exactly what this check exists to catch, and a promotion classifier that softened it
 * would be worse than no classifier. One such file is enough to disqualify the whole commit.
 *
 * Deleted-on-HEAD counts as NOT promoted: a file main has and HEAD does not is content HEAD lacks,
 * whatever the reason.
 */
function promotedState(sha) {
  const files = git(['show', '--name-only', '--format=', sha])
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
  if (files.length === 0) return false

  for (const file of files) {
    const mainBlob = blobAt(BASE, file)
    if (mainBlob === null) continue // not on BASE (a deletion); nothing of main's to lack
    const headBlob = blobAt(HEAD, file)
    if (headBlob === null) {
      /**
       * HEAD DOES NOT HAVE THE FILE. Two very different situations, and returning false for both
       * was wrong — fixed 2026-08-18, the third refinement of #310 and the same class as the
       * other two:
       *
       *   never had it   main holds a file this branch never received. Genuine drift.
       *   DELETED it     this branch had it and removed it deliberately, which makes it AHEAD of
       *                  main, not behind. `hooks/useSessionTokenGuard.ts` was deleted as dead
       *                  code and the whole customer-redesign commit went red as a result.
       *
       * The same question as everywhere else in this function: did HEAD ever hold main's blob.
       */
      const everHadIt = tryGit(['rev-list', HEAD, '--', file])
      if (!everHadIt.ok || !everHadIt.out.trim()) return false
      continue
    }
    if (mainBlob === headBlob) continue // identical

    // Differing. HEAD is only level-or-ahead if it CONTAINS main's last change to this path.
    const mainCommitForPath = tryGit(['log', '-1', '--format=%H', BASE, '--', file]).out.trim()
    if (!mainCommitForPath) return false
    const contained = tryGit(['merge-base', '--is-ancestor', mainCommitForPath, HEAD]).ok
    if (contained) continue

    /**
     * LAST RESORT, and the reason this function needed a third test at all.
     *
     * FIXED 2026-08-18, the day after #310 shipped, because #310 was wrong in a way that only
     * showed up once ordinary work resumed. The two tests above compare HEAD's CURRENT blob. A
     * promotion satisfies them the moment it lands -- and stops satisfying them as soon as anyone
     * edits one of the promoted files on HEAD again. The commit then flips back to ABSENT, and
     * the gate goes red on work that is strictly AHEAD of main.
     *
     * That is the worst possible failure for a gate: it fires on normal activity, so it gets
     * ignored, and then it is not a gate. It reproduced within two commits of #310 landing --
     * editing lib/orders/logical-item-identity.ts un-promoted #307.
     *
     * The stable question is not "does HEAD hold main's blob NOW" but "did HEAD EVER hold it".
     * A promotion means main took content that came FROM here, so that content is somewhere in
     * this branch's history for the path, whatever has happened to the file since.
     *
     * Deliberately scoped to commits that touched this path, so it stays bounded, and it can only
     * ever ACCEPT -- a commit main genuinely holds alone has a blob HEAD has never contained, at
     * any point, and still fails. The three real gaps below stay loud.
     */
    const headHistory = tryGit(['rev-list', HEAD, '--', file])
    if (!headHistory.ok) return false
    const everHeld = headHistory.out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .some((sha) => blobAt(sha, file) === mainBlob)
    if (!everHeld) return false // main holds a change to this file that HEAD has never had
  }
  return true
}

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

// PROMOTED is evaluated FIRST: it answers a stronger question than the patch check and does
// not depend on the working tree, so it holds even when the content pass has to skip.
const classified = baseOnly.map((c) => ({
  ...c,
  // NO CONTENT is evaluated FIRST, and needs neither the working tree nor the patch machinery:
  // a commit that changes no file cannot be content HEAD lacks.
  state: isEmptyCommit(c.sha) ? 'NO CONTENT' : promotedState(c.sha) ? 'PROMOTED' : contentState(c.sha),
}))
const emptyCommits = classified.filter((c) => c.state === 'NO CONTENT')
const promoted = classified.filter((c) => c.state === 'PROMOTED')
const portedAlready = classified.filter((c) => c.state === 'PRESENT')
const genuinelyMissing = classified.filter(
  (c) => c.state === 'ABSENT' || c.state === 'DIVERGED' || c.state === 'UNKNOWN',
)

console.log(`--- ${HEAD} is ahead by ${headOnly.length} commit(s) (expected; this is what staging is for)`)
for (const c of headOnly.slice(0, 5)) console.log(`      ${c.short}  ${c.date}  ${c.subject}`)
if (headOnly.length > 5) console.log(`      ... and ${headOnly.length - 5} more`)

console.log('')
console.log(`--- ${BASE} is ahead by ${baseOnly.length} commit(s) by patch-id`)
const markerCount = emptyCommits.filter((c) => GENERATED_MARKER.test(c.subject)).length
console.log(
  `      ${emptyCommits.length} NO CONTENT (empty commits — ${markerCount} from the probe-302-305 workflow)`,
)
console.log(`      ${promoted.length} PROMOTED (main gained ${HEAD}'s own content; not drift)`)
console.log(`      ${portedAlready.length} already present by content (ported under a different patch-id)`)
console.log(`      ${genuinelyMissing.length} GENUINELY ABSENT`)

/**
 * Reported SEPARATELY from PRESENT, deliberately. They are different facts: PRESENT means the
 * same fix exists here under another patch-id; PROMOTED means this content came FROM here. If a
 * promotion only half-landed, the files that did not land fail the per-file test above and the
 * commit drops out of this list into GENUINELY ABSENT, where it is loud. Collapsing the two
 * would hide exactly that.
 */
if (promoted.length) {
  console.log('')
  console.log('    promoted from ' + HEAD + ', no action:')
  for (const c of promoted) console.log(`      ${c.short}  ${c.date}  ${c.subject}`)
}

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
