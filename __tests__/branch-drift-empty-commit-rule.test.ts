import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * THE DRIFT CHECK'S EMPTY-COMMIT EXCLUSION CANNOT SWALLOW A REAL COMMIT.
 *
 * `check-branch-drift.mjs` stopped reporting empty commits on 2026-08-25, because the
 * `probe-302-305-production` workflow writes `--allow-empty` marker commits to `main` and nowhere
 * else — eighteen of them had accumulated and they buried the one real finding in the same list.
 *
 * An exclusion in a blocking check is the most dangerous thing in it: it is the one code path whose
 * job is to make the alarm not fire. So it is tested against a REAL GIT REPOSITORY, built here,
 * rather than by asserting on the source text — the question is what the script does, not what it
 * says.
 *
 * The three cases that matter, and the middle one is the whole point:
 *
 *   empty commit, marker subject      -> excluded (that is the fix)
 *   MARKER SUBJECT, BUT TOUCHES A FILE -> STILL REPORTED (it must not be swallowed)
 *   ordinary commit, no marker         -> still reported (the check still works at all)
 */
const SCRIPT = join(__dirname, '..', 'scripts', 'check-branch-drift.mjs')

let repo: string
const git = (args: string[], cwd = repo) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })

/** Runs the real script against the scratch repo. Returns exit code plus stdout. */
function runCheck(base: string, head: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [SCRIPT, base, head], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { code: 0, out }
  } catch (err: any) {
    return { code: err.status ?? 1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'drift-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Drift Test'])
  // The script resolves refs as `origin/<branch>`, so give the scratch repo those names locally.
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  git(['add', 'seed.txt'])
  git(['commit', '-q', '-m', 'seed'])
  git(['branch', 'origin/cloudflare-staging'])

  // --- main gains three commits that staging will never receive.
  // 1. an empty marker commit — the case being excluded
  git(['commit', '-q', '--allow-empty', '-m', 'probe: re-verify redaction [probe-302-305-production]'])
  // 2. a marker-subject commit that DOES touch a runtime file — must still be reported
  mkdirSync(join(repo, 'lib'), { recursive: true })
  writeFileSync(join(repo, 'lib', 'real.ts'), 'export const real = 1\n')
  git(['add', 'lib/real.ts'])
  git(['commit', '-q', '-m', 'probe: looks generated but ships code [probe-302-305-production]'])
  // 3. an ordinary commit with no marker at all
  writeFileSync(join(repo, 'lib', 'ordinary.ts'), 'export const ordinary = 1\n')
  git(['add', 'lib/ordinary.ts'])
  git(['commit', '-q', '-m', 'fix: an ordinary change staging lacks'])
  git(['branch', '-f', 'origin/main', 'main'])
})

afterAll(() => {
  try {
    rmSync(repo, { recursive: true, force: true })
  } catch {
    /* Windows can hold a handle on .git; a leaked temp dir is not worth failing a suite over. */
  }
})

describe('the empty-commit exclusion', () => {
  it('CONTROL: the check runs against this scratch repo at all, and reports drift', () => {
    // Without this, every assertion below could pass because the script crashed and printed nothing.
    const { out } = runCheck('origin/main', 'origin/cloudflare-staging')
    expect(out).toContain('branch drift')
    expect(out).toMatch(/origin\/main is ahead by 3 commit\(s\) by patch-id/)
  })

  it('excludes the empty marker commit — it is classified NO CONTENT', () => {
    const { out } = runCheck('origin/main', 'origin/cloudflare-staging')
    expect(out).toMatch(/1 NO CONTENT \(empty commits — 1 from the probe-302-305 workflow\)/)
    expect(out).not.toMatch(/NEW DRIFT[\s\S]*re-verify redaction/)
  })

  it('DOES NOT swallow a marker-subject commit that touches a file', () => {
    // The load-bearing assertion. A subject-text exclusion would have hidden this one.
    const { out, code } = runCheck('origin/main', 'origin/cloudflare-staging')
    expect(out).toContain('looks generated but ships code')
    expect(code).toBe(1)
  })

  it('still reports an ordinary commit, so the check has not been switched off', () => {
    const { out } = runCheck('origin/main', 'origin/cloudflare-staging')
    expect(out).toContain('an ordinary change staging lacks')
  })

  it('fails with exit 1 while any real commit is missing — the gate still blocks', () => {
    expect(runCheck('origin/main', 'origin/cloudflare-staging').code).toBe(1)
  })

  it('goes GREEN once the two real commits are reconciled, and the empty one never mattered', () => {
    // Proves the exclusion is what is left standing: staging takes only the two file-bearing
    // commits, never the empty one, and the check clears.
    // Cherry-pick onto a DETACHED head, then move the branch ref. `git branch -f` refuses to move
    // a branch that is checked out, so checking `origin/cloudflare-staging` out directly and then
    // forcing it is a fatal, not a test failure — which is what the first version of this did.
    const marker = git(['rev-parse', 'main~2']).trim()
    git(['checkout', '-q', '--detach', 'origin/cloudflare-staging'])
    git(['cherry-pick', '-x', git(['rev-parse', 'main~1']).trim()])
    git(['cherry-pick', '-x', git(['rev-parse', 'main']).trim()])
    const reconciled = git(['rev-parse', 'HEAD']).trim()
    git(['checkout', '-q', 'main'])
    git(['branch', '-f', 'origin/cloudflare-staging', reconciled])

    // Control: the empty marker commit was NOT taken, so what follows is the exclusion doing the
    // work rather than the gap simply having been closed.
    const staged = git(['log', '--format=%H', 'origin/cloudflare-staging'])
    expect(staged).not.toContain(marker)
    const { out, code } = runCheck('origin/main', 'origin/cloudflare-staging')
    expect(code).toBe(0)
    expect(out).toMatch(/NO CONTENT/)
  })
})
