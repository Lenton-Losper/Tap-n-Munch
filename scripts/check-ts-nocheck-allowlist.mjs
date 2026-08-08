#!/usr/bin/env node
/**
 * Issue #172 — ratchet the production deploy gate against NEW `@ts-nocheck` files.
 *
 * #141 added `npx tsc --noEmit` to the production deploy. 14 files in the gated directories
 * carry `@ts-nocheck`, so the typecheck cannot see them — including two payment routes. This
 * does NOT clear those 14 (that needs design and is tracked separately); it freezes them in
 * `.github/ts-nocheck-allowlist.txt` so the count can only go down.
 *
 * Three failure modes, all fatal:
 *   1. NEW      — a `@ts-nocheck` file that is not on the allowlist. The ratchet's whole point.
 *   2. GONE     — an allowlisted path that no longer exists on disk. Without this the list rots
 *                 into a lie: deleted/renamed entries would sit there forever implying coverage
 *                 gaps that are not real, and nobody would trust the count.
 *   3. CLEARED  — an allowlisted path that still exists but no longer has the pragma. Good news,
 *                 but the line must be deleted in the same commit or the list overstates the
 *                 remaining work.
 *
 * Zero dependencies on purpose: the gate runs this BEFORE `npm ci`, mirroring the conflict-marker
 * scan added for #142. node_modules genuinely contains `@ts-nocheck` files, so a scan that ran
 * after install and forgot to exclude it would drown in false positives. Scanning only the four
 * gated directories is the second line of defence against the same thing.
 *
 * Usage:
 *   node scripts/check-ts-nocheck-allowlist.mjs [--root <dir>] [--allowlist <file>]
 *
 * `--root` exists so the test suite can point the real checker at synthetic fixture trees and
 * prove it discriminates. A checker that has only ever been run against a passing tree has not
 * been tested, it has been confirmed.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const PRAGMA = '@ts-nocheck'
/** Kept in step with the directories the gate's `tsc --noEmit` and the #142 scan cover. */
const GATED_DIRS = ['app', 'lib', 'components', 'workers']
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
/** Belt and braces: the scan is already scoped to GATED_DIRS, which sit above node_modules. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out'])

function parseArgs(argv) {
  const args = { root: process.cwd(), allowlist: null }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = argv[++i]
    else if (argv[i] === '--allowlist') args.allowlist = argv[++i]
  }
  if (!args.allowlist) args.allowlist = join(args.root, '.github', 'ts-nocheck-allowlist.txt')
  return args
}

/** Repo-relative, forward-slashed, so the output is identical on Windows and on the runner. */
function toPosix(p) {
  return p.split(sep).join('/')
}

function readAllowlist(file) {
  if (!existsSync(file)) {
    console.error(`ERROR: allowlist not found at ${toPosix(file)}`)
    process.exit(1)
  }
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

function scan(root) {
  const found = []
  for (const dir of GATED_DIRS) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    walk(abs, root, found)
  }
  return found.sort()
}

function walk(dir, root, found) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    const st = statSync(abs)
    if (st.isDirectory()) {
      walk(abs, root, found)
      continue
    }
    if (!EXTENSIONS.some((e) => entry.endsWith(e))) continue
    if (readFileSync(abs, 'utf8').includes(PRAGMA)) found.push(toPosix(relative(root, abs)))
  }
}

function main() {
  const { root, allowlist: allowlistPath } = parseArgs(process.argv.slice(2))
  const allowed = readAllowlist(allowlistPath)
  const actual = scan(root)

  const allowedSet = new Set(allowed)
  const actualSet = new Set(actual)

  const added = actual.filter((p) => !allowedSet.has(p))
  const gone = allowed.filter((p) => !actualSet.has(p) && !existsSync(join(root, p)))
  const cleared = allowed.filter((p) => !actualSet.has(p) && existsSync(join(root, p)))

  console.log(`@ts-nocheck ratchet: ${allowed.length} allowlisted, ${actual.length} found in ${GATED_DIRS.join('/ ')}/`)

  let failed = false

  if (added.length > 0) {
    failed = true
    console.error(`\nERROR: ${added.length} NEW ${PRAGMA} file(s) not on the allowlist:`)
    for (const p of added) console.error(`  + ${p}`)
    console.error(
      `\n${PRAGMA} hides the whole file from the deploy gate's typecheck — the exact defect class` +
        `\n(#141, a TS2339) the gate was built to catch. Do not add it to the allowlist: that list only` +
        `\nshrinks. Use @ts-expect-error on the specific lines instead.`,
    )
  }

  if (gone.length > 0) {
    failed = true
    console.error(`\nERROR: ${gone.length} allowlisted path(s) no longer exist:`)
    for (const p of gone) console.error(`  - ${p}`)
    console.error('\nDelete these lines from the allowlist. A list naming files that are gone is a lie.')
  }

  if (cleared.length > 0) {
    failed = true
    console.error(`\nERROR: ${cleared.length} allowlisted file(s) no longer carry ${PRAGMA}:`)
    for (const p of cleared) console.error(`  - ${p}`)
    console.error('\nGood — now delete these lines from the allowlist so the count stays honest.')
  }

  if (failed) process.exit(1)
  console.log(`No new ${PRAGMA}. Allowlist matches the tree exactly.`)
}

main()
