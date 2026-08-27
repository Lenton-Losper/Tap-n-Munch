/**
 * NAME RESOLUTION FOR `@ts-nocheck` FILES — the half `check-nocheck-imports-resolve.mjs` cannot see.
 *
 * WHY THIS EXISTS. On 2026-08-26, mutation-testing #350, a real call in
 * `components/orders-dashboard.tsx`
 *
 *     startFeedFallback({ ... })   ->   noFallbackAtAll({ ... })
 *
 * left every gate GREEN:
 *
 *   tsc                             the file carries `@ts-nocheck`; the compiler skips it entirely
 *   check-nocheck-imports-resolve   `noFallbackAtAll` is not an IMPORT, so an import checker is blind
 *   jest                            a name that resolves to nothing is `undefined`, not a throw, and
 *                                   no suite mounts this component
 *
 * Only a hand-written source-wiring assertion caught it. That is the same shape as the outage that
 * blanked the production dashboard that morning: a missing binding in this exact file, invisible to
 * every automated gate, found by the page dying in front of a venue.
 *
 * WHAT IT DOES. It removes the `@ts-nocheck` pragma IN MEMORY and asks the real TypeScript compiler
 * one question about the result: which identifiers resolve to nothing? That is diagnostic TS2304
 * ("Cannot find name 'x'") and its spelling-suggestion variant TS2552. Every other diagnostic the
 * now-visible file produces is discarded.
 *
 * WHY THE COMPILER AND NOT A REGEX. The false positives a hand-rolled matcher has to dodge are
 * exactly the things a scope resolver exists to get right:
 *
 *   dynamic dispatch          `handlers[kind](x)`      — not an identifier call at all
 *   object methods            `supabase.from(...)`     — a property, resolved on its object's type
 *   locally shadowed names    a param named `status`   — the inner binding wins
 *   JSX component names       `<FeedConnectionIndicator />` — resolved as a value reference
 *   hoisting                  `foo()` above `function foo` — legal, and TS knows it
 *
 * A regex needs a carve-out list for each of those, and a carve-out list is how the previous
 * convention decayed. The compiler needs none: it starts green on this repository with no
 * exceptions of any kind. THERE IS NO ALLOWLIST IN THIS FILE, AND THERE MUST NOT BE ONE. If a name
 * legitimately does not exist, the answer is to declare it, not to list it here.
 *
 * DELIBERATELY NARROW. This is not "typecheck the nocheck files" — that is Part 2's work and it is
 * a large job. Filtering to TS2304/TS2552 buys the ONE guarantee the pragma took away that no other
 * gate replaces: every name you reference is a name that exists.
 *
 * This module is pure: no CLI, no `process.exit`, no main-module guard (see
 * `.mjs main-module guard false green` — the Windows `file://` comparison silently never matches,
 * so a guarded script "passes" having run nothing). The CLI lives in
 * `scripts/check-nocheck-names-resolve.mjs` and drives the function below. So does its self-test.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** Directories a `@ts-nocheck` file could live in. Same set the sibling import checker walks. */
const SEARCH_DIRS = ['app', 'components', 'lib', 'hooks', 'contexts']
const SKIP = new Set(['node_modules', '.next', '__tests__', 'tests', '__mocks__'])
const EXTS = ['.ts', '.tsx']

/** "Cannot find name 'x'." and "Cannot find name 'x'. Did you mean 'y'?" — the whole subject. */
export const UNRESOLVED_NAME_CODES = new Set([2304, 2552])

/** The real pragma, as TypeScript honours it — not the bare word in prose. */
const PRAGMA = /^([ \t]*)(\/\/[ \t]*@ts-nocheck\b[^\n]*)$/m

function toPosix(p) {
  return p.split(sep).join('/')
}

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

/** Every file under the search dirs that carries the pragma, as repo-relative posix paths. */
export function findNoCheckFiles(root = process.cwd()) {
  const found = []
  for (const d of SEARCH_DIRS) {
    for (const full of walk(join(root, d))) {
      const src = readFileSync(full, 'utf8')
      if (PRAGMA.test(src)) found.push(toPosix(relative(root, full)))
    }
  }
  return found.sort()
}

/**
 * Blank the pragma while keeping every byte position identical, so reported line/column numbers
 * match the file on disk. `// @ts-nocheck` becomes a comment of the same length that means nothing.
 */
export function stripPragma(src) {
  return src.replace(PRAGMA, (_m, indent, body) => indent + '//' + ' '.repeat(body.length - 2))
}

function loadCompilerOptions(ts, root) {
  const configPath = join(root, 'tsconfig.json')
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath)
  return { options: { ...parsed.options, noEmit: true, incremental: false }, fileNames: parsed.fileNames }
}

/**
 * Ask the compiler which names in the `@ts-nocheck` files resolve to nothing.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.root]      repository root (default `process.cwd()`)
 * @param {Map<string,string>|object} [opts.overrides]
 *        repo-relative posix path -> source text to use INSTEAD of what is on disk. This is how the
 *        self-test drives this function: it hands in a mutated copy of a real file without writing
 *        to the working tree. Overridden files are checked whether or not they carry the pragma.
 * @param {string[]} [opts.files]    restrict the scan to these repo-relative posix paths
 * @returns {{
 *   files: string[],
 *   problems: Array<{file:string,name:string,line:number,column:number,message:string,code:number}>,
 *   sources: Map<string,string>  the text the compiler actually checked, per target
 * }}
 */
export function findUnresolvedNames(opts = {}) {
  const root = opts.root ?? process.cwd()
  const ts = require(join(root, 'node_modules', 'typescript'))

  const overrides = new Map(
    opts.overrides instanceof Map ? opts.overrides : Object.entries(opts.overrides ?? {}),
  )

  const targets = new Set(opts.files ?? findNoCheckFiles(root))
  for (const key of overrides.keys()) targets.add(key)

  const { options, fileNames } = loadCompilerOptions(ts, root)

  /**
   * Root the program at the target files plus every ambient declaration the tsconfig pulls in
   * (`next-env.d.ts`, `.next/types`, any `*.d.ts` in the project). Without those, globals that are
   * genuinely declared would look unresolved — a false positive of exactly the kind this must not
   * produce. Everything else arrives through imports, which is why this is seconds rather than the
   * ~40s a whole-repo `tsc --noEmit` costs.
   */
  const roots = [
    ...[...targets].map((f) => join(root, f)),
    ...fileNames.filter((f) => f.endsWith('.d.ts')),
  ]

  /**
   * Absolute path (as TS spells it) -> text. An override is pragma-stripped like any other target:
   * forgetting this is how the first cut of this checker came back GREEN on the real
   * `noFallbackAtAll` mutation — the substituted text still carried `@ts-nocheck`, so the compiler
   * dutifully skipped the very file the self-test had just broken.
   */
  const source = new Map()
  for (const [rel, text] of overrides) source.set(toPosix(join(root, rel)), stripPragma(text))

  const host = ts.createCompilerHost(options, true)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  const originalReadFile = host.readFile.bind(host)

  function textFor(fileName) {
    const key = toPosix(fileName)
    if (source.has(key)) return source.get(key)
    const rel = toPosix(relative(root, fileName))
    if (targets.has(rel)) {
      const onDisk = originalReadFile(fileName)
      return onDisk === undefined ? undefined : stripPragma(onDisk)
    }
    return undefined
  }

  host.readFile = (fileName) => textFor(fileName) ?? originalReadFile(fileName)
  host.fileExists = (fileName) => source.has(toPosix(fileName)) || existsSync(fileName)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const text = textFor(fileName)
    if (text === undefined) return originalGetSourceFile(fileName, languageVersion, onError, shouldCreate)
    return ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.Unknown)
  }

  const program = ts.createProgram(roots, options, host)

  const problems = []
  /**
   * The text the COMPILER ACTUALLY USED for each target, straight off the SourceFile it checked.
   * Not a reconstruction — the end of the chain. The self-test asserts the pragma is absent from
   * this, which is the only way to prove the strip survived every host hook it had to pass through
   * (`readFile`, `getSourceFile`, and TypeScript's own caching between them).
   */
  const sources = new Map()
  for (const rel of [...targets].sort()) {
    const sf = program.getSourceFile(join(root, rel))
    if (sf) sources.set(rel, sf.getFullText())
    if (!sf) {
      problems.push({
        file: rel,
        name: '(file)',
        line: 0,
        column: 0,
        code: 0,
        message: 'the checker could not load this file — treat as NOT CHECKED, not as clean',
      })
      continue
    }
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (!UNRESOLVED_NAME_CODES.has(d.code)) continue
      const message = ts.flattenDiagnosticMessageText(d.messageText, ' ')
      const { line, character } = sf.getLineAndCharacterOfPosition(d.start ?? 0)
      problems.push({
        file: rel,
        name: /Cannot find name '([^']+)'/.exec(message)?.[1] ?? '?',
        line: line + 1,
        column: character + 1,
        code: d.code,
        message,
      })
    }
  }

  return { files: [...targets].sort(), problems, sources }
}

export { dirname }
