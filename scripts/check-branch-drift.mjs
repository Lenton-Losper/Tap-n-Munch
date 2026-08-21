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
  // SHRUNK 2026-08-18 by the PROMOTED classifier (#310), from six entries to three.
  //
  // Both promotion entries are gone -- 1591d12 and b30b7e5 now classify PROMOTED on their own
  // evidence rather than on my say-so, which is what #310 was for. d57c659 went too: the check
  // reported it as reconciled since the baseline was taken.
  //
  // These three remain, and each is a commit whose BEHAVIOUR is on HEAD under a different
  // patch-id while the whole patch is not -- verified by reading the decisive line, not by
  // trusting the patch. They are NOT promotions, so the classifier correctly leaves them here:
  '56f70b8', // #254/?ref= — `paymentRefOrFilter` and `isWellFormedPaymentRef` are BYTE-IDENTICAL
             //              on both branches; only the test file differs
  'f7ee138', // #122 cross-tenant union — by-payment-ref route code is identical, comments differ

  // ADDED 2026-08-19, and these two are a DIFFERENT case from the two above — worth stating
  // because the distinction is the whole reason the PROMOTED classifier exists.
  //
  // Both were classifying PROMOTED on their own evidence until today. They stopped because
  // #310's classifier compares CURRENT blobs, and today's work edited files these commits
  // touched — qr-redesign-copy.ts (the four signed-off strings), order-identity.ts (the stale
  // "See staff" comment), order-confirmation-view.tsx (the Order #0 guard). Editing a file after
  // a commit was promoted un-promotes that commit, because the blob no longer matches.
  //
  // The right question is "did HEAD ever hold this?", not "does HEAD hold it now". Until the
  // classifier asks that, an entry here is the honest alternative to weakening the check.
  //
  // BEHAVIOUR VERIFIED PRESENT ON origin/cloudflare-staging before baselining, per this file's
  // own instruction to read the decisive line:
  //   b30b7e5 — all six distinctive modules present (tab-order-groups, tab-outstanding,
  //             ready-to-pay-placement, resolve-order-member-names, shared-tab-client,
  //             tab-flag-copy) and the signed-off copy constants present
  //   77dbf76 — isDeadOrder / DEAD_ORDER_LIVE_WINDOW_MS / isStaleDeadOrder present in
  //             customer-status.ts, hasAllocatedOrderNumber present in order-identity.ts
  'b30b7e5', // QR customer redesign — un-promoted by later edits to files it touched
  '77dbf76', // my-orders dead orders — same; staging carries it as 22fe0e4

  // The MAIN-SIDE cherry-picks of two fixes authored on staging the same day. Their patches
  // differ from the staging originals only because promoting them required resolving a conflict
  // (main had no tests/e2e/ suite until aa7e7c8), so patch-id cannot match by construction.
  // Every decisive line read on origin/cloudflare-staging before baselining:
  //   71fe6a3 — hasAllocatedOrderNumber guard in order-confirmation-view, `order_number: null`
  //             in the guest-orders mapper, and scripts/check-order-number-guard.ts present
  //   908516b — `resolvedPaymentMethod = null` in the orders route, `{!isTabOrder && (` in the
  //             confirmation view
  //
  // STRUCTURAL NOTE for whoever reads this next: every promotion from staging to main creates a
  // new drift entry, because the cherry-pick necessarily has a different patch-id. That is worth
  // fixing in the classifier rather than growing this list one promotion at a time.
  '71fe6a3', // #315 Order #0 class fix — staging original is 188172f
  '908516b', // #316/#317 tab payment method — staging original is ec50ac6
  // 9fcb147 (#262 member key) REMOVED 2026-08-18. It was here because the only difference was
  // __tests__/tab-member-key.test.ts, which staging held as a strict SUBSET of main's. Porting
  // main's file reconciled the commit outright, so it no longer needs an exemption. The check
  // reported it as stale itself, which is the mechanism working: an entry that stops being
  // needed says so rather than sitting here forever.

  // ADDED 2026-08-21 by wave 1 (main f04c01b -> 1811b0e, 76 commits). This is the STRUCTURAL NOTE
  // above coming true, and it is the ONLY new drift the whole 76-commit promotion produced.
  //
  // 865aa17 is main's copy of staging's b915483b. It is a PARTIAL apply: b915483b carried three
  // files and one of them, .github/workflows/staging.yml, was already on main, so the cherry-pick
  // landed two files and its patch-id differs from the original by construction. Nothing is
  // missing from staging — the direction is the opposite of what "main is ahead" usually means.
  //
  // DECISIVE LINES READ on origin/cloudflare-staging before baselining, per this file's own rule:
  //   docs/promotion-constraints.md   — blob 66da8d5c on BOTH refs, byte-identical
  //   scripts/check-branch-drift.mjs  — present, and staging's copy is a strict superset (it is
  //                                     this file; staging is where it was written)
  //
  // RECONCILE WOULD BE WRONG HERE, which is why this is a baseline entry: cherry-picking 865aa17
  // onto staging would try to re-add content staging already has and is the origin of.
  '865aa17', // wave 1 partial apply of b915483b — both files present on staging, one identical
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
    const mainBlob = tryGit(['rev-parse', `${BASE}:${file}`])
    if (!mainBlob.ok) continue // not on BASE (a deletion); nothing of main's to lack
    const headBlob = tryGit(['rev-parse', `${HEAD}:${file}`])
    if (!headBlob.ok) {
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
    if (mainBlob.out.trim() === headBlob.out.trim()) continue // identical

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
      .some((sha) => tryGit(['rev-parse', `${sha}:${file}`]).out.trim() === mainBlob.out.trim())
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
  state: promotedState(c.sha) ? 'PROMOTED' : contentState(c.sha),
}))
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
