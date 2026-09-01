/**
 * The gate that would have stopped the 2026-09-01 production outage.
 *
 * A Windows-built OpenNext artifact omits ~10.4 MB of inlined Turbopack server chunks. Every build
 * step reports success and every route 500s. `scripts/deploy/check-opennext-artifact.mjs` is what
 * refuses it; this is what refuses a version of that script which has stopped detecting.
 *
 * ============================================================================================
 * WHY THIS RUNS THE SCRIPT INSTEAD OF IMPORTING ITS FUNCTIONS
 * ============================================================================================
 *
 * The first draft imported the two predicates directly. Jest treats `.mjs` as ESM whatever the
 * transform says, so the suite died on "Cannot use import statement outside a module" — and died
 * as a suite that failed to LOAD, reporting `Tests: 0 total` rather than a failing assertion.
 * A `.mjs` transform was added to jest.config.ts, did not fix it, and was reverted rather than
 * left behind looking like it worked.
 *
 * Running the script is the better test anyway. The gate's contract is not "these two functions
 * return the right value" — it is "this exits non-zero and refuses to upload". A unit test of the
 * predicates would pass even if the script forgot to call them, forgot to exit 1, or never ran at
 * all because its main-module guard silently failed on Windows (a real failure mode in this repo:
 * a hand-built `file://` comparison that never matched, so a CI step passed having run nothing).
 * Executing it end-to-end catches every one of those.
 *
 * ============================================================================================
 * THE FIXTURES ARE THE REAL SIGNATURES
 * ============================================================================================
 *
 * Measured on 2026-09-01 from the two artifacts themselves:
 *
 *   broken : handler.mjs 2,954,790 B, outputFileTracingRoot "D:\dev\flashtap\build",
 *            instrumentation chunk referenced exactly once
 *   good   : handler.mjs 13,374,852 B, outputFileTracingRoot "/app", every chunk twice
 *
 * The script was run against both REAL artifacts before this file was written — exit 1 on the
 * broken one, exit 0 on the one that deployed successfully.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const SCRIPT = join(ROOT, 'scripts', 'deploy', 'check-opennext-artifact.mjs')
const BACKSLASH = String.fromCharCode(92)
/** `outputFileTracingRoot:"D:\\dev\\flashtap\\build"` as it appears in the bundled source. */
const WINDOWS_ROOT = `outputFileTracingRoot:"D:${BACKSLASH}${BACKSLASH}dev${BACKSLASH}${BACKSLASH}flashtap"`
const LINUX_ROOT = 'outputFileTracingRoot:"/app"'

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
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
})

/** Writes a fake .open-next tree and returns its path. */
function artifact(body: string, padToBytes: number): string {
  const root = mkdtempSync(join(TMP_ROOT, 'opennext-'))
  created.push(root)
  const dir = join(root, 'server-functions', 'default')
  mkdirSync(dir, { recursive: true })
  const padding = 'x'.repeat(Math.max(0, padToBytes - body.length))
  writeFileSync(join(dir, 'handler.mjs'), body + padding, 'utf8')
  return root
}

function runGate(path: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, path], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const CHUNK = 'instrumentation_ts_cf8be71b._.js'
const INLINED = `require("${CHUNK}"); const instrumentation_ts_cf8be71b = 1;`
const REFERENCED_ONCE = `require("${CHUNK}");`

const TEN_MB = 10_000_000

describe('the gate refuses a Windows-built artifact', () => {
  it('exits non-zero on the real broken signature', () => {
    const r = runGate(artifact(`${WINDOWS_ROOT};${REFERENCED_ONCE}`, 2_954_790))
    expect(r.code).toBe(1)
    expect(r.out).toContain('DO NOT UPLOAD')
  })

  it('names the Windows tracing root as the reason', () => {
    const r = runGate(artifact(`${WINDOWS_ROOT};${INLINED}`, TEN_MB))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/built on Windows/)
  })

  it('rejects an undersized handler even with a Linux tracing root', () => {
    const r = runGate(artifact(`${LINUX_ROOT};${INLINED}`, 2_954_790))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/below the/)
  })

  it('rejects a chunk that is referenced but never inlined', () => {
    const r = runGate(artifact(`${LINUX_ROOT};${REFERENCED_ONCE}`, TEN_MB))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/referenced but never inlined/)
  })

  it('refuses when there is no artifact at all, rather than passing vacuously', () => {
    const empty = mkdtempSync(join(TMP_ROOT, 'opennext-empty-'))
    created.push(empty)
    const r = runGate(empty)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/no handler/)
  })
})

describe('the gate passes a good Linux artifact', () => {
  it('exits zero on the shape that deployed successfully', () => {
    const r = runGate(artifact(`${LINUX_ROOT};${INLINED}`, TEN_MB))
    expect(r.code).toBe(0)
    expect(r.out).toContain('PASS')
    expect(r.out).toContain('Safe to upload at 0% traffic')
  })

  /**
   * The all-clear must be earned. If this ever fails while the tests above still pass, the gate
   * has become one that refuses everything — which stops deploys just as effectively as one that
   * refuses nothing, and gets switched off.
   */
  it('does not simply refuse everything', () => {
    expect(runGate(artifact(`${LINUX_ROOT};${INLINED}`, TEN_MB)).code).toBe(0)
    expect(runGate(artifact(`${WINDOWS_ROOT};${REFERENCED_ONCE}`, 2_954_790)).code).toBe(1)
  })
})

describe('the gate verifies itself before giving a verdict', () => {
  it('reports its own self-test in the output', () => {
    // A detector that has quietly stopped detecting exits 0 and looks exactly like a clean
    // artifact. The script proves both detectors still classify a known-good and known-bad
    // sample before it says anything about the real one.
    const r = runGate(artifact(`${LINUX_ROOT};${INLINED}`, TEN_MB))
    expect(r.out).toMatch(/self-test\s*:\s*PASS/)
  })
})
