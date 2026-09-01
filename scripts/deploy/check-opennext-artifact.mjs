#!/usr/bin/env node
/**
 * REFUSE TO SHIP A MALFORMED OpenNext ARTIFACT.
 *
 * ============================================================================================
 * THE OUTAGE THIS EXISTS FOR
 * ============================================================================================
 *
 * 2026-09-01. A Worker built on Windows was uploaded to flashtap-production and every route
 * returned 500 — the whole site, mid-day. Rolled back in about three and a half minutes.
 *
 * The build had succeeded. `next build` was green, the OpenNext step was green, `wrangler deploy`
 * was green, and the artifact was ~10.4 MB SHORT: on Windows the Turbopack server chunks are not
 * inlined into the handler, so `handler.mjs` came out at 2.95 MB where the Linux build produces
 * 13.36 MB. Nothing in the toolchain treats that as an error. The first thing that notices is a
 * customer.
 *
 * Diagnosis then cost more than the outage, because a downloaded "known-good" artifact was used
 * as the comparison baseline and turned out to be the broken upload itself — Cloudflare's
 * content endpoint returns the LATEST upload, not the version you asked for. The tell that
 * finally settled it was `outputFileTracingRoot` still reading a Windows path.
 *
 * ============================================================================================
 * WHY THREE CHECKS AND NOT ONE
 * ============================================================================================
 *
 * Each catches the fault at a different level, and the cheapest one to fool is listed first:
 *
 *   1. SIZE FLOOR      — blunt, and would catch any future omission of comparable weight.
 *   2. TRACING ROOT    — causal. A Windows path here means the build genuinely ran on Windows,
 *                        whatever the file size happens to be.
 *   3. CHUNK INLINING  — the actual defect. A chunk that is REFERENCED but never INLINED appears
 *                        once instead of twice; that single occurrence is the import that will
 *                        resolve to nothing at runtime and 500 the route.
 *
 * A size floor alone would pass a Windows build that happened to be large. A tracing-root check
 * alone would pass a Linux build that dropped chunks for some other reason. Together they are
 * hard to satisfy accidentally.
 *
 * ============================================================================================
 * IT SELF-TESTS BEFORE IT REPORTS
 * ============================================================================================
 *
 * A checker that has quietly stopped detecting exits 0 and looks exactly like a clean artifact.
 * So the predicates are run against a known-bad and a known-good synthetic sample first, and the
 * script refuses to give a verdict at all if either misclassifies.
 *
 * Usage:
 *   node scripts/deploy/check-opennext-artifact.mjs [path/to/.open-next]
 * Exit 0 = safe to upload. Exit 1 = do not upload, do not promote.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Linux build measured 13,374,852 bytes on 2026-09-01; the Windows build 2,952,000-ish.
 * The floor sits far below the good value and far above the bad one, so ordinary growth or
 * shrinkage of the app never trips it.
 */
const MIN_HANDLER_BYTES = 8_000_000

/**
 * Chunks Turbopack emits and OpenNext inlines. Each should appear at least TWICE in a healthy
 * handler: once where it is referenced, once where its body is inlined. The list is a sample,
 * not an inventory — one is enough to detect the fault, and a long list would rot.
 */
const INLINED_CHUNK_SAMPLES = ['instrumentation_ts', '[root-of-the-server]']

const HANDLER_REL = join('server-functions', 'default', 'handler.mjs')

// ── the predicates, isolated so they can be self-tested ──────────────────────

/** A tracing root that names a Windows path proves where the build ran. */
export function findWindowsTracingRoot(source) {
  const hits = [...source.matchAll(/outputFileTracingRoot\s*:\s*"((?:[^"\\]|\\.){0,400})"/g)]
  for (const m of hits) {
    const value = m[1]
    // `\\` in the JS source is one backslash in the value; a drive letter is the other tell.
    if (/^[A-Za-z]:/.test(value) || value.includes('\\')) return value
  }
  return null
}

/** Chunk names present but referenced only once — declared, never inlined. */
export function findUninlinedChunks(source, samples = INLINED_CHUNK_SAMPLES) {
  const out = []
  for (const name of samples) {
    // Count occurrences of the literal name.
    let count = 0
    let idx = source.indexOf(name)
    while (idx !== -1) {
      count += 1
      idx = source.indexOf(name, idx + name.length)
    }
    if (count === 1) out.push({ name, count })
  }
  return out
}

// ── self-test ────────────────────────────────────────────────────────────────

const GOOD_SAMPLE =
  'x'.repeat(50) +
  'outputFileTracingRoot:"/app",' +
  'require("instrumentation_ts_cf8be71b._.js");' +
  'const instrumentation_ts_cf8be71b = function(){};' +
  '[root-of-the-server]__dd6aea59._.js ; [root-of-the-server]__dd6aea59._.js'

const BAD_SAMPLE =
  'x'.repeat(50) +
  'outputFileTracingRoot:"D:\\\\dev\\\\flashtap\\\\build",' +
  'require("instrumentation_ts_cf8be71b._.js");'

function selfTest() {
  const failures = []

  if (findWindowsTracingRoot(BAD_SAMPLE) === null) {
    failures.push('tracing-root detector failed to flag a Windows path')
  }
  if (findWindowsTracingRoot(GOOD_SAMPLE) !== null) {
    failures.push('tracing-root detector flagged a Linux path')
  }
  if (findUninlinedChunks(BAD_SAMPLE).length === 0) {
    failures.push('chunk detector failed to flag a chunk referenced once')
  }
  if (findUninlinedChunks(GOOD_SAMPLE).length !== 0) {
    failures.push('chunk detector flagged a properly inlined chunk')
  }

  return failures
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const selfTestFailures = selfTest()
  if (selfTestFailures.length) {
    console.error('ARTIFACT CHECK ABORTED — the checker cannot verify itself:')
    for (const f of selfTestFailures) console.error(`  - ${f}`)
    console.error('\nRefusing to give a verdict. A detector that has stopped detecting looks')
    console.error('exactly like a clean artifact, and that is how the outage shipped.')
    return 1
  }

  const root = process.argv[2] ?? '.open-next'
  const handler = join(root, HANDLER_REL)

  console.log('OpenNext artifact check')
  console.log(`  self-test        : PASS (both detectors classify a known-good and known-bad sample)`)
  console.log(`  artifact         : ${handler}`)

  if (!existsSync(handler)) {
    console.error(`\nFAIL: no handler at ${handler}. Was the build run at all?`)
    return 1
  }

  const bytes = statSync(handler).size
  const source = readFileSync(handler, 'utf8')
  const problems = []

  console.log(`  handler.mjs      : ${bytes.toLocaleString()} B`)

  if (bytes < MIN_HANDLER_BYTES) {
    problems.push(
      `handler.mjs is ${bytes.toLocaleString()} B, below the ${MIN_HANDLER_BYTES.toLocaleString()} B floor. ` +
        'The Windows build omits ~10.4 MB of inlined Turbopack server chunks and produces roughly 2.95 MB.',
    )
  }

  const winRoot = findWindowsTracingRoot(source)
  console.log(`  tracingRoot      : ${winRoot ? `WINDOWS -> ${winRoot}` : 'not a Windows path'}`)
  if (winRoot) {
    problems.push(
      `outputFileTracingRoot is a Windows path (${winRoot}). This artifact was built on Windows and ` +
        'will 500 on every route. Build in Docker: node:20-bookworm.',
    )
  }

  const uninlined = findUninlinedChunks(source)
  console.log(
    `  chunk inlining   : ${uninlined.length === 0 ? 'chunks appear more than once (inlined)' : `${uninlined.length} referenced but NOT inlined`}`,
  )
  for (const u of uninlined) {
    problems.push(`chunk "${u.name}" appears exactly once — referenced but never inlined.`)
  }

  if (problems.length) {
    console.error('\nDO NOT UPLOAD. DO NOT PROMOTE.\n')
    for (const p of problems) console.error(`  FAIL: ${p}`)
    console.error('\nThe proven build path is Docker Linux:')
    console.error('  docker run --rm -v "<repo>:/app" -w /app node:20-bookworm bash /app/scripts/deploy/build-linux.sh')
    return 1
  }

  console.log('\nPASS — artifact is Linux-built and complete. Safe to upload at 0% traffic.')
  return 0
}

// Only run when invoked directly, so the predicates can be imported by tests.
const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-opennext-artifact.mjs')
if (invokedDirectly) {
  process.exit(main())
}
