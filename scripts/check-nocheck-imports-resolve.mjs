/**
 * EVERY NAMED IMPORT IN A `@ts-nocheck` FILE MUST ACTUALLY EXIST.
 *
 * WHY THIS EXISTS. `components/ActiveOrderBanner.tsx` imported and CALLED `orderPlacedAtMs` from
 * `lib/orders/active-order-visibility` for ten hours. That function was never written. Three layers
 * missed it:
 *
 *   tsc      the file carries `@ts-nocheck`, so the compiler never looked at it
 *   jest     a missing named import transpiles to `undefined` rather than throwing at require
 *            time, and no test exercised the branch that called it -- 211 suites stayed green
 *   review   the import sat on its own line, away from the grouped import above it
 *
 * Only the Next bundler resolves named exports statically, so the BUILD was the sole detector, and
 * it failed every staging deploy from 11:59 onward while the cause looked like something else.
 *
 * A `@ts-nocheck` file has opted out of the one tool that would normally catch this. This is the
 * replacement for that specific guarantee -- deliberately narrow: it does not type-check anything,
 * it only asks whether each named import EXISTS in the module it names.
 *
 * Scoped to `@ts-nocheck` files ON PURPOSE. Everywhere else tsc already does this, and duplicating
 * it would be a second thing to maintain that answers a question already answered.
 *
 * Usage:
 *   node scripts/check-nocheck-imports-resolve.mjs          # exit 1 on an unresolved import
 *   node scripts/check-nocheck-imports-resolve.mjs --list   # report and exit 0
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const LIST_ONLY = process.argv.includes('--list')
const SEARCH_DIRS = ['app', 'components', 'lib', 'hooks', 'contexts', 'workers']
const SKIP = new Set(['node_modules', '.next', '__tests__', 'tests', '__mocks__'])
const EXTS = ['.ts', '.tsx']

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else if (EXTS.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

/** Resolve `@/lib/x` to a file on disk, trying the extensions and index files Next would. */
function resolveLocal(spec) {
  if (!spec.startsWith('@/')) return null
  const base = join(ROOT, spec.slice(2))
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(c)) return c
  }
  return null
}

/**
 * What a module exports, by name. Crude on purpose -- a parser would be more precise and would also
 * be a second thing to maintain, and the failure mode of a crude matcher here is a false POSITIVE
 * that someone reads, not a missed import.
 */
function exportedNames(file) {
  const src = readFileSync(file, 'utf8')
  const names = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) {
    names.add(m[1])
  }
  for (const m of src.matchAll(/^export\s+(?:type|interface|enum)\s+([A-Za-z0-9_$]+)/gm)) names.add(m[1])
  // export { a, b as c }
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const bit = part.trim()
      if (!bit) continue
      const as = bit.split(/\s+as\s+/)
      names.add((as[1] ?? as[0]).trim())
    }
  }
  // A re-export means we cannot know locally; treat the module as opaque rather than guess.
  const hasStarReexport = /^export\s+\*\s+from/m.test(src)
  return { names, opaque: hasStarReexport }
}

const files = SEARCH_DIRS.flatMap((d) => walk(join(ROOT, d)))
const nocheck = files.filter((f) => /^\s*\/\/\s*@ts-nocheck/m.test(readFileSync(f, 'utf8').slice(0, 400)))

const problems = []
for (const file of nocheck) {
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const spec = m[2]
    const target = resolveLocal(spec)
    if (!target) continue
    const { names, opaque } = exportedNames(target)
    if (opaque) continue
    for (const part of m[1].split(',')) {
      const bit = part.trim()
      if (!bit) continue
      const imported = bit.split(/\s+as\s+/)[0].trim().replace(/^type\s+/, '')
      if (!imported) continue
      if (!names.has(imported)) {
        problems.push({
          file: relative(ROOT, file).split(sep).join('/'),
          spec,
          imported,
          target: relative(ROOT, target).split(sep).join('/'),
        })
      }
    }
  }
}

console.log(`[nocheck-imports] ${nocheck.length} @ts-nocheck file(s) scanned`)
for (const f of nocheck) console.log(`    ${relative(ROOT, f).split(sep).join('/')}`)

if (problems.length === 0) {
  console.log('[nocheck-imports] OK — every named import resolves')
  process.exit(0)
}

console.log('')
for (const p of problems) {
  console.log(`  ${p.file}`)
  console.log(`      imports { ${p.imported} } from '${p.spec}'`)
  console.log(`      but ${p.target} does not export it`)
}

if (LIST_ONLY) process.exit(0)
console.error(
  `\n${problems.length} unresolved import(s) in @ts-nocheck files. tsc cannot see these; only the` +
    `\nbundler can, and by then it is a failed deploy.`,
)
process.exit(1)
