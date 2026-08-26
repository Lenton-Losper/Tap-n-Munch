/**
 * EVERY IDENTIFIER USED IN A `@ts-nocheck` FILE MUST BE DECLARED, IMPORTED, OR A KNOWN GLOBAL.
 *
 * ============================================================================================
 * THE OUTAGE THIS EXISTS BECAUSE OF
 * ============================================================================================
 *
 * 2026-08-26, production. `flashtap.app/dashboard` served "Application error: a client-side
 * exception has occurred" to staff mid-service. The cause was one line that did not exist:
 * `components/orders-dashboard.tsx` used `STRANDED_CLAIM_COPY` three times and imported it nowhere.
 *
 * It shipped in 9a2c3165 on 2026-08-25 and rode SIX production deploys before anyone noticed,
 * because every gate had a reason not to look:
 *
 *   tsc                            the file is `@ts-nocheck`. Skipped entirely.
 *   eslint                         `no-undef` is off for TS files — the shared config assumes
 *                                  TypeScript owns undefined identifiers. Here TypeScript opted out,
 *                                  so nobody owned it.
 *   check-nocheck-imports-resolve  verifies that named imports RESOLVE. There was NO import
 *                                  statement, so it had nothing to inspect. It checks imports, not
 *                                  usages — a missing import is the one shape it cannot see.
 *   unit / E2E / staging gate      none of them render a staff surface behind auth.
 *
 * Each layer was individually reasonable. The file sat in the gap between them.
 *
 * ============================================================================================
 * WHY `no-undef` RATHER THAN A HAND-ROLLED SCAN
 * ============================================================================================
 *
 * "Is this identifier bound?" is a scope question, and scope has genuinely hard corners: closures,
 * hoisting, destructuring patterns, catch parameters, JSX pragma, type-only positions, shadowing.
 * A regex sweep gets those wrong in BOTH directions — and a checker with false positives is one
 * people learn to ignore, which is worse than no checker.
 *
 * eslint already has a correct scope analyser. This runs it with exactly one rule enabled, on
 * exactly the files tsc refuses to look at, with the TS parser so JSX and type annotations parse.
 * Nothing else about the repo's lint setup is changed or re-litigated.
 *
 * TYPE-ONLY IDENTIFIERS are not runtime references, so `no-undef` is scoped to value positions by
 * the TS parser's scope manager. A type used but not imported is a tsc problem and these files have
 * opted out of tsc — out of scope here deliberately, and stated rather than silently ignored.
 */
import { ESLint } from 'eslint'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (['node_modules', '.next', '.git', '.open-next', '.wrangler', 'out', 'build'].includes(name)) return []
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const files = walk(ROOT)
  .filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f))
  .filter((f) => {
    const head = readFileSync(f, 'utf8').slice(0, 400)
    return /@ts-nocheck/.test(head)
  })

if (files.length === 0) {
  console.log('[nocheck-undef] no @ts-nocheck files found — nothing to check')
  process.exit(0)
}

/*
 * The browser + node + jest globals a file in this repo may legitimately reach for without an
 * import. Kept explicit rather than pulled from a preset so that adding one is a visible decision:
 * every name here is a thing this checker will stop protecting.
 */
const GLOBALS = {}
for (const g of [
  // JS builtins the parser does not supply on its own
  'globalThis', 'console', 'process', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'AbortController', 'AbortSignal', 'fetch', 'Request', 'Response', 'Headers',
  'FormData', 'Blob', 'File', 'crypto', 'structuredClone', 'queueMicrotask',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  // DOM
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'alert', 'confirm', 'prompt', 'Image', 'Audio', 'Event', 'CustomEvent', 'MouseEvent',
  'KeyboardEvent', 'HTMLElement', 'HTMLInputElement', 'HTMLDivElement', 'Element', 'Node',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getComputedStyle', 'matchMedia', 'DOMParser', 'WebSocket', 'Worker',
  'performance', 'screen', 'CSS', 'FileReader', 'ClipboardItem',
  // node/CJS
  '__dirname', '__filename', 'module', 'require', 'exports',
  // test
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'jest',
  // React JSX runtime
  'React', 'JSX',
]) GLOBALS[g] = 'readonly'

const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.{ts,tsx,js,jsx,mjs}'],
      languageOptions: {
        parser: await import('@typescript-eslint/parser'),
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ecmaFeatures: { jsx: true },
        },
        globals: GLOBALS,
      },
      linterOptions: { reportUnusedDisableDirectives: false },
      rules: { 'no-undef': 'error' },
    },
  ],
})

const results = await eslint.lintFiles(files)

const findings = []
for (const r of results) {
  for (const m of r.messages) {
    if (m.ruleId !== 'no-undef') continue
    findings.push({
      file: relative(ROOT, r.filePath).replace(/\\/g, '/'),
      line: m.line,
      message: m.message,
    })
  }
}

console.log(`[nocheck-undef] ${files.length} @ts-nocheck file(s) scanned:`)
for (const f of files) console.log(`    ${relative(ROOT, f).replace(/\\/g, '/')}`)

if (findings.length === 0) {
  console.log(`\n[nocheck-undef] OK — every identifier used is declared, imported, or a known global.`)
  process.exit(0)
}

console.log(`\n[nocheck-undef] ${findings.length} UNDEFINED IDENTIFIER(S):\n`)
const byFile = new Map()
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, [])
  byFile.get(f.file).push(f)
}
for (const [file, list] of byFile) {
  console.log(`  ${file}`)
  for (const f of list) console.log(`    :${f.line}  ${f.message}`)
}
console.log(
  '\nThese files are invisible to tsc. An identifier that is used and never bound is a\n' +
    'ReferenceError at runtime — it took the staff dashboard down on 2026-08-26 and rode six\n' +
    'production deploys first. Import it, declare it, or add it to GLOBALS in this script if it\n' +
    'genuinely is one.',
)
process.exit(1)
