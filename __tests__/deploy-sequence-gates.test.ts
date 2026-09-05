/**
 * The deploy sequence cannot skip its own gates, and cannot promote by accident.
 *
 * `check-opennext-artifact.mjs` refuses a malformed artifact — but only if somebody runs it. The
 * 2026-09-01 outage was not caused by a missing check; it was caused by `wrangler deploy` being
 * the shortest path to production. These tests hold the property that closes that: the safe path
 * is the short path, and the unsafe one is not reachable in a hurry.
 *
 * Everything here runs the real script with `--rollback`-less, network-free arguments, or reads
 * its source. NOTHING uploads, promotes or contacts Cloudflare: the script exits at the artifact
 * gate long before it would, which is itself the first property under test.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'deploy', 'deploy-production.mjs')
const source = readFileSync(SCRIPT, 'utf8')

/**
 * TEMP DIRECTORIES LIVE BESIDE THE REPO, NOT IN THE SYSTEM TEMP.
 *
 * These fixtures are ~10 MB each, because the artifact gate has an 8 MB size floor and a test
 * that cannot clear it would be testing nothing. os.tmpdir() is on the system drive, and when
 * that drive filled up every one of these failed with ENOSPC — an environmental failure that
 * reads exactly like a broken gate. The repo's own drive is where the build output already goes,
 * so it is the honest place for the fixtures too.
 */
const TMP_ROOT = join(ROOT, '.tmp-tests')
mkdirSync(TMP_ROOT, { recursive: true })

const created: string[] = []
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true })
})

/** Runs the sequence in a throwaway cwd, so the real .open-next is never consulted. */
function runIn(dir: string, args: string[] = []) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function workspace(withArtifact: 'none' | 'windows' | 'linux') {
  const dir = mkdtempSync(join(TMP_ROOT, 'deployseq-'))
  created.push(dir)
  // The scripts the sequence shells out to must be reachable from the temp cwd.
  mkdirSync(join(dir, 'scripts', 'deploy'), { recursive: true })
  for (const f of ['check-opennext-artifact.mjs', 'smoke-preview.mjs']) {
    writeFileSync(join(dir, 'scripts', 'deploy', f), readFileSync(join(ROOT, 'scripts', 'deploy', f)))
  }
  if (withArtifact !== 'none') {
    const handlerDir = join(dir, '.open-next', 'server-functions', 'default')
    mkdirSync(handlerDir, { recursive: true })
    const BACKSLASH = String.fromCharCode(92)
    const body =
      withArtifact === 'windows'
        ? `outputFileTracingRoot:"D:${BACKSLASH}${BACKSLASH}dev";require("instrumentation_ts_x._.js");`
        : 'outputFileTracingRoot:"/app";require("instrumentation_ts_x._.js"); const instrumentation_ts_x = 1;'
    const pad = 'x'.repeat(Math.max(0, 10_000_000 - body.length))
    writeFileSync(join(handlerDir, 'handler.mjs'), body + pad)
  }
  return dir
}

describe('the sequence refuses to start without a good artifact', () => {
  it('stops when there is no artifact at all, rather than uploading nothing', () => {
    const r = runIn(workspace('none'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/no artifact found/)
    expect(r.out).toMatch(/Build it in Docker/)
    // It must not have reached the upload stage.
    expect(r.out).not.toMatch(/STAGE 2/)
  })

  /** THE OUTAGE, as a gate. */
  it('stops on a Windows-built artifact and names the outage it prevents', () => {
    const r = runIn(workspace('windows'))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/malformed/)
    expect(r.out).toMatch(/2026-09-01/)
    expect(r.out).not.toMatch(/STAGE 2/)
  })

  it('gets past the gate on a good Linux artifact', () => {
    // It then fails at the upload stage for want of credentials, which is the point: stage 1
    // passed. Without this the tests above could be satisfied by a script that refuses everything.
    const r = runIn(workspace('linux'))
    expect(r.out).toMatch(/STAGE 1: VERIFY THE ARTIFACT/)
    expect(r.out).toMatch(/PASS/)
    expect(r.out).toMatch(/STAGE 2: UPLOAD AT 0% TRAFFIC/)
  })
})

describe('promotion is opt-in and needs two deliberate flags', () => {
  it('--promote alone is refused', () => {
    const r = runIn(workspace('windows'), ['--promote'])
    // It never even gets to the flag check — the artifact gate stops it first, which is the
    // correct ordering: a bad artifact is refused whatever flags accompany it.
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/malformed/)
  })

  it('the second flag is required, and the source says why', () => {
    expect(source).toMatch(/--i-have-read-the-runbook/)
    expect(source).toMatch(/One flag is a typo away from moving/)
  })

  it('there is no --force ESCAPE HATCH', () => {
    // Asserting the string is absent would fail on the sentence that promises it is: the script
    // says "There is no --force" out loud. What must be absent is a --force that the argument
    // parser can act on.
    expect(source).not.toMatch(/has\('--force'\)/)
    expect(source).not.toMatch(/valueOf\('--force'\)/)
    expect(source).toMatch(/There is no --force/)
  })
})

describe('the ordering is the safety property', () => {
  const order = ['VERIFY THE ARTIFACT', 'UPLOAD AT 0% TRAFFIC', 'SMOKE THE PREVIEW', 'RECORD THE ROLLBACK TARGET', 'PROMOTE TO 100%', 'LIVE HEALTH']

  it('each stage appears in the source before the one that costs more', () => {
    const positions = order.map((s) => source.indexOf(s))
    for (const p of positions) expect(p).toBeGreaterThan(-1)
    const sorted = [...positions].sort((a, b) => a - b)
    expect(positions).toEqual(sorted)
  })

  it('the rollback target is recorded BEFORE the promotion, not after', () => {
    expect(source.indexOf('RECORD THE ROLLBACK TARGET')).toBeLessThan(source.indexOf('PROMOTE TO 100%'))
  })

  /**
   * Recording the target early is worthless if the target is the wrong version.
   *
   * `wrangler deployments list` prints every retained deployment OLDEST FIRST, and each carries
   * its own `Version(s): (100%) <id>` line — that marker is the traffic split WITHIN a deployment,
   * not a mark on the live one. A non-global `.match()` therefore returned the OLDEST. Measured on
   * the 2026-09-05 promotion: ten deployments, it recorded one from a day and nine deployments
   * earlier, while `wrangler versions deploy` named the real current version in the next stage.
   *
   * The fixture below is that real output, trimmed to its first and last entries.
   */
  describe('the recorded target is the version that was actually serving', () => {
    const LIST = [
      'Created:     2026-09-03T00:43:31.864Z',
      'Version(s):  (100%) 9fcbd1df-0fda-4729-bfa6-68c97aec2608',
      '',
      'Created:     2026-09-04T00:30:47.191Z',
      'Version(s):  (100%) 6d335f8a-4b97-41d4-bbda-e5c6fc7da517',
    ].join('\n')
    const NEWEST = '6d335f8a-4b97-41d4-bbda-e5c6fc7da517'
    const OLDEST = '9fcbd1df-0fda-4729-bfa6-68c97aec2608'

    /** The extraction the script performs, modelled here so the property is executable. */
    const pick = (out: string) =>
      [...out.matchAll(/\(100%\)\s*([0-9a-f-]{36})/g)].map((m) => m[1]).at(-1) ?? null

    it('picks the newest deployment, not the first one printed', () => {
      expect(pick(LIST)).toBe(NEWEST)
      expect(pick(LIST)).not.toBe(OLDEST)
    })

    it('still works when there is exactly one deployment', () => {
      expect(pick(`Version(s):  (100%) ${NEWEST}`)).toBe(NEWEST)
    })

    it('answers null — not undefined — when nothing can be parsed, so the by-hand branch fires', () => {
      expect(pick('')).toBeNull()
    })

    it('the script uses that extraction, and not the first-match form that was wrong', () => {
      const stage = source.slice(
        source.indexOf('RECORD THE ROLLBACK TARGET'),
        source.indexOf('PROMOTE TO 100%'),
      )
      expect(stage).toMatch(/matchAll\(\/\\\(100%\\\)/)
      expect(stage).toMatch(/\.at\(-1\)/)
      // The exact expression that recorded a stale target. It must not come back.
      expect(stage).not.toMatch(/out\.match\(\/\\\(100%\\\)/)
    })
  })

  it('the live check samples rather than spot-checking, because rollout is gradual', () => {
    const liveCheck = source.slice(source.indexOf('LIVE HEALTH'))
    expect(liveCheck).toMatch(/--samples', '20'/)
  })

  it('a failed promotion tells you the version that is still serving', () => {
    expect(source).toMatch(/is still serving/)
  })

  it('an unhealthy live site prints the rollback command', () => {
    expect(source).toMatch(/ROLL BACK NOW/)
    expect(source).toMatch(/--rollback \$\{current\}/)
  })
})

describe('the runbook and the script agree', () => {
  const runbook = readFileSync(join(ROOT, 'docs', 'production-deploy-runbook.md'), 'utf8')

  it('the runbook names the one-command sequence', () => {
    expect(runbook).toMatch(/deploy-production\.mjs/)
  })

  it('both insist the build happens in Docker, never on the host', () => {
    expect(source).toMatch(/node:20-bookworm/)
    expect(runbook).toMatch(/node:20-bookworm/)
  })
})
