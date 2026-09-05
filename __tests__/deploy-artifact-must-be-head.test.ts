/**
 * THE ARTIFACT MUST BE A BUILD OF THE COMMIT BEING DEPLOYED.
 *
 * ============================================================================================
 * THE INCIDENT THIS PINS, 2026-09-05
 * ============================================================================================
 *
 * A `build-linux.sh` run was killed mid-`npm ci` by host memory pressure, leaving the PREVIOUS
 * build in `.open-next` -- complete, valid, Linux-built, 13.5 MB. `check-opennext-artifact.mjs`
 * passed it, because that gate asks whether the artifact is WELL-FORMED and never which commit it
 * is.
 *
 * Deploying then would have tagged `deploy-<new sha>`, set `--var GIT_COMMIT_SHA=<new sha>`, and
 * shipped the OLD bundle: /api/version answering the new sha while running the old code, with the
 * 20/20 sampling confirming it. Every gate in the sequence would have agreed on a false answer.
 *
 * These tests run the REAL script against real fixture artifacts. They do not re-implement the
 * check -- a mutation that removes it from the script fails them.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'deploy', 'deploy-production.mjs')
const source = readFileSync(SCRIPT, 'utf8')

/**
 * Fixtures live beside the repo, not in os.tmpdir(): the artifact gate has an 8 MB size floor, so
 * a fixture that cannot clear it would be testing nothing, and the system drive on this machine
 * has filled up before -- an ENOSPC failure reads exactly like a broken gate.
 */
const TMP_ROOT = join(ROOT, '.tmp-tests')
mkdirSync(TMP_ROOT, { recursive: true })
const created: string[] = []
afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true })
})

const REAL_SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)

/**
 * An artifact that satisfies the artifact gate: >8 MB, no Windows tracing root, chunk names
 * appearing more than once. `bakedSha` is null to model a build made before the sha was inlined.
 */
function makeArtifact(dir: string, bakedSha: string | null): void {
  // The sequence shells out to these relative to cwd, so they must exist in the fixture.
  mkdirSync(join(dir, 'scripts', 'deploy'), { recursive: true })
  for (const f of ['check-opennext-artifact.mjs', 'smoke-preview.mjs']) {
    writeFileSync(join(dir, 'scripts', 'deploy', f), readFileSync(join(ROOT, 'scripts', 'deploy', f)))
  }
  const fnDir = join(dir, '.open-next', 'server-functions', 'default')
  mkdirSync(fnDir, { recursive: true })
  // The same body the existing deploy-sequence fixture uses for a KNOWN-GOOD Linux artifact, so
  // this suite is not also silently testing whether it can fool the artifact gate.
  const body =
    'outputFileTracingRoot:"/app";require("instrumentation_ts_x._.js"); const instrumentation_ts_x = 1;' +
    (bakedSha ? `const COMMIT=${JSON.stringify(bakedSha)};` : '')
  const pad = 'x'.repeat(Math.max(0, 10_000_000 - body.length))
  writeFileSync(join(fnDir, 'handler.mjs'), body + pad)
  mkdirSync(join(dir, '.open-next', 'assets'), { recursive: true })
  created.push(dir)
}

/** Runs the sequence in a throwaway cwd with a stubbed `git rev-parse` answering REAL_SHA. */
function runIn(dir: string): { code: number; out: string } {
  // A `git` shim on PATH, so the fixture cwd has a deterministic HEAD without being a repo.
  const binDir = join(dir, 'fakebin')
  mkdirSync(binDir, { recursive: true })
  const isWin = process.platform === 'win32'
  if (isWin) {
    writeFileSync(
      join(binDir, 'git.cmd'),
      `@echo off\r\nif "%1"=="rev-parse" (\r\n  if "%2"=="--short" (echo ${REAL_SHA.slice(0, 8)}) else (echo ${REAL_SHA})\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n`,
    )
  } else {
    const p = join(binDir, 'git')
    writeFileSync(
      p,
      `#!/bin/sh\nif [ "$1" = "rev-parse" ]; then\n  if [ "$2" = "--short" ]; then echo ${REAL_SHA.slice(0, 8)}; else echo ${REAL_SHA}; fi\n  exit 0\nfi\nexit 1\n`,
      { mode: 0o755 },
    )
  }
  try {
    const out = execFileSync(process.execPath, [SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PATH: `${binDir}${isWin ? ';' : ':'}${process.env.PATH ?? ''}` },
    })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('the artifact must be a build of this commit', () => {
  it('REFUSES an artifact baked with a different commit — the 2026-09-05 case', () => {
    const dir = join(TMP_ROOT, `stale-${Date.now()}`)
    makeArtifact(dir, OTHER_SHA)
    const { code, out } = runIn(dir)

    expect(code).not.toBe(0)
    expect(out).toContain('THE ARTIFACT IS NOT A BUILD OF THIS COMMIT')
    // It must say WHICH commit it actually has, or the operator cannot act on it.
    expect(out).toContain(OTHER_SHA)
    expect(out).toContain(REAL_SHA)
    // And it must stop BEFORE uploading anything.
    expect(out).not.toContain('UPLOAD AT 0% TRAFFIC')
  })

  it('REFUSES an artifact with no baked sha at all, and says so distinctly', () => {
    const dir = join(TMP_ROOT, `nosha-${Date.now()}`)
    makeArtifact(dir, null)
    const { code, out } = runIn(dir)

    expect(code).not.toBe(0)
    expect(out).toContain('THE ARTIFACT IS NOT A BUILD OF THIS COMMIT')
    expect(out).toContain('no 40-character sha found at all')
    expect(out).not.toContain('UPLOAD AT 0% TRAFFIC')
  })

  it('ACCEPTS an artifact baked with this commit, and reaches the upload stage', () => {
    // The positive control. Without it, a check that refuses EVERYTHING would pass the two tests
    // above and block every deploy -- "it refused" is not evidence that it discriminates.
    const dir = join(TMP_ROOT, `good-${Date.now()}`)
    makeArtifact(dir, REAL_SHA)
    const { out } = runIn(dir)

    expect(out).toContain(`artifact commit    : ${REAL_SHA} (matches HEAD)`)
    // It gets past stage 1. (It then fails at the real wrangler upload, which is expected here
    // and is not what this asserts.)
    expect(out).toContain('UPLOAD AT 0% TRAFFIC')
  })

  it('checks the commit AFTER the malformed-artifact gate, so the cheaper failure reports first', () => {
    const gateAt = source.indexOf('the artifact is malformed')
    const shaAt = source.indexOf('THE ARTIFACT IS NOT A BUILD OF THIS COMMIT')
    expect(gateAt).toBeGreaterThan(-1)
    expect(shaAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(shaAt)
  })

  it('does the check BEFORE the upload stage, not after', () => {
    expect(source.indexOf('THE ARTIFACT IS NOT A BUILD OF THIS COMMIT')).toBeLessThan(
      source.indexOf('UPLOAD AT 0% TRAFFIC'),
    )
  })
})
