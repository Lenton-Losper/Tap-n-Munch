#!/usr/bin/env node
/**
 * EVERY NAME REFERENCED IN A `@ts-nocheck` FILE MUST ACTUALLY EXIST — INCLUDING THE ONES NOBODY
 * IMPORTED.
 *
 * `check-nocheck-imports-resolve.mjs` proves that each named IMPORT in a pragma'd file exists in the
 * module it names. That closes one half. This closes the other, and the other half is the one that
 * has now taken production down.
 *
 * THE DEMONSTRATED GAP (2026-08-26, mutation-testing #350). A real call in
 * `components/orders-dashboard.tsx` was replaced with a name that exists nowhere:
 *
 *     startFeedFallback({ ... })   ->   noFallbackAtAll({ ... })
 *
 *   tsc --noEmit                      GREEN — `@ts-nocheck` makes the compiler skip the file
 *   check-nocheck-imports-resolve     GREEN — `noFallbackAtAll` is not an import, so it is invisible
 *   jest (211 suites)                 GREEN — an unbound name is `undefined`, not a throw
 *
 * Only a hand-written source-wiring assertion caught it, and only because someone had thought to
 * write one for that specific call. That is the same shape as the outage that blanked the staff
 * dashboard in front of a venue that morning.
 *
 * HOW IT WORKS. The pragma is removed IN MEMORY and the real TypeScript compiler is asked ONE
 * question about the result: which identifiers resolve to nothing? TS2304 / TS2552. Every other
 * diagnostic the newly-visible file produces is thrown away, because typing these files properly is
 * a separate and much larger job (see `scripts/check-ts-nocheck-baseline.mjs`).
 *
 * NO ALLOWLIST, AND THERE MUST NEVER BE ONE. It starts green on this repository with zero
 * exceptions. The compiler's own scope resolution handles for free every false positive a regex
 * would need a carve-out for: dynamic dispatch, object methods, shadowed locals, JSX component
 * names, and names declared later in the file. An exception list is how the previous convention
 * decayed; if a name genuinely does not exist, declare it — do not list it.
 *
 * IT PROVES ITSELF BEFORE IT REPORTS. Every run self-tests first, and the self-test drives THE REAL
 * `findUnresolvedNames` — the same function the check calls — against a mutated copy of a real
 * pragma'd file held in memory. A self-test that reimplemented the check would only prove the copy
 * still works. The standard, from the owner: *if a checker cannot be made to fail by breaking the
 * thing it checks, it is decoration.*
 *
 * Usage:
 *   node scripts/check-nocheck-names-resolve.mjs             # self-test, then check; exit 1 on either
 *   node scripts/check-nocheck-names-resolve.mjs --self-test # prove the detector only
 *   node scripts/check-nocheck-names-resolve.mjs --list      # report and exit 0
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { findUnresolvedNames, findNoCheckFiles, stripPragma } from './lib/nocheck-name-resolution.mjs'

const ROOT = process.cwd()
const argv = process.argv.slice(2)
const LIST_ONLY = argv.includes('--list')
const SELF_TEST_ONLY = argv.includes('--self-test')

/** The identifier from the incident. Nothing in this repository defines it, which is the point. */
const BOGUS = 'noFallbackAtAll'

/**
 * The file the gap was demonstrated in, and the one that matters: the only staff order surface.
 * If it ever comes off the pragma — which is the goal — the self-test moves to whichever pragma'd
 * file remains, and reports that it did.
 */
const PREFERRED_SUBJECT = 'components/orders-dashboard.tsx'

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/**
 * Pick a REAL call that exists in `file` and can be broken: a named import that the code actually
 * calls. Derived rather than hardcoded so the self-test cannot quietly rot into mutating a symbol
 * the file stopped using — but if nothing can be derived the self-test FAILS. "Could not check" is
 * not "checked and fine"; that distinction is the one the #331 sweep got wrong.
 */
function pickRealCall(src) {
  const code = stripComments(src)
  const imported = new Set()
  for (const m of code.matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const part of m[1].split(',')) {
      const bit = part.trim()
      if (!bit || /^type\s/.test(bit)) continue
      const local = (bit.split(/\s+as\s+/)[1] ?? bit).trim()
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(local)) imported.add(local)
    }
  }
  const called = [...imported].filter((n) => new RegExp(`(^|[^\\w.$])${n}\\s*\\(`).test(code))
  if (called.includes('startFeedFallback')) return 'startFeedFallback'
  return called.sort()[0] ?? null
}

function fail(lines) {
  console.error('')
  for (const l of lines) console.error(l)
  console.error('')
  process.exit(1)
}

/**
 * DISCOVERY MUST NOT SILENTLY SHRINK.
 *
 * Found by mutation: dropping `'components'` from `SEARCH_DIRS` left the self-test PASSING. It
 * simply moved to another pragma'd file, proved the detector on that one, and reported OK — while
 * `orders-dashboard.tsx`, the file this whole gate is about, went unexamined. A narrowing that the
 * proof cannot feel is the same decay an allowlist causes, arrived at from the other side.
 *
 * Two independent cross-checks, neither of them a list of exceptions:
 *
 *   1. `check-ts-nocheck-baseline.mjs` walks a DIFFERENT directory set for the same pragma and
 *      prints how many it found. It is maintained for its own reasons by its own CI step. If it
 *      sees more pragma'd files than this walker did, this walker is missing some.
 *   2. A direct `readFileSync` of the one path that matters. If the pragma is on disk in
 *      `orders-dashboard.tsx` and the walker did not return it, the walker is broken — no walking
 *      involved in finding that out.
 *
 * A cross-check that cannot be read is a FAILURE. "Could not check" is not "checked and fine".
 */
function crossCheckDiscovery(found) {
  // (2) first: it needs no subprocess and it is the specific file with the incident history.
  const onDisk = (() => {
    try {
      return readFileSync(join(ROOT, PREFERRED_SUBJECT), 'utf8')
    } catch {
      return null
    }
  })()
  if (onDisk !== null && /^\s*\/\/\s*@ts-nocheck\b/m.test(onDisk) && !found.includes(PREFERRED_SUBJECT)) {
    fail([
      `self-test FAILED: ${PREFERRED_SUBJECT} carries @ts-nocheck on disk and discovery did not`,
      'return it. The walker in scripts/lib/nocheck-name-resolution.mjs no longer covers it, so the',
      'check would pass having skipped the file it exists for.',
    ])
  }

  // (1) the independent walker.
  let out
  try {
    out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-ts-nocheck-baseline.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    })
  } catch (e) {
    // That script exits 1 when a NEW pragma'd file appears — its own finding, not a spawn failure.
    // Distinguish them: a spawn failure means this cross-check DID NOT RUN.
    if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) {
      fail([`self-test FAILED: could not run the cross-check (${e.code}). It was NOT performed.`])
    }
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  const m = /OK — (\d+) file\(s\) hidden from tsc/.exec(out)
  if (!m) {
    // Only tolerate the absence when that script is reporting its own failure, which its CI step
    // catches on its own. Any other unparseable output means this cross-check did not happen.
    if (!/check-ts-nocheck-baseline: FAILED/.test(out)) {
      fail([
        'self-test FAILED: could not read a file count from check-ts-nocheck-baseline.mjs, so',
        'discovery was NOT cross-checked. Its output format changed — fix the parse, do not delete',
        'the cross-check.',
        ...out.split('\n').slice(0, 6).map((l) => `    ${l}`),
      ])
    }
    return
  }
  const independent = Number(m[1])
  if (found.length < independent) {
    fail([
      `self-test FAILED: check-ts-nocheck-baseline.mjs found ${independent} pragma'd file(s); this`,
      `walker found ${found.length}. ${independent - found.length} file(s) are going unchecked.`,
      ...found.map((f) => `    seen: ${f}`),
    ])
  }
}

/* ============================================================================================
 * SELF-TEST — two-sided, against the real bogus identifier, driving the real detector.
 * ============================================================================================ */
function selfTest() {
  const nocheck = findNoCheckFiles(ROOT)

  /*
   * AN EMPTY SET IS A FAILURE, NOT A PASS.
   *
   * Two things produce it: every file got typed (the goal), or discovery broke — a renamed
   * directory, a changed SEARCH_DIRS, a pragma spelt differently. Exiting 0 on the second means
   * this gate reports OK forever having examined nothing, which is the shape it was built to stop.
   * Both readings need a human, so both stop the build once.
   */
  if (nocheck.length === 0) {
    fail([
      'self-test FAILED: no @ts-nocheck files were found.',
      '',
      'Either every file is typed now — in which case DELETE this script, its sibling',
      'check-nocheck-imports-resolve.mjs, and their CI steps, deliberately and in one commit —',
      'or discovery in scripts/lib/nocheck-name-resolution.mjs no longer matches the tree.',
      'Cross-check with: node scripts/check-ts-nocheck-baseline.mjs',
    ])
  }

  crossCheckDiscovery(nocheck)

  const subject = nocheck.includes(PREFERRED_SUBJECT) ? PREFERRED_SUBJECT : nocheck[0]
  if (subject !== PREFERRED_SUBJECT) {
    console.log(`[nocheck-names] self-test: ${PREFERRED_SUBJECT} is off the pragma — using ${subject}`)
  }

  const src = readFileSync(join(ROOT, subject), 'utf8')

  // Control 0: the in-memory strip must really remove the pragma, or the compiler skips the file
  // and BOTH sides come back clean. The first cut of this checker failed exactly here.
  const stripped = stripPragma(src)
  if (/^\s*\/\/\s*@ts-nocheck\b/m.test(stripped)) {
    fail([`self-test FAILED: stripPragma left the pragma in ${subject}.`])
  }
  if (stripped.length !== src.length) {
    fail(['self-test FAILED: stripPragma changed the file length, so reported lines would be wrong.'])
  }

  const real = pickRealCall(src)
  if (!real) {
    fail([
      `self-test FAILED: could not find a called named import in ${subject} to break.`,
      'The detector was therefore NOT PROVEN. This is a failure, not a pass.',
    ])
  }

  const mutant = src.replace(new RegExp(`(^|[^\\w.$])${real}\\s*\\(`, 'gm'), `$1${BOGUS}(`)
  if (mutant === src) fail([`self-test FAILED: the mutation did not change ${subject}.`])
  // A replacement that still contains the original token mutates nothing a matcher can see.
  if (BOGUS.includes(real)) fail([`self-test FAILED: '${BOGUS}' contains '${real}' — not a mutation.`])

  /*
   * TWO SIDES, COMPARED — not two absolute expectations.
   *
   * The obvious form ("mutated reports the bogus name, unmutated reports nothing") breaks down on
   * exactly the day this gate earns its keep: if the working tree really does contain an unresolved
   * name, the green side fails with a message blaming the detector, burying the finding. So both
   * sides are run and the DIFFERENCE is what is asserted. That holds whatever state the tree is in,
   * and the real check below then reports any genuine problem in its own words.
   */
  const red = findUnresolvedNames({ root: ROOT, overrides: { [subject]: mutant }, files: [subject] })
  const green = findUnresolvedNames({ root: ROOT, overrides: { [subject]: src }, files: [subject] })

  const bogus = (r) => r.problems.filter((p) => p.name === BOGUS).length
  const caught = bogus(red) - bogus(green)
  const collateral = red.problems.length - green.problems.length - caught

  if (caught <= 0) {
    fail([
      `self-test FAILED (red side): replaced ${real}( with ${BOGUS}( in ${subject} and the`,
      `detector reported no new '${BOGUS}' (mutated ${red.problems.length}, unmutated`,
      `${green.problems.length}).`,
      'A checker that cannot be made to fail by breaking the thing it checks is decoration.',
    ])
  }
  if (collateral !== 0) {
    fail([
      'self-test FAILED: the mutation moved problems it should not have —',
      `unmutated ${green.problems.length}, mutated ${red.problems.length}, new '${BOGUS}' ${caught},`,
      `unexplained ${collateral}. The red result is not attributable to the mutation.`,
    ])
  }

  /*
   * DISK-PATH CONTROL.
   *
   * Everything above rides the OVERRIDE path — text handed in from memory. The real check below
   * rides a different path: read the file, strip the pragma, hand that to the compiler. A break in
   * that second path would leave the self-test green while the check examined pragma'd files the
   * compiler skips entirely, reporting OK forever. That is this gate's own failure mode, so it is
   * checked directly, against the text the COMPILER USED — not a reconstruction of it.
   */
  const disk = findUnresolvedNames({ root: ROOT, files: nocheck })
  for (const rel of nocheck) {
    const used = disk.sources.get(rel)
    if (used === undefined) {
      fail([`self-test FAILED (disk path): the compiler never loaded ${rel}. It was NOT checked.`])
    }
    if (/^\s*\/\/\s*@ts-nocheck\b/m.test(used)) {
      fail([
        `self-test FAILED (disk path): the compiler was handed ${rel} with @ts-nocheck still on it,`,
        'so it skipped the file. The check would report OK having examined nothing.',
      ])
    }
  }

  console.log(
    `[nocheck-names] self-test PASSED — ${real}( -> ${BOGUS}( in ${subject} is CAUGHT ` +
      `(${caught} site(s)), nothing else moved, and all ${nocheck.length} file(s) reach the ` +
      `compiler pragma-free.`,
  )
  return { subject, mutated: real, caught }
}

/* ============================================================================================ */

selfTest()

if (SELF_TEST_ONLY) process.exit(0)

const { files, problems } = findUnresolvedNames({ root: ROOT })

console.log(`[nocheck-names] ${files.length} @ts-nocheck file(s) scanned`)
for (const f of files) console.log(`    ${f}`)

if (problems.length === 0) {
  console.log('[nocheck-names] OK — every name referenced in those files resolves')
  process.exit(0)
}

console.log('')
for (const p of problems) {
  console.log(`  ${p.file}:${p.line}:${p.column}`)
  console.log(`      ${p.message}`)
}

if (LIST_ONLY) process.exit(0)

fail([
  `${problems.length} unresolved name(s) in @ts-nocheck files.`,
  '',
  'These are references to things that do not exist. tsc cannot see them because of the pragma,',
  'and jest turns them into `undefined` rather than throwing — so the first detector is the screen',
  'going blank in front of a venue. Define the name, import it, or delete the call.',
])
