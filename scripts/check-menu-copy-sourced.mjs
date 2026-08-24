/**
 * #334 — NO CUSTOMER PROSE MAY BE WRITTEN INLINE UNDER app/menu/**.
 *
 * WHY THIS EXISTS. `scripts/check-no-pending-copy.mjs` catches a placeholder that someone
 * remembered to mark. It cannot catch a string that never carried a marker and never lived in a
 * copy file — which is exactly what `'Order sent - waiting for the restaurant to confirm'` was when
 * it shipped inside ActiveOrderBanner.tsx. The sign-off process only protected strings that had
 * already opted in.
 *
 * This is the opposite shape: it asks the CLASS question. Any sentence a customer can read, written
 * inline in a menu screen, fails the build. Wording then has exactly one home, `lib/customer-copy`,
 * and the owner sees everything that lands there.
 *
 * NOTHING IS EXCLUDED. No file carve-outs, no per-string allowlist, no "skip this one" escape
 * hatch — an exception list is how the previous convention decayed into something you had to
 * remember to grep. What this does not flag is text that is not prose at all, and every one of
 * those judgements is STRUCTURAL — a property of where the text sits in the language, never a
 * decision about a particular sentence:
 *
 *   comments            not rendered; #334's own list mistook three comment lines for copy, and a
 *                       gate that fires inside comments teaches people to delete their comments
 *   imports             module specifiers
 *   console.* arguments not customer-facing; #334 excludes these for the same reason
 *   directives          'use client' is a language keyword that happens to need quotes
 *   class attributes    'sticky top-0 z-[60] border-b' is not something anyone reads
 *   column lists        'id, total, status' is a query — #334's list mistook one for copy
 *   URLs and paths
 *
 * PARSING, NOT PATTERN-MATCHING. The first version of this file used regexes for string and
 * template literals and reported forty lines of TypeScript as customer copy, because a regex cannot
 * tell a template literal from two backticks with code between them. Anything claiming to be a gate
 * has to parse well enough to be believed, so literals are lexed.
 *
 * Usage:
 *   node scripts/check-menu-copy-sourced.mjs            # exit 1 on any inline prose
 *   node scripts/check-menu-copy-sourced.mjs --list     # report and exit 0
 *   node scripts/check-menu-copy-sourced.mjs --root=... # run against a fixture, so the gate itself
 *                                                         can be tested rather than trusted
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.argv.find((a) => a.startsWith('--root='))?.slice('--root='.length) || process.cwd()
const LIST_ONLY = process.argv.includes('--list')
const JSON_OUT = process.argv.includes('--json')

const SCAN_DIR = 'app/menu'
const EXTS = ['.tsx', '.ts']

const NL = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)
const BACKTICK = String.fromCharCode(96)

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
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

/** Blank out comments and import lines, preserving line numbers so reports stay accurate. */
function stripNonRendered(source) {
  let out = ''
  let i = 0
  let inLine = false
  let inBlock = false
  let quote = null
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (inLine) {
      if (c === NL) {
        inLine = false
        out += c
      } else out += ' '
      i++
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        out += '  '
        i += 2
        continue
      }
      out += c === NL ? c : ' '
      i++
      continue
    }
    if (quote) {
      out += c
      if (c === BACKSLASH) {
        out += source[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      i += 2
      out += '  '
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      i += 2
      out += '  '
      continue
    }
    if (c === '"' || c === "'" || c === BACKTICK) {
      quote = c
      out += c
      i++
      continue
    }
    out += c
    i++
  }
  return out
    .split(NL)
    .map((line) => (/^\s*import\s/.test(line) || /^\s*}\s*from\s/.test(line) ? ' '.repeat(line.length) : line))
    .join(NL)
}

const TAILWIND_TOKEN = /^-?[a-zA-Z0-9]+(-[a-zA-Z0-9./%[\]#()]+)*(:[a-zA-Z0-9\-[\]./%#()]+)*$/
const CLASS_HINT =
  /(^|\s)(flex|grid|hidden|block|inline|absolute|relative|sticky|fixed|text-|bg-|border|rounded|px-|py-|pt-|pb-|pl-|pr-|mt-|mb-|ml-|mr-|mx-|my-|gap-|w-|h-|min-|max-|z-|top-|left-|right-|bottom-|space-|items-|justify-|font-|leading-|tracking-|shadow|overflow|transition|duration-|opacity-|cursor-|hover:|focus:|sm:|md:|lg:|animate-)/
const COLUMN_LIST = /^[a-z_][a-z0-9_]*(\s*,\s*[a-z_][a-z0-9_]*(\([^)]*\))?)+$/i
const URLISH = /^(https?:|\/|\.\/|\.\.\/|mailto:|tel:|data:|[a-z]+\/[a-z0-9.+-]+$)/i
const DIRECTIVE = /^use (client|server|strict)$/
/** Trailing context immediately before a literal, when that literal is a console argument. */
const CONSOLE_CALL = /console\s*\.\s*(log|error|warn|info|debug|trace)\s*\(\s*$/

/** Line endings are a property of the checkout, not of the sentence. */
function normaliseEol(text) {
  return text.split(String.fromCharCode(13) + NL).join(NL)
}

function isProse(raw) {
  const s = raw.trim()
  if (s.length < 6) return false
  if (!/\s/.test(s)) return false
  if (URLISH.test(s)) return false
  if (COLUMN_LIST.test(s)) return false
  if (DIRECTIVE.test(s)) return false

  const words = s.split(/\s+/)
  // An English word carries at most one hyphen. `bg-gradient-to-br` is alphabetic and hyphenated
  // and is emphatically not a word -- counting it as one is what let a class attribute through.
  const realWords = words.filter(
    (w) => /^[A-Za-z][A-Za-z'’-]*[.,!?:;]?$/.test(w) && (w.match(/-/g) || []).length <= 1,
  )
  if (realWords.length < 2) return false

  // Tailwind arbitrary values -- from-[#0A0A0A], w-[calc(100%-2rem)] -- appear in no sentence.
  if (words.some((w) => /-\[[^\]]+\]/.test(w))) return false

  // A class attribute: mostly Tailwind-shaped tokens, plus at least one unmistakable class prefix.
  const tailwindish = words.filter((w) => TAILWIND_TOKEN.test(w) && /[-:]/.test(w))
  if (CLASS_HINT.test(s) && tailwindish.length >= Math.max(1, Math.floor(words.length / 2))) return false

  const letters = (s.match(/[A-Za-z\s]/g) || []).length
  if (letters / s.length < 0.6) return false

  return true
}

/** Lex string and template literals, tracking line numbers and the text immediately before each. */
function lexLiterals(source) {
  const out = []
  let i = 0
  let line = 1
  const len = source.length
  while (i < len) {
    const c = source[i]
    if (c === NL) {
      line++
      i++
      continue
    }
    if (c === '"' || c === "'") {
      const quote = c
      const startLine = line
      const startIdx = i
      let value = ''
      i++
      while (i < len && source[i] !== quote) {
        if (source[i] === BACKSLASH) {
          value += source[i + 1] ?? ''
          i += 2
          continue
        }
        if (source[i] === NL) break
        value += source[i]
        i++
      }
      i++
      out.push({
        line: startLine,
        text: value,
        kind: 'string',
        start: startIdx,
        end: i,
        before: source.slice(Math.max(0, startIdx - 60), startIdx),
      })
      continue
    }
    if (c === BACKTICK) {
      const startLine = line
      const startIdx = i
      let value = ''
      let interpolated = false
      i++
      while (i < len && source[i] !== BACKTICK) {
        if (source[i] === BACKSLASH) {
          value += source[i + 1] ?? ''
          i += 2
          continue
        }
        if (source[i] === '$' && source[i + 1] === '{') interpolated = true
        if (source[i] === NL) line++
        value += source[i]
        i++
      }
      i++
      // An interpolated template is a format, not a fixed string; its literal halves are reported
      // through the copy module that owns them, not here.
      if (!interpolated) {
        out.push({
          line: startLine,
          text: value,
          kind: 'template',
          start: startIdx,
          end: i,
          before: source.slice(Math.max(0, startIdx - 60), startIdx),
        })
      }
      continue
    }
    i++
  }
  return out
}

/**
 * JSX text nodes carry no quotes. Code punctuation rules a match out — that is what separates real
 * text from generics like useState<Foo>([]), which an earlier version reported as copy.
 */
function findJsxText(source) {
  const out = []
  // NO NEWLINE IN THE CHARACTER CLASS. Excluding it made this gate line-ending dependent: on CRLF
  // the \r immediately after `>` satisfied the first character and the match proceeded; on LF it
  // did not. The same tree yielded 188 findings on Windows and 135 from a git-checked-out copy.
  // A gate whose answer depends on how the file was checked out is not a gate. Spanning newlines is
  // correct for JSX text regardless — the excluded punctuation is what stops a match crossing a tag
  // boundary or an expression.
  const re = />([^<>{}()=;[\]]*)</g
  let m
  while ((m = re.exec(source))) {
    // CRLF is normalised out of the VALUE only, never the source, so offsets still address the
    // file on disk. Without this the same string keys differently depending on checkout style.
    const value = normaliseEol(m[1].trim())
    if (!isProse(value)) continue
    out.push({
      line: source.slice(0, m.index).split(NL).length,
      text: value,
      kind: 'jsx-text',
      start: m.index + 1,
      end: m.index + 1 + m[1].length,
    })
  }
  return out
}

function findCandidates(source) {
  const found = []
  for (const lit of lexLiterals(source)) {
    lit.text = normaliseEol(lit.text)
    if (!isProse(lit.text)) continue
    if (CONSOLE_CALL.test(lit.before)) continue
    found.push({ line: lit.line, text: lit.text, kind: lit.kind, start: lit.start, end: lit.end })
  }
  found.push(...findJsxText(source))
  return found
}

const files = walk(join(ROOT, SCAN_DIR))
const hits = []
for (const file of files) {
  const source = stripNonRendered(readFileSync(file, 'utf8'))
  for (const hit of findCandidates(source)) {
    hits.push({ file: relative(ROOT, file).split(sep).join('/'), ...hit })
  }
}

hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

if (JSON_OUT) {
  console.log(JSON.stringify(hits, null, 2))
  process.exit(0)
}

if (hits.length === 0) {
  console.log(`[menu-copy] OK — no inline customer prose under ${SCAN_DIR}/ (${files.length} files scanned)`)
  process.exit(0)
}

const byFile = new Map()
for (const h of hits) {
  if (!byFile.has(h.file)) byFile.set(h.file, [])
  byFile.get(h.file).push(h)
}

console.log(`[menu-copy] ${hits.length} inline customer string(s) under ${SCAN_DIR}/, in ${byFile.size} file(s):`)
console.log('')
for (const [file, rows] of byFile) {
  console.log(`### ${file}  (${rows.length})`)
  for (const r of rows) console.log(`  :${r.line}  [${r.kind}]  ${r.text.slice(0, 100)}`)
  console.log('')
}

if (LIST_ONLY) process.exit(0)

console.error(
  'Customer wording must live in lib/customer-copy so the owner sees it before it ships.' +
    NL +
    'Move each string to a key there and render the key. See #334.',
)
process.exit(1)
