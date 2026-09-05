#!/usr/bin/env node
/**
 * THE PRODUCTION DEPLOY SEQUENCE, as one command that cannot skip its own gates.
 *
 * ============================================================================================
 * WHY THIS EXISTS WHEN THE GATES ALREADY DO
 * ============================================================================================
 *
 * `check-opennext-artifact.mjs` refuses a malformed artifact — but only if somebody runs it. On
 * 2026-09-01 the outage was not caused by a missing check; it was caused by a person, in a hurry,
 * running `wrangler deploy` because that was the shortest path to production. A gate you have to
 * remember is a gate that gets skipped exactly when it matters.
 *
 * So this makes the SAFE path the SHORT path, and the stages are ordered so each one's failure
 * costs less than the next one's:
 *
 *   verify   -> the artifact is Linux-built and complete            (costs nothing)
 *   upload   -> a version at 0% traffic, with a preview URL         (costs no customer)
 *   smoke    -> the preview answers on every route                 (costs no customer)
 *   record   -> the rollback target, WRITTEN DOWN BEFORE promoting (costs nothing)
 *   promote  -> traffic moves                                       (costs everything)
 *   watch    -> the live site, sampled                              (catches it early)
 *
 * ============================================================================================
 * PROMOTION IS OPT-IN AND CANNOT BE REACHED BY ACCIDENT
 * ============================================================================================
 *
 * Without `--promote` this uploads and smokes and stops, having sent no traffic anywhere. With
 * `--promote` it ALSO requires `--i-have-read-the-runbook`, because a single flag is one typo or
 * one copied line away from moving production, and the second flag is not something anybody types
 * by accident.
 *
 * A failed stage stops the sequence. There is no `--force`.
 *
 * Usage:
 *   node scripts/deploy/deploy-production.mjs                       # verify + upload + smoke
 *   node scripts/deploy/deploy-production.mjs --promote --i-have-read-the-runbook
 *   node scripts/deploy/deploy-production.mjs --rollback <version-id>
 *
 * See docs/production-deploy-runbook.md. The build itself is a separate step, in Docker:
 *   docker run --rm -v "<repo>:/app" -v flashtap_prod_linux_build_node_modules:/app/node_modules \
 *     -w /app node:20-bookworm bash /app/scripts/deploy/build-linux.sh
 */
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const valueOf = (flag) => {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : null
}

const CONFIG = 'wrangler.production.toml'
const WRANGLER = 'wrangler@3.99.0'
const LIVE_URL = 'https://flashtap.app'
const ROLLBACK_FILE = join('.deploy', 'rollback-target.json')

let stage = 0
function banner(title) {
  stage += 1
  console.log(`\n${'='.repeat(72)}\n  STAGE ${stage}: ${title}\n${'='.repeat(72)}`)
}
function fail(message) {
  console.error(`\nSTOPPED: ${message}`)
  console.error('Nothing further was attempted. There is no --force.')
  process.exit(1)
}
function run(command, commandArgs, { capture = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
  })
  if (capture) {
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
  }
  /**
   * `out` IS BOTH STREAMS, and `stdout` is stdout alone. Both are needed, for opposite reasons.
   *
   * Parsing wrangler needs the combined stream: it prints the version id and preview URL to
   * whichever it likes, and a stdout-only match silently found nothing.
   *
   * Taking a VALUE from a command needs stdout alone. When `git rev-parse` failed inside the
   * container, stdout was empty and stderr was not, so `out.trim() || 'unknown'` evaluated to
   * `fatal: not a git repository: /app/C:/Users/...` -- and that became the version tag, which
   * Cloudflare rejected with `workers/tag exceeds maximum length 100`. The `|| 'unknown'` guard
   * reads as if it handles a failed command and cannot: a failure is precisely when stderr is
   * non-empty. Measured 2026-09-04.
   */
  return {
    code: result.status ?? 1,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    stdout: result.stdout ?? '',
  }
}

// ── rollback ─────────────────────────────────────────────────────────────────

if (has('--rollback')) {
  const target = valueOf('--rollback')
  if (!target) fail('--rollback needs a version id')
  banner(`ROLL BACK to ${target}`)
  console.log('Rolling back first and diagnosing afterwards is the correct order.')
  const r = run('npx', [WRANGLER, 'versions', 'deploy', '--config', CONFIG, `${target}@100`, '-y'])
  if (r.code !== 0) fail('rollback command failed — escalate immediately')
  banner('POST-ROLLBACK HEALTH')
  const s = run('node', ['scripts/deploy/smoke-preview.mjs', LIVE_URL, '--samples', '10'])
  if (s.code !== 0) fail('the site is still unhealthy after rollback')
  console.log('\nRolled back and healthy.')
  process.exit(0)
}

// ── 1. verify ────────────────────────────────────────────────────────────────

banner('VERIFY THE ARTIFACT')
if (!existsSync(join('.open-next', 'server-functions', 'default', 'handler.mjs'))) {
  fail('no artifact found. Build it in Docker first — see the runbook. A host build is not shippable.')
}
if (run('node', ['scripts/deploy/check-opennext-artifact.mjs', '.open-next']).code !== 0) {
  fail('the artifact is malformed. This is the check that would have prevented the 2026-09-01 outage.')
}

/**
 * THE ARTIFACT MUST BE A BUILD OF *THIS* COMMIT.
 *
 * ============================================================================================
 * WHY, MEASURED 2026-09-05
 * ============================================================================================
 *
 * A `build-linux.sh` run was killed mid-`npm ci` by host memory pressure. That left the PREVIOUS
 * build sitting in `.open-next`: complete, valid, Linux-built, 13.5 MB. Every check above passes
 * it, because they ask whether the artifact is WELL-FORMED and never which commit it is.
 *
 * Deploying at that moment would have tagged the version `deploy-<new sha>`, set
 * `--var GIT_COMMIT_SHA=<new sha>`, and shipped the OLD bundle. /api/version would then have
 * answered the NEW sha while running the OLD code, and the 20/20 post-promotion sampling would
 * have gone green on it.
 *
 * NOTE WHAT THAT MEANS FOR THE IDENTITY FIX (08ce71a4, earlier the same day). Before it, a stale
 * artifact answered {"commit":null} -- useless, but honest. After it, the version asserts a
 * confident WRONG answer. Making the deploy able to identify itself is what made this failure mode
 * dangerous, so the two changes belong together.
 *
 * ============================================================================================
 * THE EVIDENCE IS ALREADY IN THE BUNDLE -- NOTHING NEW HAD TO BE RECORDED
 * ============================================================================================
 *
 * `build-linux.sh` exports NEXT_PUBLIC_COMMIT_SHA, and Next inlines NEXT_PUBLIC_* at build time,
 * so the full 40-character sha is a literal inside handler.mjs. This looks for exactly that.
 *
 * Three outcomes, deliberately distinguished, because "wrong commit" and "cannot tell" are
 * different problems with different fixes:
 *
 *   match          proceed
 *   no sha at all  the artifact predates the sha bake, or was built without it -> REBUILD
 *   a DIFFERENT sha  the artifact is a different commit -> REBUILD (this is the 2026-09-05 case)
 */
const headSha = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim()
if (!/^[0-9a-f]{40}$/.test(headSha)) {
  fail(
    [
      'could not resolve the full commit sha, so the artifact cannot be checked against it.',
      `  git said: ${JSON.stringify(headSha)}`,
      '  In Docker this means the gitdir is not mounted -- the repo is a git worktree, so',
      '  .git is a pointer to a path outside the container. See the runbook.',
    ].join('\n'),
  )
}

const handlerPath = join('.open-next', 'server-functions', 'default', 'handler.mjs')
const bundle = readFileSync(handlerPath, 'utf8')
if (!bundle.includes(headSha)) {
  // Only scanned on failure: cheap enough once, and it turns "wrong" into "wrong, and here is
  // which commit you actually have".
  const found = [...new Set(bundle.match(/\b[0-9a-f]{40}\b/g) ?? [])]
  fail(
    [
      'THE ARTIFACT IS NOT A BUILD OF THIS COMMIT.',
      `  HEAD                 ${headSha}`,
      found.length
        ? `  baked into handler   ${found.slice(0, 3).join('\n                       ')}`
        : '  baked into handler   (no 40-character sha found at all)',
      '',
      '  The artifact gate above passed because the artifact is well-formed. It is simply a',
      '  build of something else -- most likely a rebuild that failed and left the previous one',
      '  in place. Rebuild before deploying:',
      '',
      '    docker run --rm -e GIT_COMMIT_SHA=$(git rev-parse HEAD) ... bash /app/scripts/deploy/build-linux.sh',
    ].join('\n'),
  )
}
console.log(`  artifact commit    : ${headSha} (matches HEAD)`)

// ── 2. upload at 0% ──────────────────────────────────────────────────────────

banner('UPLOAD AT 0% TRAFFIC')
/**
 * THE COMMIT THIS ARTIFACT IS, and the deploy refuses without it.
 *
 * stdout only (see run()), and then SHAPE-CHECKED: a short sha is 7-40 hex characters and nothing
 * else. Belt and braces on purpose -- if some future failure leaks a different string into stdout,
 * the tag still cannot become a paragraph, and an unidentifiable version still cannot be uploaded.
 */
const shaRaw = run('git', ['rev-parse', '--short', 'HEAD'], { capture: true }).stdout.trim()
const sha = /^[0-9a-f]{7,40}$/.test(shaRaw) ? shaRaw : ''
if (!sha) {
  fail(
    [
      'could not resolve the commit sha from git.',
      `  git said: ${JSON.stringify(shaRaw)}`,
      '  A version that cannot identify itself must not be uploaded: /api/version would',
      '  answer null, and the 20/20 sampling that verifies a promotion would have nothing',
      '  to compare. In Docker this means the gitdir is not mounted -- the repo is a git',
      '  worktree, so .git is a pointer to a path outside the container.',
    ].join('\n'),
  )
}
const upload = run(
  'npx',
  [
    WRANGLER, 'versions', 'upload', '--config', CONFIG,
    '--tag', `deploy-${sha}`,
    '--message', `0%-traffic candidate ${sha}; NOT promoted`,
    /**
     * THE VERSION SAYS WHICH COMMIT IT IS. Without these two vars /api/version answers
     * {"commit":null}, and a deploy path that produces a version unable to identify itself can
     * silently ship anything -- there is no way to check what production is running, and the
     * 20/20 sampling that verifies a promotion has nothing to compare.
     *
     * A VAR AND NOT A BUILD-TIME VALUE, established rather than assumed: the built bundle keeps
     * the literal `GIT_COMMIT_SHA` and does not contain the sha, so app/api/version reads
     * process.env at RUNTIME. Baking it into the build would change nothing.
     *
     * Both names, because resolveCommitSha() checks GIT_COMMIT_SHA then NEXT_PUBLIC_COMMIT_SHA,
     * and the other workflows that deploy this worker set the pair together.
     */
    '--var', `GIT_COMMIT_SHA:${sha}`,
    '--var', `NEXT_PUBLIC_COMMIT_SHA:${sha}`,
  ],
  { capture: true },
)
if (upload.code !== 0) fail('upload failed')

const versionId = (upload.out.match(/Worker Version ID:\s*([0-9a-f-]{36})/) || [])[1]
const previewUrl = (upload.out.match(/Version Preview URL:\s*(https:\/\/\S+)/) || [])[1]
if (!versionId || !previewUrl) {
  fail('could not read a version id or preview URL from the upload output — refusing to continue blind')
}
console.log(`\n  version : ${versionId}\n  preview : ${previewUrl}`)

// ── 3. smoke the preview ─────────────────────────────────────────────────────

banner('SMOKE THE PREVIEW — no customer traffic has moved')
const smokeArgs = ['scripts/deploy/smoke-preview.mjs', previewUrl, '--samples', '3']
for (const m of args.filter((a, i) => args[i - 1] === '--expect')) smokeArgs.push('--expect', m)
for (const m of args.filter((a, i) => args[i - 1] === '--absent')) smokeArgs.push('--absent', m)
if (run('node', smokeArgs).code !== 0) fail('the preview is not healthy. Do not promote.')

// ── 4. record the rollback target ────────────────────────────────────────────

banner('RECORD THE ROLLBACK TARGET — before promoting, not after')
const deployments = run('npx', [WRANGLER, 'deployments', 'list', '--config', CONFIG], { capture: true })
/**
 * THE LAST `(100%)`, NOT THE FIRST.
 *
 * `wrangler deployments list` prints EVERY deployment it retains, OLDEST FIRST, and each one has
 * its own `Version(s):  (100%) <id>` line -- that marker describes the split within a deployment,
 * not which deployment is live. A non-global `.match()` returns the first hit, so this recorded
 * the OLDEST deployment on the list and called it the rollback target.
 *
 * Measured on the 2026-09-05 promotion: ten deployments listed, the first created 2026-09-03T00:43
 * and the last 2026-09-04T00:30. It recorded 9fcbd1df (the first). `wrangler versions deploy`, in
 * the very next stage, named 6d335f8a as the current version -- a day and nine deployments newer.
 * A rollback to what was written would have restored a worker that had not served in 24 hours,
 * from the one stage whose whole purpose is to know the recovery point before it is needed.
 */
const hundredPercent = [...deployments.out.matchAll(/\(100%\)\s*([0-9a-f-]{36})/g)].map((m) => m[1])
const current = hundredPercent.at(-1) ?? null
if (hundredPercent.length > 1) {
  console.log(`  ${hundredPercent.length} deployments listed; taking the newest (last) as current.`)
}
if (!current) {
  console.log('  Could not parse the current 100% version. Record it by hand before promoting.')
} else {
  try {
    run('node', ['-e', "require('node:fs').mkdirSync('.deploy',{recursive:true})"])
    writeFileSync(
      ROLLBACK_FILE,
      JSON.stringify({ rollbackTarget: current, replacedBy: versionId, sha, at: new Date().toISOString() }, null, 2),
    )
    console.log(`  rollback target: ${current}`)
    console.log(`  written to     : ${ROLLBACK_FILE}`)
  } catch (err) {
    console.log(`  could not write ${ROLLBACK_FILE}: ${err.message}. Record ${current} by hand.`)
  }
}

// ── 5. promote, or stop ──────────────────────────────────────────────────────

if (!has('--promote')) {
  console.log('\n' + '='.repeat(72))
  console.log('  STOPPING BEFORE PROMOTION. No customer traffic has moved.')
  console.log('='.repeat(72))
  console.log(`\n  The candidate is live at 0%: ${previewUrl}`)
  console.log('  To promote:')
  console.log('    node scripts/deploy/deploy-production.mjs --promote --i-have-read-the-runbook')
  if (current) console.log(`\n  To roll back afterwards:  --rollback ${current}`)
  process.exit(0)
}

if (!has('--i-have-read-the-runbook')) {
  fail(
    '--promote also requires --i-have-read-the-runbook. One flag is a typo away from moving ' +
      'production; two is a decision.',
  )
}

banner('PROMOTE TO 100%')
if (run('npx', [WRANGLER, 'versions', 'deploy', '--config', CONFIG, `${versionId}@100`, '-y']).code !== 0) {
  fail(`promotion failed. The previous version ${current ?? '(see deployments list)'} is still serving.`)
}

// ── 6. watch ─────────────────────────────────────────────────────────────────

banner('LIVE HEALTH — sampled, because rollout is gradual')
const live = run('node', ['scripts/deploy/smoke-preview.mjs', LIVE_URL, '--samples', '20'])
if (live.code !== 0) {
  console.error('\nTHE LIVE SITE IS UNHEALTHY AFTER PROMOTION.')
  if (current) {
    console.error(`ROLL BACK NOW:\n  node scripts/deploy/deploy-production.mjs --rollback ${current}`)
  }
  process.exit(1)
}

console.log(`\nPromoted ${versionId} (${sha}).`)
if (existsSync(ROLLBACK_FILE)) {
  console.log(`Rollback target recorded in ${ROLLBACK_FILE}: ${JSON.parse(readFileSync(ROLLBACK_FILE, 'utf8')).rollbackTarget}`)
}
